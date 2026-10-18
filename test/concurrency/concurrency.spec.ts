import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { OpenWalletUseCase } from "@application/use-cases/open-wallet.use-case.ts";
import { ProcessWagerTransactionUseCase } from "@application/use-cases/process-wager-transaction.use-case.ts";
import { ReconcileWalletUseCase } from "@application/use-cases/reconcile-wallet.use-case.ts";
import { FailureCode } from "@domain/shared/domain-errors.ts";
import { WagerTransactionKind, WagerTransactionStatus } from "@domain/wagering/wager-transaction.ts";
import { OutboxPublisherWorker } from "@infrastructure/messaging/outbox-publisher.worker.ts";
import { buildMikroOrmOptions } from "@infrastructure/persistence/mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "@infrastructure/persistence/repositories/mikro-orm-unit-of-work.ts";

describe("Real Concurrency & Race Condition Tests (PostgreSQL)", () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;

  let openWalletUseCase: OpenWalletUseCase;
  let processWagerTxUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let outboxPublisher: OutboxPublisherWorker;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    orm = await MikroORM.init(buildMikroOrmOptions());
    uow = new MikroOrmUnitOfWork(orm.em);

    openWalletUseCase = new OpenWalletUseCase(uow);
    processWagerTxUseCase = new ProcessWagerTransactionUseCase(uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(uow);
    outboxPublisher = new OutboxPublisherWorker(uow);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  beforeEach(async () => {
    const conn = orm.em.getConnection();
    await conn.execute(`
      TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE;
    `);
  });

  it("1. Same bet sent 50 times in parallel results in exactly ONE debit and 49 idempotent replays", async () => {
    const wallet = await openWalletUseCase.execute({
      playerId: "player-concurrency-50",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const command = {
      providerId: "prv-stress",
      externalTransactionId: "bet-stress-50",
      idempotencyKey: "prv-stress:bet-stress-50",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-stress-50",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    };

    // Dispara 50 chamadas estritamente simultâneas
    const promises = Array.from({ length: 50 }, (_, i) =>
      processWagerTxUseCase.execute(command, { correlationId: `corr-50-${i}` }),
    );

    const results = await Promise.all(promises);

    // Contagem de execuções originais vs replays
    const firstExecutions = results.filter((r) => !r.idempotentReplay && r.status === WagerTransactionStatus.Processed);
    const idempotentReplays = results.filter((r) => r.idempotentReplay && r.status === WagerTransactionStatus.Processed);

    expect(firstExecutions.length).toBe(1);
    expect(idempotentReplays.length).toBe(49);

    // Saldo final deve ser exatamente 75.00 BRL
    const readCtx = uow.getReadContext();
    const finalWallet = await readCtx.wallets.findById(wallet.id);
    expect(finalWallet?.balance.amount).toBe("75.00");
    expect(finalWallet?.version).toBe(2); // 1 (OPENING) + 1 (BET)

    // Apenas 1 lançamento de débito no ledger
    const ledger = await readCtx.ledger.listByWallet(wallet.id, 100);
    expect(ledger.items.length).toBe(2); // 1 OPENING + 1 BET

    // Invariante global: saldo reconstruído pelo ledger == saldo materializado
    const reconcile = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconcile.consistent).toBe(true);
    expect(reconcile.difference.amount).toBe("0.00");
    expect(reconcile.storedBalance.amount).toBe("75.00");
    expect(reconcile.calculatedBalance.amount).toBe("75.00");
  });

  it("2. Mandatory Section 8 scenario: 100.00 BRL initial balance, two concurrent 80.00 BRL bets", async () => {
    const wallet = await openWalletUseCase.execute({
      playerId: "player-sec8",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const bet1 = {
      providerId: "prv-sec8",
      externalTransactionId: "bet-80-first",
      idempotencyKey: "prv-sec8:bet-80-first",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-80-A",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    };

    const bet2 = {
      providerId: "prv-sec8",
      externalTransactionId: "bet-80-second",
      idempotencyKey: "prv-sec8:bet-80-second",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-80-B",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    };

    // Dispara as duas apostas de 80 simultaneamente
    const results = await Promise.all([
      processWagerTxUseCase.execute(bet1, { correlationId: "corr-bet1" }),
      processWagerTxUseCase.execute(bet2, { correlationId: "corr-bet2" }),
    ]);

    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);

    // Exatamente uma aposta PROCESSED e a outra REJECTED por saldo insuficiente
    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.failureCode).toBe(FailureCode.InsufficientFunds);

    // Saldo final deve ser exatamente 20.00 BRL
    const readCtx = uow.getReadContext();
    const finalWallet = await readCtx.wallets.findById(wallet.id);
    expect(finalWallet?.balance.amount).toBe("20.00");
    expect(finalWallet?.version).toBe(2);

    // Exatamente UM lançamento de débito no ledger
    const ledger = await readCtx.ledger.listByWallet(wallet.id, 100);
    const debits = ledger.items.filter((i) => i.direction === "DEBIT");
    expect(debits.length).toBe(1);
    expect(debits[0]?.money.amount).toBe("80.00");

    // Invariante global: saldo reconstruído pelo ledger == saldo materializado
    const reconcile = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconcile.consistent).toBe(true);
    expect(reconcile.difference.amount).toBe("0.00");
    expect(reconcile.storedBalance.amount).toBe("20.00");
    expect(reconcile.calculatedBalance.amount).toBe("20.00");
  });

  it("3. Multiple distinct wallets processed in parallel without lock contention or deadlock", async () => {
    // Cria 10 carteiras distintas
    const wallets = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        openWalletUseCase.execute({
          playerId: `player-multi-${i}`,
          initialBalance: { amount: "100.00", currency: "BRL" },
        }),
      ),
    );

    // Dispara apostas simultâneas em todas as 10 carteiras
    const bets = wallets.map((w, i) =>
      processWagerTxUseCase.execute(
        {
          providerId: "prv-multi",
          externalTransactionId: `tx-multi-${i}`,
          idempotencyKey: `prv-multi:tx-multi-${i}`,
          playerId: w.playerId,
          walletId: w.id,
          roundId: `round-${i}`,
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "10.00", currency: "BRL" },
        },
        { correlationId: `corr-multi-${i}` },
      ),
    );

    const results = await Promise.all(bets);
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.every((r) => r.balance.amount === "90.00")).toBe(true);

    // Valida consistência de cada carteira
    for (const w of wallets) {
      const reconcile = await reconcileWalletUseCase.execute(w.id);
      expect(reconcile.consistent).toBe(true);
      expect(reconcile.storedBalance.amount).toBe("90.00");
      expect(reconcile.calculatedBalance.amount).toBe("90.00");
    }
  });

  it("4. Concurrent Outbox publishers with SKIP LOCKED prevent double publication", async () => {
    // Cria várias transações gerando eventos na Outbox
    const wallet = await openWalletUseCase.execute({
      playerId: "player-outbox-concurrency",
      initialBalance: { amount: "500.00", currency: "BRL" },
    });

    for (let i = 0; i < 10; i++) {
      await processWagerTxUseCase.execute(
        {
          providerId: "prv-pub",
          externalTransactionId: `bet-pub-${i}`,
          idempotencyKey: `prv-pub:bet-pub-${i}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `round-pub-${i}`,
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "5.00", currency: "BRL" },
        },
        { correlationId: `corr-pub-${i}` },
      );
    }

    const readCtx = uow.getReadContext();
    const initialPending = await readCtx.outbox.countPending();
    expect(initialPending).toBeGreaterThanOrEqual(10);

    // Cria 3 instâncias concorrentes de worker disputando o mesmo lote de outbox
    const worker1 = new OutboxPublisherWorker(uow);
    const worker2 = new OutboxPublisherWorker(uow);
    const worker3 = new OutboxPublisherWorker(uow);

    // Executa publicação concorrente com SKIP LOCKED
    const [c1, c2, c3] = await Promise.all([
      worker1.pollAndPublish(10),
      worker2.pollAndPublish(10),
      worker3.pollAndPublish(10),
    ]);

    const totalPublished = c1 + c2 + c3;
    expect(totalPublished).toBe(initialPending);

    const remainingPending = await readCtx.outbox.countPending();
    expect(remainingPending).toBe(0);

    worker1.stop();
    worker2.stop();
    worker3.stop();
  });
});
