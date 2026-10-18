import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { InboxMessage } from "@domain/messaging/inbox-message.ts";
import { OutboxMessage } from "@domain/messaging/outbox-message.ts";
import { FailureCode } from "@domain/shared/domain-errors.ts";
import { Money } from "@domain/shared/money.ts";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "@domain/wagering/wager-transaction.ts";
import { LedgerDirection, WalletLedgerEntry } from "@domain/wallet/wallet-ledger-entry.ts";
import { Wallet } from "@domain/wallet/wallet.ts";
import { buildMikroOrmOptions } from "@infrastructure/persistence/mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "@infrastructure/persistence/repositories/mikro-orm-unit-of-work.ts";

describe("Persistence Layer Integration Tests (PostgreSQL)", () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    orm = await MikroORM.init(buildMikroOrmOptions());
    uow = new MikroOrmUnitOfWork(orm.em);
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

  it("persists and retrieves a Wallet, enforcing unique (player_id, currency)", async () => {
    const wallet = Wallet.open({
      id: "0192f291-27dd-7d3f-8071-5f8685deef37",
      playerId: "player-alpha",
      initialBalance: Money.from({ amount: "500.00", currency: "BRL" }),
    });

    await uow.runInTransaction(async (tx) => {
      await tx.wallets.insert(wallet);
    });

    const readCtx = uow.getReadContext();
    const found = await readCtx.wallets.findById(wallet.id);
    expect(found).not.toBeNull();
    expect(found?.playerId).toBe("player-alpha");
    expect(found?.balance.amount).toBe("500.00");
    expect(found?.version).toBe(1);

    const duplicateWallet = Wallet.open({
      id: "0192f291-27dd-7d3f-8071-5f8685deef38",
      playerId: "player-alpha",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    await expect(
      uow.runInTransaction(async (tx) => {
        await tx.wallets.insert(duplicateWallet);
      }),
    ).rejects.toThrow();
  });

  it("rolls back all changes atomically across aggregate boundaries when a transaction fails", async () => {
    const wallet = Wallet.open({
      id: "0192f291-27dd-7d3f-8071-5f8685deef39",
      playerId: "player-beta",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    await expect(
      uow.runInTransaction(async (tx) => {
        await tx.wallets.insert(wallet);
        throw new Error("Simulated transient failure inside UnitOfWork");
      }),
    ).rejects.toThrow("Simulated transient failure inside UnitOfWork");

    const readCtx = uow.getReadContext();
    const found = await readCtx.wallets.findById(wallet.id);
    expect(found).toBeNull();
  });

  it("enforces append-only trigger on wallet_ledger_entries: forbids UPDATE and DELETE", async () => {
    const walletId = "0192f291-27dd-7d3f-8071-5f8685deef40";
    const txId = "0192f291-27dd-7d3f-8071-5f8685deef41";
    const ledgerId = "0192f291-27dd-7d3f-8071-5f8685deef42";

    const wallet = Wallet.open({
      id: walletId,
      playerId: "player-gamma",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const openTx = WagerTransaction.createOpening({
      id: txId,
      walletId,
      playerId: "player-gamma",
      money: Money.from({ amount: "100.00", currency: "BRL" }),
      payloadHash: "hash-gamma",
    });

    const ledgerEntry = WalletLedgerEntry.create({
      id: ledgerId,
      walletId,
      transactionId: txId,
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceBefore: Money.zero("BRL"),
      balanceAfter: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    await uow.runInTransaction(async (tx) => {
      await tx.wallets.insert(wallet);
      await tx.transactions.insert(openTx);
      await tx.ledger.insert(ledgerEntry);
    });

    const conn = orm.em.getConnection();

    // UPDATE attempt on ledger entry must fail at DB trigger level
    await expect(
      conn.execute(`UPDATE wallet_ledger_entries SET amount = 200.00 WHERE id = ?`, [ledgerId]),
    ).rejects.toThrow(/append-only/i);

    // DELETE attempt on ledger entry must fail at DB trigger level
    await expect(
      conn.execute(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [ledgerId]),
    ).rejects.toThrow(/append-only/i);
  });

  it("enforces arithmetic balance check on wallet_ledger_entries via DB constraint", async () => {
    const walletId = "0192f291-27dd-7d3f-8071-5f8685deef50";
    const txId = "0192f291-27dd-7d3f-8071-5f8685deef51";
    const ledgerId = "0192f291-27dd-7d3f-8071-5f8685deef52";

    const wallet = Wallet.open({
      id: walletId,
      playerId: "player-delta",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    const openTx = WagerTransaction.createOpening({
      id: txId,
      walletId,
      playerId: "player-delta",
      money: Money.from({ amount: "50.00", currency: "BRL" }),
      payloadHash: "hash-delta",
    });

    await uow.runInTransaction(async (tx) => {
      await tx.wallets.insert(wallet);
      await tx.transactions.insert(openTx);
    });

    const conn = orm.em.getConnection();

    // Direct SQL insertion violating chk_ledger_arithmetic_balanced
    await expect(
      conn.execute(
        `INSERT INTO wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after
        ) VALUES (?, ?, ?, 'CREDIT', 10.00, 'BRL', 50.00, 70.00)`, // 50 + 10 != 70
        [ledgerId, walletId, txId],
      ),
    ).rejects.toThrow();
  });

  it("enforces partial unique index preventing duplicate processed reversals", async () => {
    const walletId = "0192f291-27dd-7d3f-8071-5f8685deef60";
    const betTxId = "0192f291-27dd-7d3f-8071-5f8685deef61";
    const refund1Id = "0192f291-27dd-7d3f-8071-5f8685deef62";
    const refund2Id = "0192f291-27dd-7d3f-8071-5f8685deef63";

    const wallet = Wallet.open({
      id: walletId,
      playerId: "player-epsilon",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const betTx = WagerTransaction.create({
      id: betTxId,
      providerId: "prv-1",
      externalTransactionId: "ext-bet-60",
      idempotencyKey: "prv-1:ext-bet-60",
      payloadHash: "hash-bet-60",
      walletId,
      playerId: "player-epsilon",
      roundId: "rnd-60",
      gameId: "game-60",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "20.00", currency: "BRL" }),
    });
    betTx.markProcessed(undefined);

    const refund1 = WagerTransaction.create({
      id: refund1Id,
      providerId: "prv-1",
      externalTransactionId: "ext-ref-61",
      idempotencyKey: "prv-1:ext-ref-61",
      payloadHash: "hash-ref-61",
      walletId,
      playerId: "player-epsilon",
      roundId: "rnd-60",
      gameId: "game-60",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "20.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-bet-60",
    });
    refund1.markProcessed(betTxId);

    const refund2 = WagerTransaction.create({
      id: refund2Id,
      providerId: "prv-1",
      externalTransactionId: "ext-ref-62",
      idempotencyKey: "prv-1:ext-ref-62",
      payloadHash: "hash-ref-62",
      walletId,
      playerId: "player-epsilon",
      roundId: "rnd-60",
      gameId: "game-60",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "20.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-bet-60",
    });
    refund2.markProcessed(betTxId);

    await uow.runInTransaction(async (tx) => {
      await tx.wallets.insert(wallet);
      await tx.transactions.insert(betTx);
      await tx.transactions.insert(refund1);
    });

    // Attempting to insert a second PROCESSED reversal referencing the same transaction must violate uq_wager_tx_single_processed_reversal
    await expect(
      uow.runInTransaction(async (tx) => {
        await tx.transactions.insert(refund2);
      }),
    ).rejects.toThrow();
  });

  it("handles inbox message deduplication via tryAccept", async () => {
    const msg = InboxMessage.receive({
      messageId: "msg-100",
      consumerName: "wager-consumer",
      payloadHash: "hash-msg-100",
    });

    const res1 = await uow.runInTransaction(async (tx) => tx.inbox.tryAccept(msg));
    expect(res1.inserted).toBe(true);
    expect(res1.message.messageId).toBe("msg-100");
    expect(res1.message.isProcessed()).toBe(false);

    // Marking processed
    await uow.runInTransaction(async (tx) => {
      await tx.inbox.markProcessed("msg-100", "wager-consumer", new Date());
    });

    // Second accept attempt (redelivery/duplicate)
    const res2 = await uow.runInTransaction(async (tx) => tx.inbox.tryAccept(msg));
    expect(res2.inserted).toBe(false);
    expect(res2.message.isProcessed()).toBe(true);
  });

  it("claims due outbox messages and calculates pending lag", async () => {
    const now = new Date("2026-10-18T10:00:00.000Z");

    const outboxMsg = OutboxMessage.rehydrate({
      id: "0192f291-27dd-7d3f-8071-5f8685deef70",
      aggregateId: "wallet-70",
      eventType: "WalletBalanceChanged",
      payload: { walletId: "wallet-70", amount: "50.00" },
      occurredAt: new Date(now.getTime() - 5_000), // 5 seconds ago
      attempts: 0,
      nextAttemptAt: now,
    });

    await uow.runInTransaction(async (tx) => {
      await tx.outbox.enqueue(outboxMsg);
    });

    const readCtx = uow.getReadContext();
    const count = await readCtx.outbox.countPending();
    expect(count).toBe(1);

    const lag = await readCtx.outbox.oldestPendingAgeSeconds(now);
    expect(lag).toBeGreaterThanOrEqual(5);

    const claimed = await uow.runInTransaction(async (tx) => {
      return tx.outbox.claimDueBatch(10, now);
    });

    expect(claimed.length).toBe(1);
    expect(claimed[0]?.id).toBe("0192f291-27dd-7d3f-8071-5f8685deef70");
  });
});
