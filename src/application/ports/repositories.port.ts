import type { InboxMessage } from "@domain/messaging/inbox-message";
import type { OutboxMessage } from "@domain/messaging/outbox-message";
import type { Money } from "@domain/shared/money";
import type { WagerTransaction, WagerTransactionKind } from "@domain/wagering/wager-transaction";
import type { Wallet } from "@domain/wallet/wallet";
import type { WalletLedgerEntry } from "@domain/wallet/wallet-ledger-entry";

export interface LedgerPageCursor {
  createdAt: string; // ISO-8601
  id: string;
}

export interface LedgerPageResult {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface PendingReferenceRecord {
  transaction: WagerTransaction;
  retryCount: number;
  nextRetryAt: Date;
}

export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByIdempotencyKeyForUpdate(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<WagerTransaction | null>;
  findAnyProcessedReversal(referenceTransactionId: string): Promise<WagerTransaction | null>;
  insert(transaction: WagerTransaction): Promise<void>;
  save(transaction: WagerTransaction, retryMeta?: { retryCount: number; nextRetryAt: Date }): Promise<void>;
  claimDuePendingReferences(limit: number, now: Date): Promise<PendingReferenceRecord[]>;
}

export interface WalletLedgerRepositoryPort {
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  insert(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, limit: number, cursor?: string): Promise<LedgerPageResult>;
  calculateWalletSummary(walletId: string, currency: string): Promise<{ netBalance: Money; entriesCount: number }>;
}

export interface InboxRepositoryPort {
  /**
   * Tenta inserir via INSERT ... ON CONFLICT DO NOTHING.
   * Retorna { inserted: true, message } na primeira vez,
   * ou { inserted: false, message: existente } em redelivery/concorrência.
   */
  tryAccept(message: InboxMessage): Promise<{ inserted: boolean; message: InboxMessage }>;
  markProcessed(messageId: string, consumerName: string, processedAt: Date): Promise<void>;
}

export interface OutboxRepositoryPort {
  enqueue(message: OutboxMessage): Promise<void>;
  enqueueMany(messages: OutboxMessage[]): Promise<void>;
  claimDueBatch(limit: number, now: Date): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  countPending(): Promise<number>;
  oldestPendingAgeSeconds(now?: Date): Promise<number>;
}
