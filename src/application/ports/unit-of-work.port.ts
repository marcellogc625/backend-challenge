import type {
  InboxRepositoryPort,
  OutboxRepositoryPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from "./repositories.port.ts";

export const UNIT_OF_WORK_PORT = Symbol("UNIT_OF_WORK_PORT");

export interface TransactionContext {
  readonly wallets: WalletRepositoryPort;
  readonly transactions: WagerTransactionRepositoryPort;
  readonly ledger: WalletLedgerRepositoryPort;
  readonly inbox: InboxRepositoryPort;
  readonly outbox: OutboxRepositoryPort;
}

export interface UnitOfWorkPort {
  /** Executa o callback dentro de uma transação PostgreSQL (BEGIN ... COMMIT/ROLLBACK). */
  runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;

  /** Acesso de leitura fora de transação explícita. */
  getReadContext(): TransactionContext;
}
