import { InboxMessage } from "@domain/messaging/inbox-message.ts";
import { OutboxMessage } from "@domain/messaging/outbox-message.ts";
import type { FailureCode } from "@domain/shared/domain-errors.ts";
import { Money } from "@domain/shared/money.ts";
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from "@domain/wagering/wager-transaction.ts";
import { type LedgerDirection, WalletLedgerEntry } from "@domain/wallet/wallet-ledger-entry.ts";
import { Wallet } from "@domain/wallet/wallet.ts";
import { EntitySchema } from "@mikro-orm/postgresql";

export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  status!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  retryCount!: number;
  nextRetryAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export class WalletLedgerEntryRow {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxMessageRow {
  messageId!: string;
  consumerName!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxMessageRow {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    currency: { type: "string", length: 3 },
    balanceAmount: { type: "numeric", fieldName: "balance_amount", precision: 20, scale: 2 },
    version: { type: "integer" },
    createdAt: { type: "datetime", fieldName: "created_at" },
    updatedAt: { type: "datetime", fieldName: "updated_at" },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransactionRow,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id", length: 128 },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id", length: 128 },
    idempotencyKey: { type: "string", fieldName: "idempotency_key", length: 255 },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    roundId: { type: "string", fieldName: "round_id", length: 128 },
    gameId: { type: "string", fieldName: "game_id", length: 128 },
    kind: { type: "string", length: 32 },
    amount: { type: "numeric", precision: 20, scale: 2 },
    currency: { type: "string", length: 3 },
    status: { type: "string", length: 32 },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      length: 128,
      nullable: true,
    },
    referenceTransactionId: {
      type: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    failureCode: { type: "string", fieldName: "failure_code", length: 64, nullable: true },
    retryCount: { type: "integer", fieldName: "retry_count", default: 0 },
    nextRetryAt: { type: "datetime", fieldName: "next_retry_at", nullable: true },
    createdAt: { type: "datetime", fieldName: "created_at" },
    processedAt: { type: "datetime", fieldName: "processed_at", nullable: true },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  class: WalletLedgerEntryRow,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { type: "string", length: 16 },
    amount: { type: "numeric", precision: 20, scale: 2 },
    currency: { type: "string", length: 3 },
    balanceBefore: { type: "numeric", fieldName: "balance_before", precision: 20, scale: 2 },
    balanceAfter: { type: "numeric", fieldName: "balance_after", precision: 20, scale: 2 },
    createdAt: { type: "datetime", fieldName: "created_at" },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  class: InboxMessageRow,
  tableName: "inbox_messages",
  properties: {
    messageId: { type: "string", fieldName: "message_id", length: 255, primary: true },
    consumerName: { type: "string", fieldName: "consumer_name", length: 128, primary: true },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    receivedAt: { type: "datetime", fieldName: "received_at" },
    processedAt: { type: "datetime", fieldName: "processed_at", nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  class: OutboxMessageRow,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id", length: 128 },
    eventType: { type: "string", fieldName: "event_type", length: 128 },
    payload: { type: "json" },
    occurredAt: { type: "datetime", fieldName: "occurred_at" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: { type: "datetime", fieldName: "next_attempt_at", nullable: true },
    publishedAt: { type: "datetime", fieldName: "published_at", nullable: true },
  },
});

export const PersistenceMappers = {
  walletToDomain(row: WalletRow): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: Money.from({ amount: formatScale2(row.balanceAmount), currency: row.currency }),
      version: Number(row.version),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    });
  },

  transactionToDomain(row: WagerTransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({ amount: formatScale2(row.amount), currency: row.currency }),
      referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      createdAt: new Date(row.createdAt),
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
      failureCode: (row.failureCode as FailureCode | null) ?? undefined,
      processedAt: row.processedAt ? new Date(row.processedAt) : undefined,
    });
  },

  ledgerToDomain(row: WalletLedgerEntryRow): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction as LedgerDirection,
      money: Money.from({ amount: formatScale2(row.amount), currency: row.currency }),
      balanceBefore: Money.from({ amount: formatScale2(row.balanceBefore), currency: row.currency }),
      balanceAfter: Money.from({ amount: formatScale2(row.balanceAfter), currency: row.currency }),
      createdAt: new Date(row.createdAt),
    });
  },

  inboxToDomain(row: InboxMessageRow): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: row.messageId,
      consumerName: row.consumerName,
      payloadHash: row.payloadHash,
      receivedAt: new Date(row.receivedAt),
      processedAt: row.processedAt ? new Date(row.processedAt) : undefined,
    });
  },

  outboxToDomain(row: OutboxMessageRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      occurredAt: new Date(row.occurredAt),
      attempts: Number(row.attempts),
      nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : undefined,
      publishedAt: row.publishedAt ? new Date(row.publishedAt) : undefined,
    });
  },
};

function formatScale2(val: string | number): string {
  const str = String(val);
  if (/^-?\d+\.\d{2}$/.test(str)) {
    return str;
  }
  const [intPart = "0", decPart = ""] = str.split(".");
  return `${intPart}.${(decPart + "00").slice(0, 2)}`;
}
