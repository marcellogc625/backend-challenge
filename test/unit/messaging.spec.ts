import { describe, expect, it } from "bun:test";
import { InboxMessage } from "@domain/messaging/inbox-message.ts";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "@domain/messaging/integration-events.ts";
import { OutboxMessage } from "@domain/messaging/outbox-message.ts";
import { FailureCode } from "@domain/shared/domain-errors.ts";
import { Money } from "@domain/shared/money.ts";
import { WagerTransaction, WagerTransactionKind } from "@domain/wagering/wager-transaction.ts";
import { Wallet } from "@domain/wallet/wallet.ts";

describe("Messaging Entities & Integration Events", () => {
  it("tracks InboxMessage processing lifecycle", () => {
    const receivedAt = new Date("2026-04-17T12:00:00.000Z");
    const inbox = InboxMessage.receive({
      messageId: "evolution:ext-1",
      consumerName: "wager-transactions-consumer",
      payloadHash: "abc123hash",
      receivedAt,
    });

    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();

    const processedAt = new Date("2026-04-17T12:00:01.000Z");
    inbox.markProcessed(processedAt);

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(processedAt);
  });

  it("serializes IntegrationEvent subclasses and manages OutboxMessage retry backoff", () => {
    const now = new Date("2026-04-17T12:00:00.000Z");
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      now,
    });

    const entry = wallet.debit({
      ledgerEntryId: "le-1",
      transactionId: "tx-1",
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      now,
    });

    const balanceEvent = WalletBalanceChanged.from(wallet, entry, {
      eventId: "evt-1",
      correlationId: "corr-1",
      causationId: "tx-1",
      occurredAt: now,
    });

    const outbox = OutboxMessage.enqueue(balanceEvent);
    expect(outbox.id).toBe("evt-1");
    expect(outbox.aggregateId).toBe("wallet-1");
    expect(outbox.eventType).toBe("WalletBalanceChanged");
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(now)).toBe(true);
    expect(outbox.payload.version).toBe(1);

    // Retry backoff: 1st retry = +1000ms, 2nd retry = +2000ms
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 1_000);
    expect(outbox.isDue(now)).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 1_000))).toBe(true);

    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 2_000);

    const publishedAt = new Date(now.getTime() + 2_500);
    outbox.markPublished(publishedAt);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(publishedAt)).toBe(false);
  });

  it("constructs WagerTransactionProcessed, WagerTransactionRejected, and WagerTransactionPendingReference events", () => {
    const tx = WagerTransaction.create({
      id: "tx-refund",
      providerId: "evolution",
      externalTransactionId: "ext-refund",
      idempotencyKey: "evolution:ext-refund",
      payloadHash: "hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "crazy-time",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-bet",
    });

    const pendingEvent = WagerTransactionPendingReference.from(tx, {
      eventId: "evt-pending",
      correlationId: "corr-1",
    });
    expect(pendingEvent.eventType).toBe("WagerTransactionPendingReference");
    expect(pendingEvent.data.referenceExternalTransactionId).toBe("ext-bet");

    const rejectedEvent = WagerTransactionRejected.from(tx, FailureCode.ReferenceNotFoundTimeout, {
      eventId: "evt-rejected",
      correlationId: "corr-1",
    });
    expect(rejectedEvent.eventType).toBe("WagerTransactionRejected");
    expect(rejectedEvent.data.failureCode).toBe(FailureCode.ReferenceNotFoundTimeout);

    tx.markProcessed("tx-bet");
    const processedEvent = WagerTransactionProcessed.from(
      tx,
      { amount: "100.00", currency: "BRL" },
      { eventId: "evt-processed", correlationId: "corr-1" },
    );
    expect(processedEvent.eventType).toBe("WagerTransactionProcessed");
    expect(processedEvent.data.referenceTransactionId).toBe("tx-bet");
  });
});
