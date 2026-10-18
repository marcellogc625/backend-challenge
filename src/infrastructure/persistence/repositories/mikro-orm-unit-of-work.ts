import type {
  InboxRepositoryPort,
  LedgerPageCursor,
  LedgerPageResult,
  OutboxRepositoryPort,
  PendingReferenceRecord,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from "@application/ports/repositories.port.ts";
import type { TransactionContext, UnitOfWorkPort } from "@application/ports/unit-of-work.port.ts";
import type { InboxMessage } from "@domain/messaging/inbox-message.ts";
import type { OutboxMessage } from "@domain/messaging/outbox-message.ts";
import { Money } from "@domain/shared/money.ts";
import type { WagerTransaction, WagerTransactionKind } from "@domain/wagering/wager-transaction.ts";
import type { WalletLedgerEntry } from "@domain/wallet/wallet-ledger-entry.ts";
import type { Wallet } from "@domain/wallet/wallet.ts";
import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
  type InboxMessageRow,
  type OutboxMessageRow,
  PersistenceMappers,
  type WagerTransactionRow,
  type WalletLedgerEntryRow,
  WalletRow,
} from "../entities/persistence.entities.ts";

class MikroOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { id }, { refresh: true });
    return row ? PersistenceMappers.walletToDomain(row) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return row ? PersistenceMappers.walletToDomain(row) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { playerId, currency }, { refresh: true });
    return row ? PersistenceMappers.walletToDomain(row) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wallet.id, wallet.playerId, wallet.currency, wallet.balance.amount, wallet.version, wallet.createdAt, wallet.updatedAt],
    );
  }

  async save(wallet: Wallet): Promise<void> {
    await this.em.execute(
      `UPDATE wallets
          SET balance_amount = ?,
              version = ?,
              updated_at = ?
        WHERE id = ?`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id],
    );
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Record<string, unknown>[]>(`SELECT * FROM wager_transactions WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ? PersistenceMappers.transactionToDomain(mapTxRow(rows[0])) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM wager_transactions WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey],
    );
    return rows[0] ? PersistenceMappers.transactionToDomain(mapTxRow(rows[0])) : null;
  }

  async findByIdempotencyKeyForUpdate(idempotencyKey: string): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM wager_transactions WHERE idempotency_key = ? FOR UPDATE`,
      [idempotencyKey],
    );
    return rows[0] ? PersistenceMappers.transactionToDomain(mapTxRow(rows[0])) : null;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ? LIMIT 1`,
      [providerId, externalTransactionId],
    );
    return rows[0] ? PersistenceMappers.transactionToDomain(mapTxRow(rows[0])) : null;
  }

  async findProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM wager_transactions
        WHERE reference_transaction_id = ?
          AND status = 'PROCESSED'
          AND kind = ?
        LIMIT 1`,
      [referenceTransactionId, kind],
    );
    return rows[0] ? PersistenceMappers.transactionToDomain(mapTxRow(rows[0])) : null;
  }

  async findAnyProcessedReversal(referenceTransactionId: string): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM wager_transactions
        WHERE reference_transaction_id = ?
          AND status = 'PROCESSED'
          AND kind IN ('REFUND', 'ROLLBACK')
        LIMIT 1`,
      [referenceTransactionId],
    );
    return rows[0] ? PersistenceMappers.transactionToDomain(mapTxRow(rows[0])) : null;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
        reference_external_transaction_id, reference_transaction_id, failure_code,
        retry_count, next_retry_at, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.amount,
        tx.money.currency,
        tx.status,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        0,
        tx.status === "PENDING_REFERENCE" ? new Date(Date.now() + 1_000) : null,
        tx.createdAt,
        tx.processedAt ?? null,
      ],
    );
  }

  async save(tx: WagerTransaction, retryMeta?: { retryCount: number; nextRetryAt: Date }): Promise<void> {
    if (retryMeta) {
      await this.em.execute(
        `UPDATE wager_transactions
            SET status = ?,
                reference_transaction_id = ?,
                failure_code = ?,
                processed_at = ?,
                retry_count = ?,
                next_retry_at = ?
          WHERE id = ?`,
        [tx.status, tx.referenceTransactionId ?? null, tx.failureCode ?? null, tx.processedAt ?? null, retryMeta.retryCount, retryMeta.nextRetryAt, tx.id],
      );
      return;
    }

    await this.em.execute(
      `UPDATE wager_transactions
          SET status = ?,
              reference_transaction_id = ?,
              failure_code = ?,
              processed_at = ?,
              next_retry_at = NULL
        WHERE id = ?`,
      [tx.status, tx.referenceTransactionId ?? null, tx.failureCode ?? null, tx.processedAt ?? null, tx.id],
    );
  }

  async claimDuePendingReferences(limit: number, now: Date): Promise<PendingReferenceRecord[]> {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY next_retry_at ASC NULLS FIRST, created_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );

    return rows.map((raw) => {
      const mapped = mapTxRow(raw);
      return {
        transaction: PersistenceMappers.transactionToDomain(mapped),
        retryCount: Number(mapped.retryCount ?? 0),
        nextRetryAt: mapped.nextRetryAt ? new Date(mapped.nextRetryAt) : now,
      };
    });
  }
}

class MikroOrmWalletLedgerRepository implements WalletLedgerRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null> {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM wallet_ledger_entries WHERE transaction_id = ? LIMIT 1`,
      [transactionId],
    );
    return rows[0] ? PersistenceMappers.ledgerToDomain(mapLedgerRow(rows[0])) : null;
  }

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.amount,
        entry.money.currency,
        entry.balanceBefore.amount,
        entry.balanceAfter.amount,
        entry.createdAt,
      ],
    );
  }

  async listByWallet(walletId: string, limit: number, cursor?: string): Promise<LedgerPageResult> {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    const decoded = cursor ? decodeCursor(cursor) : null;

    const rows =
      decoded ?
        await this.em.execute<Record<string, unknown>[]>(
          `SELECT * FROM wallet_ledger_entries
            WHERE wallet_id = ?
              AND (created_at, id) < (?, ?::uuid)
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
          [walletId, new Date(decoded.createdAt), decoded.id, safeLimit + 1],
        )
      : await this.em.execute<Record<string, unknown>[]>(
          `SELECT * FROM wallet_ledger_entries
            WHERE wallet_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
          [walletId, safeLimit + 1],
        );

    const hasNext = rows.length > safeLimit;
    const sliced = hasNext ? rows.slice(0, safeLimit) : rows;
    const items = sliced.map((r) => PersistenceMappers.ledgerToDomain(mapLedgerRow(r)));
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasNext && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async calculateWalletSummary(walletId: string, currency: string): Promise<{ netBalance: Money; entriesCount: number }> {
    const rows = await this.em.execute<Array<{ net_amount: string; entries_count: string | number }>>(
      `SELECT
          COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0.00)::numeric(20,2) AS net_amount,
          COUNT(*)::int AS entries_count
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );

    const row = rows[0] ?? { net_amount: "0.00", entries_count: 0 };
    return {
      netBalance: Money.from({ amount: String(row.net_amount), currency }, { allowNegative: true }),
      entriesCount: Number(row.entries_count),
    };
  }
}

class MikroOrmInboxRepository implements InboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async tryAccept(message: InboxMessage): Promise<{ inserted: boolean; message: InboxMessage }> {
    const insertedRows = await this.em.execute<Record<string, unknown>[]>(
      `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (message_id, consumer_name) DO NOTHING
       RETURNING *`,
      [message.messageId, message.consumerName, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );

    if (insertedRows[0]) {
      return {
        inserted: true,
        message: PersistenceMappers.inboxToDomain(mapInboxRow(insertedRows[0])),
      };
    }

    const existingRows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM inbox_messages WHERE message_id = ? AND consumer_name = ? FOR UPDATE`,
      [message.messageId, message.consumerName],
    );

    const existing = existingRows[0];
    if (!existing) {
      throw new Error(`Inbox message (${message.consumerName}, ${message.messageId}) disappeared during conflict resolution`);
    }

    return {
      inserted: false,
      message: PersistenceMappers.inboxToDomain(mapInboxRow(existing)),
    };
  }

  async markProcessed(messageId: string, consumerName: string, processedAt: Date): Promise<void> {
    await this.em.execute(
      `UPDATE inbox_messages
          SET processed_at = ?
        WHERE message_id = ? AND consumer_name = ?`,
      [processedAt, messageId, consumerName],
    );
  }
}

class MikroOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt ?? message.occurredAt,
        message.publishedAt ?? null,
      ],
    );
  }

  async enqueueMany(messages: OutboxMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.enqueue(msg);
    }
  }

  async claimDueBatch(limit: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `SELECT * FROM outbox_messages
        WHERE published_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY next_attempt_at ASC NULLS FIRST, occurred_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );

    return rows.map((r) => PersistenceMappers.outboxToDomain(mapOutboxRow(r)));
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages
          SET attempts = ?,
              next_attempt_at = ?,
              published_at = ?
        WHERE id = ?`,
      [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, message.id],
    );
  }

  async countPending(): Promise<number> {
    const rows = await this.em.execute<Array<{ cnt: string | number }>>(
      `SELECT COUNT(*)::int AS cnt FROM outbox_messages WHERE published_at IS NULL`,
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async oldestPendingAgeSeconds(now: Date = new Date()): Promise<number> {
    const rows = await this.em.execute<Array<{ oldest: Date | string | null }>>(
      `SELECT MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
    );
    const oldest = rows[0]?.oldest;
    if (!oldest) {
      return 0;
    }
    return Math.max(0, (now.getTime() - new Date(oldest).getTime()) / 1000);
  }
}

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly em: EntityManager) {}

  async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.em.fork({ clear: true }).transactional(async (txEm) => {
      const ctx = this.createContext(txEm);
      return work(ctx);
    });
  }

  getReadContext(): TransactionContext {
    return this.createContext(this.em.fork({ clear: true }));
  }

  private createContext(em: EntityManager): TransactionContext {
    return {
      wallets: new MikroOrmWalletRepository(em),
      transactions: new MikroOrmWagerTransactionRepository(em),
      ledger: new MikroOrmWalletLedgerRepository(em),
      inbox: new MikroOrmInboxRepository(em),
      outbox: new MikroOrmOutboxRepository(em),
    };
  }
}

function encodeCursor(cursor: LedgerPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(encoded: string): LedgerPageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as LedgerPageCursor;
    if (!parsed.createdAt || !parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) {
      throw new Error("Invalid cursor fields");
    }
    return parsed;
  } catch {
    throw new Error("Invalid pagination cursor");
  }
}

function mapTxRow(raw: Record<string, unknown>): WagerTransactionRow {
  return {
    id: String(raw.id),
    providerId: String(raw.provider_id),
    externalTransactionId: String(raw.external_transaction_id),
    idempotencyKey: String(raw.idempotency_key),
    payloadHash: String(raw.payload_hash),
    walletId: String(raw.wallet_id),
    playerId: String(raw.player_id),
    roundId: String(raw.round_id),
    gameId: String(raw.game_id),
    kind: String(raw.kind),
    amount: String(raw.amount),
    currency: String(raw.currency),
    status: String(raw.status),
    referenceExternalTransactionId: (raw.reference_external_transaction_id as string | null) ?? null,
    referenceTransactionId: (raw.reference_transaction_id as string | null) ?? null,
    failureCode: (raw.failure_code as string | null) ?? null,
    retryCount: Number(raw.retry_count ?? 0),
    nextRetryAt: raw.next_retry_at ? new Date(String(raw.next_retry_at)) : null,
    createdAt: new Date(String(raw.created_at)),
    processedAt: raw.processed_at ? new Date(String(raw.processed_at)) : null,
  };
}

function mapLedgerRow(raw: Record<string, unknown>): WalletLedgerEntryRow {
  return {
    id: String(raw.id),
    walletId: String(raw.wallet_id),
    transactionId: String(raw.transaction_id),
    direction: String(raw.direction),
    amount: String(raw.amount),
    currency: String(raw.currency),
    balanceBefore: String(raw.balance_before),
    balanceAfter: String(raw.balance_after),
    createdAt: new Date(String(raw.created_at)),
  };
}

function mapInboxRow(raw: Record<string, unknown>): InboxMessageRow {
  return {
    messageId: String(raw.message_id),
    consumerName: String(raw.consumer_name),
    payloadHash: String(raw.payload_hash),
    receivedAt: new Date(String(raw.received_at)),
    processedAt: raw.processed_at ? new Date(String(raw.processed_at)) : null,
  };
}

function mapOutboxRow(raw: Record<string, unknown>): OutboxMessageRow {
  return {
    id: String(raw.id),
    aggregateId: String(raw.aggregate_id),
    eventType: String(raw.event_type),
    payload: typeof raw.payload === "string" ? JSON.parse(raw.payload) : (raw.payload as Record<string, unknown>),
    occurredAt: new Date(String(raw.occurred_at)),
    attempts: Number(raw.attempts ?? 0),
    nextAttemptAt: raw.next_attempt_at ? new Date(String(raw.next_attempt_at)) : null,
    publishedAt: raw.published_at ? new Date(String(raw.published_at)) : null,
  };
}
