import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "@application/errors/application-errors.ts";
import { GetWalletLedgerUseCase } from "@application/use-cases/get-wallet-ledger.use-case.ts";
import { OpenWalletUseCase } from "@application/use-cases/open-wallet.use-case.ts";
import { ProcessWagerTransactionUseCase } from "@application/use-cases/process-wager-transaction.use-case.ts";
import { ReconcilePendingReferencesUseCase } from "@application/use-cases/reconcile-pending-references.use-case.ts";
import { ReconcileWalletUseCase } from "@application/use-cases/reconcile-wallet.use-case.ts";
import { FailureCode, IdempotencyConflictError } from "@domain/shared/domain-errors.ts";
import { WagerTransactionKind, WagerTransactionStatus } from "@domain/wagering/wager-transaction.ts";
import { LedgerDirection } from "@domain/wallet/wallet-ledger-entry.ts";
import { buildMikroOrmOptions } from "@infrastructure/persistence/mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "@infrastructure/persistence/repositories/mikro-orm-unit-of-work.ts";

describe("Application Use Cases Integration Tests (PostgreSQL)", () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;

  let openWalletUseCase: OpenWalletUseCase;
  let processWagerTxUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let getWalletLedgerUseCase: GetWalletLedgerUseCase;
  let reconcilePendingRefUseCase: ReconcilePendingReferencesUseCase;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    orm = await MikroORM.init(buildMikroOrmOptions());
    uow = new MikroOrmUnitOfWork(orm.em);

    openWalletUseCase = new OpenWalletUseCase(uow);
    processWagerTxUseCase = new ProcessWagerTransactionUseCase(uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(uow);
    getWalletLedgerUseCase = new GetWalletLedgerUseCase(uow);
    reconcilePendingRefUseCase = new ReconcilePendingReferencesUseCase(uow);
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

  describe("OpenWalletUseCase", () => {
    it("opens a wallet with positive initial balance, recording OPENING tx, ledger CREDIT, and outbox event", async () => {
      const result = await openWalletUseCase.execute({
        playerId: "player-1",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      expect(result.id).toBeDefined();
      expect(result.playerId).toBe("player-1");
      expect(result.balance).toEqual({ amount: "100.00", currency: "BRL" });
      expect(result.version).toBe(1);

      const readCtx = uow.getReadContext();
      const wallet = await readCtx.wallets.findById(result.id);
      expect(wallet).not.toBeNull();
      expect(wallet?.balance.amount).toBe("100.00");

      const ledger = await readCtx.ledger.listByWallet(result.id, 10);
      expect(ledger.items.length).toBe(1);
      expect(ledger.items[0]?.direction).toBe(LedgerDirection.Credit);
      expect(ledger.items[0]?.money.amount).toBe("100.00");

      const pendingOutbox = await readCtx.outbox.countPending();
      expect(pendingOutbox).toBe(1);
    });

    it("throws WalletAlreadyExistsError when trying to open duplicate wallet for player and currency", async () => {
      await openWalletUseCase.execute({
        playerId: "player-1",
        initialBalance: { amount: "50.00", currency: "BRL" },
      });

      await expect(
        openWalletUseCase.execute({
          playerId: "player-1",
          initialBalance: { amount: "10.00", currency: "BRL" },
        }),
      ).rejects.toThrow(WalletAlreadyExistsError);
    });
  });

  describe("ProcessWagerTransactionUseCase", () => {
    it("processes a BET with sufficient funds: debits wallet, creates ledger entry, and enqueues outbox events", async () => {
      const wallet = await openWalletUseCase.execute({
        playerId: "player-2",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      const result = await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "ext-bet-1",
          idempotencyKey: "prv-1:ext-bet-1",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-1",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "25.00", currency: "BRL" },
        },
        { correlationId: "corr-1" },
      );

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance).toEqual({ amount: "75.00", currency: "BRL" });
      expect(result.idempotentReplay).toBe(false);

      const readCtx = uow.getReadContext();
      const updatedWallet = await readCtx.wallets.findById(wallet.id);
      expect(updatedWallet?.balance.amount).toBe("75.00");
      expect(updatedWallet?.version).toBe(2);

      const ledgerResult = await readCtx.ledger.listByWallet(wallet.id, 10);
      expect(ledgerResult.items.length).toBe(2); // OPENING + BET
      const betEntry = ledgerResult.items.find((i) => i.direction === "DEBIT");
      expect(betEntry).toBeDefined();
      expect(betEntry?.money.amount).toBe("25.00");
      expect(betEntry?.balanceAfter.amount).toBe("75.00");
    });

    it("rejects a BET when balance is insufficient (INSUFFICIENT_FUNDS) without modifying balance or ledger", async () => {
      const wallet = await openWalletUseCase.execute({
        playerId: "player-3",
        initialBalance: { amount: "20.00", currency: "BRL" },
      });

      const result = await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "ext-bet-insufficient",
          idempotencyKey: "prv-1:ext-bet-insufficient",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-2",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "50.00", currency: "BRL" },
        },
        { correlationId: "corr-2" },
      );

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(result.balance).toEqual({ amount: "20.00", currency: "BRL" });

      const readCtx = uow.getReadContext();
      const updatedWallet = await readCtx.wallets.findById(wallet.id);
      expect(updatedWallet?.balance.amount).toBe("20.00");
      expect(updatedWallet?.version).toBe(1);

      // Only OPENING ledger entry exists, no debit entry was inserted
      const ledgerResult = await readCtx.ledger.listByWallet(wallet.id, 10);
      expect(ledgerResult.items.length).toBe(1);
    });

    it("processes WIN and LOSS correctly", async () => {
      const wallet = await openWalletUseCase.execute({
        playerId: "player-4",
        initialBalance: { amount: "50.00", currency: "BRL" },
      });

      // 1. WIN
      const winResult = await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "ext-win-1",
          idempotencyKey: "prv-1:ext-win-1",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-3",
          gameId: "game-1",
          kind: WagerTransactionKind.Win,
          money: { amount: "100.00", currency: "BRL" },
        },
        { correlationId: "corr-win" },
      );

      expect(winResult.status).toBe(WagerTransactionStatus.Processed);
      expect(winResult.balance).toEqual({ amount: "150.00", currency: "BRL" });

      // 2. LOSS (0.00 amount, does not move balance or create ledger entry)
      const lossResult = await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "ext-loss-1",
          idempotencyKey: "prv-1:ext-loss-1",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-3",
          gameId: "game-1",
          kind: WagerTransactionKind.Loss,
          money: { amount: "0.00", currency: "BRL" },
        },
        { correlationId: "corr-loss" },
      );

      expect(lossResult.status).toBe(WagerTransactionStatus.Processed);
      expect(lossResult.balance).toEqual({ amount: "150.00", currency: "BRL" });

      const readCtx = uow.getReadContext();
      const updatedWallet = await readCtx.wallets.findById(wallet.id);
      expect(updatedWallet?.balance.amount).toBe("150.00");

      const ledgerResult = await readCtx.ledger.listByWallet(wallet.id, 10);
      expect(ledgerResult.items.length).toBe(2); // OPENING + WIN (LOSS does not create ledger)
    });

    it("enforces idempotent replay: same idempotencyKey with identical payload returns idempotentReplay: true", async () => {
      const wallet = await openWalletUseCase.execute({
        playerId: "player-5",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      const cmd = {
        providerId: "prv-1",
        externalTransactionId: "ext-bet-replay",
        idempotencyKey: "prv-1:ext-bet-replay",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "rnd-4",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
      };

      const first = await processWagerTxUseCase.execute(cmd, { correlationId: "corr-r1" });
      expect(first.idempotentReplay).toBe(false);
      expect(first.balance.amount).toBe("70.00");

      const second = await processWagerTxUseCase.execute(cmd, { correlationId: "corr-r2" });
      expect(second.idempotentReplay).toBe(true);
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.balance.amount).toBe("70.00");

      const readCtx = uow.getReadContext();
      const ledgerResult = await readCtx.ledger.listByWallet(wallet.id, 10);
      expect(ledgerResult.items.length).toBe(2); // OPENING + 1 BET (no duplicate debit)
    });

    it("throws IdempotencyConflictError when same idempotencyKey is used with different payload", async () => {
      const wallet = await openWalletUseCase.execute({
        playerId: "player-6",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "ext-tx-key-1",
          idempotencyKey: "same-key-123",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-5",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "10.00", currency: "BRL" },
        },
        { correlationId: "corr-c1" },
      );

      // Attempting to send same key with different amount
      await expect(
        processWagerTxUseCase.execute(
          {
            providerId: "prv-1",
            externalTransactionId: "ext-tx-key-1",
            idempotencyKey: "same-key-123",
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "rnd-5",
            gameId: "game-1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "20.00", currency: "BRL" }, // Different amount
          },
          { correlationId: "corr-c2" },
        ),
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it("processes REFUND of a BET and rejects DUPLICATE_REVERSAL", async () => {
      const wallet = await openWalletUseCase.execute({
        playerId: "player-7",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      // 1. Original BET
      await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "bet-to-refund",
          idempotencyKey: "prv-1:bet-to-refund",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-6",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "40.00", currency: "BRL" },
        },
        { correlationId: "corr-b" },
      );

      // 2. REFUND referencing original BET
      const refundResult = await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "refund-1",
          idempotencyKey: "prv-1:refund-1",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-6",
          gameId: "game-1",
          kind: WagerTransactionKind.Refund,
          money: { amount: "40.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-to-refund",
        },
        { correlationId: "corr-ref-1" },
      );

      expect(refundResult.status).toBe(WagerTransactionStatus.Processed);
      expect(refundResult.balance.amount).toBe("100.00"); // 60 + 40 = 100

      // 3. Second REFUND of the same BET must be rejected with DUPLICATE_REVERSAL
      const duplicateRefundResult = await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "refund-2",
          idempotencyKey: "prv-1:refund-2",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-6",
          gameId: "game-1",
          kind: WagerTransactionKind.Refund,
          money: { amount: "40.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-to-refund",
        },
        { correlationId: "corr-ref-2" },
      );

      expect(duplicateRefundResult.status).toBe(WagerTransactionStatus.Rejected);
      expect(duplicateRefundResult.failureCode).toBe(FailureCode.DuplicateReversal);
      expect(duplicateRefundResult.balance.amount).toBe("100.00");
    });

    it("rejects ROLLBACK of WIN with NEGATIVE_BALANCE_ON_REVERSAL when wallet lacks balance", async () => {
      // Wallet starts with 0.00
      const wallet = await openWalletUseCase.execute({
        playerId: "player-8",
        initialBalance: { amount: "0.00", currency: "BRL" },
      });

      // Player wins 100.00
      await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "win-to-rollback",
          idempotencyKey: "prv-1:win-to-rollback",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-7",
          gameId: "game-1",
          kind: WagerTransactionKind.Win,
          money: { amount: "100.00", currency: "BRL" },
        },
        { correlationId: "corr-w" },
      );

      // Player spends 80.00 on another bet (balance drops to 20.00)
      await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "bet-spend",
          idempotencyKey: "prv-1:bet-spend",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-8",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "80.00", currency: "BRL" },
        },
        { correlationId: "corr-s" },
      );

      // Provider attempts to ROLLBACK the 100.00 WIN, but balance is only 20.00
      const rollbackResult = await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "rollback-win-1",
          idempotencyKey: "prv-1:rollback-win-1",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-7",
          gameId: "game-1",
          kind: WagerTransactionKind.Rollback,
          money: { amount: "100.00", currency: "BRL" },
          referenceExternalTransactionId: "win-to-rollback",
        },
        { correlationId: "corr-rb" },
      );

      expect(rollbackResult.status).toBe(WagerTransactionStatus.Rejected);
      expect(rollbackResult.failureCode).toBe(FailureCode.NegativeBalanceOnReversal);
      expect(rollbackResult.balance.amount).toBe("20.00");
    });
  });

  describe("ReconcileWalletUseCase & GetWalletLedgerUseCase", () => {
    it("confirms consistency between stored balance and ledger arithmetic", async () => {
      const wallet = await openWalletUseCase.execute({
        playerId: "player-9",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "rec-bet-1",
          idempotencyKey: "prv-1:rec-bet-1",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-rec",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "30.00", currency: "BRL" },
        },
        { correlationId: "corr-rec" },
      );

      const reconcileResult = await reconcileWalletUseCase.execute(wallet.id);
      expect(reconcileResult.consistent).toBe(true);
      expect(reconcileResult.storedBalance.amount).toBe("70.00");
      expect(reconcileResult.calculatedBalance.amount).toBe("70.00");
      expect(reconcileResult.difference.amount).toBe("0.00");
      expect(reconcileResult.checkedEntries).toBe(2);

      const ledgerPage = await getWalletLedgerUseCase.execute(wallet.id, 10);
      expect(ledgerPage.items.length).toBe(2);
      expect(ledgerPage.items[0]?.direction).toBe(LedgerDirection.Debit);
      expect(ledgerPage.items[1]?.direction).toBe(LedgerDirection.Credit);
    });
  });

  describe("ReconcilePendingReferencesUseCase", () => {
    it("handles out-of-order REFUND arriving before BET, then resolves it when BET is processed", async () => {
      const wallet = await openWalletUseCase.execute({
        playerId: "player-10",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      // 1. REFUND arrives BEFORE the BET
      const pendingRefund = await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "future-refund",
          idempotencyKey: "prv-1:future-refund",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-ooo",
          gameId: "game-1",
          kind: WagerTransactionKind.Refund,
          money: { amount: "20.00", currency: "BRL" },
          referenceExternalTransactionId: "future-bet",
        },
        { correlationId: "corr-ooo-1" },
      );

      expect(pendingRefund.status).toBe(WagerTransactionStatus.PendingReference);
      expect(pendingRefund.balance.amount).toBe("100.00");

      const conn = orm.em.getConnection();
      // Set next_retry_at to past so reconciliation worker picks it up
      await conn.execute(
        `UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = ?`,
        [pendingRefund.transactionId],
      );

      // Running reconciliation before BET arrives: reference still missing, schedules retry
      const firstRun = await reconcilePendingRefUseCase.execute(10);
      expect(firstRun.retried).toBe(1);
      expect(firstRun.reconciled).toBe(0);

      // 2. The BET finally arrives
      await processWagerTxUseCase.execute(
        {
          providerId: "prv-1",
          externalTransactionId: "future-bet",
          idempotencyKey: "prv-1:future-bet",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-ooo",
          gameId: "game-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "20.00", currency: "BRL" },
        },
        { correlationId: "corr-ooo-2" },
      );

      // Reset next_retry_at to past so reconciliation worker picks it up immediately
      await conn.execute(
        `UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = ?`,
        [pendingRefund.transactionId],
      );

      // 3. Worker reconciles the pending refund with the now-available BET
      const secondRun = await reconcilePendingRefUseCase.execute(10);
      expect(secondRun.reconciled).toBe(1);

      const readCtx = uow.getReadContext();
      const reconciledTx = await readCtx.transactions.findById(pendingRefund.transactionId);
      expect(reconciledTx?.status).toBe(WagerTransactionStatus.Processed);

      const finalWallet = await readCtx.wallets.findById(wallet.id);
      // Started 100.00 -> Bet -20.00 (80.00) -> Refund +20.00 (100.00)
      expect(finalWallet?.balance.amount).toBe("100.00");
    });
  });
});
