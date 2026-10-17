import { describe, expect, it } from "bun:test";
import { computeWagerPayloadHash } from "@domain/shared/canonical-hash.ts";
import { FailureCode, InvalidMoneyError, InvalidTransactionRuleError, InvalidTransactionStateError } from "@domain/shared/domain-errors.ts";
import { Money } from "@domain/shared/money.ts";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "@domain/wagering/wager-transaction.ts";
import { LedgerDirection } from "@domain/wallet/wallet-ledger-entry.ts";

describe("WagerTransaction Entity & Canonical Payload Hash", () => {
  const baseInput = {
    providerId: "evolution",
    externalTransactionId: "ext-bet-1",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-1",
    gameId: "crazy-time",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
  };

  it("computes deterministic canonical SHA-256 payloadHash independent of property order or correlationId", () => {
    const hash1 = computeWagerPayloadHash(baseInput);
    const hash2 = computeWagerPayloadHash({
      money: { currency: "BRL", amount: "25.00" },
      kind: WagerTransactionKind.Bet,
      gameId: "crazy-time",
      roundId: "round-1",
      walletId: "wallet-1",
      playerId: "player-1",
      externalTransactionId: "ext-bet-1",
      providerId: "evolution",
    });
    const hashDifferentAmount = computeWagerPayloadHash({
      ...baseInput,
      money: { amount: "30.00", currency: "BRL" },
    });

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).not.toBe(hashDifferentAmount);
  });

  it("forbids external creation of OPENING transactions", () => {
    expect(() =>
      WagerTransaction.create({
        id: "tx-open",
        providerId: "evolution",
        externalTransactionId: "ext-open",
        idempotencyKey: "evolution:ext-open",
        payloadHash: "hash",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Opening,
        money: Money.from({ amount: "100.00", currency: "BRL" }),
      }),
    ).toThrow(InvalidTransactionRuleError);
  });

  it("creates internal OPENING transaction directly in PROCESSED state", () => {
    const opening = WagerTransaction.createOpening({
      id: "tx-open-1",
      walletId: "wallet-1",
      playerId: "player-1",
      money: Money.from({ amount: "100.00", currency: "BRL" }),
      payloadHash: "hash-open",
    });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.isTerminal()).toBe(true);
    expect(opening.affectsBalance()).toBe(true);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it("allows LOSS with 0.00 amount and reports affectsBalance() === false", () => {
    const loss = WagerTransaction.create({
      id: "tx-loss",
      providerId: "evolution",
      externalTransactionId: "ext-loss-1",
      idempotencyKey: "evolution:ext-loss-1",
      payloadHash: "hash-loss",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "crazy-time",
      kind: WagerTransactionKind.Loss,
      money: Money.zero("BRL"),
    });

    expect(loss.status).toBe(WagerTransactionStatus.Pending);
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.requiresReference()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionRuleError);
  });

  it("rejects zero amount for BET, WIN, REFUND, and ROLLBACK", () => {
    const kinds = [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ];

    for (const kind of kinds) {
      expect(() =>
        WagerTransaction.create({
          id: "tx-zero",
          providerId: "evolution",
          externalTransactionId: "ext-zero",
          idempotencyKey: "evolution:ext-zero",
          payloadHash: "hash",
          walletId: "wallet-1",
          playerId: "player-1",
          roundId: "round-1",
          gameId: "crazy-time",
          kind,
          money: Money.zero("BRL"),
          referenceExternalTransactionId: "ext-ref",
        }),
      ).toThrow(InvalidMoneyError);
    }
  });

  it("requires referenceExternalTransactionId for REFUND and ROLLBACK", () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(() =>
        WagerTransaction.create({
          id: "tx-ref",
          providerId: "evolution",
          externalTransactionId: "ext-ref-1",
          idempotencyKey: "evolution:ext-ref-1",
          payloadHash: "hash",
          walletId: "wallet-1",
          playerId: "player-1",
          roundId: "round-1",
          gameId: "crazy-time",
          kind,
          money: Money.from({ amount: "10.00", currency: "BRL" }),
        }),
      ).toThrow(InvalidTransactionRuleError);
    }
  });

  it("computes correct LedgerDirection for BET, WIN, REFUND, and ROLLBACK (of BET, WIN, REFUND)", () => {
    const makeTx = (kind: WagerTransactionKind, refExtId?: string) =>
      WagerTransaction.create({
        id: `tx-${kind}`,
        providerId: "evolution",
        externalTransactionId: `ext-${kind}`,
        idempotencyKey: `evolution:ext-${kind}`,
        payloadHash: "hash",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "crazy-time",
        kind,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        referenceExternalTransactionId: refExtId,
      });

    const bet = makeTx(WagerTransactionKind.Bet);
    const win = makeTx(WagerTransactionKind.Win);
    const refund = makeTx(WagerTransactionKind.Refund, "ext-BET");
    const rollback = makeTx(WagerTransactionKind.Rollback, "ext-target");

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it("enforces state machine transitions and prevents leaving terminal states (PROCESSED, REJECTED, FAILED)", () => {
    const refund = WagerTransaction.create({
      id: "tx-refund-1",
      providerId: "evolution",
      externalTransactionId: "ext-refund-1",
      idempotencyKey: "evolution:ext-refund-1",
      payloadHash: "hash-refund",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "crazy-time",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-bet-1",
    });

    // PENDING -> PENDING_REFERENCE -> PROCESSED
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.isTerminal()).toBe(false);

    // Cannot mark PROCESSED without referenceTransactionId on REFUND/ROLLBACK
    expect(() => refund.markProcessed(undefined)).toThrow(InvalidTransactionRuleError);

    refund.markProcessed("tx-bet-1");
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.referenceTransactionId).toBe("tx-bet-1");
    expect(refund.isTerminal()).toBe(true);

    // Terminal state cannot transition again
    expect(() => refund.reject(FailureCode.DuplicateReversal)).toThrow(InvalidTransactionStateError);
    expect(() => refund.fail(FailureCode.InfrastructureFailure)).toThrow(InvalidTransactionStateError);
    expect(() => refund.markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});
