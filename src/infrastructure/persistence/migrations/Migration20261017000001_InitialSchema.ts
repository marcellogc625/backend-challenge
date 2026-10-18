import { Migration } from "@mikro-orm/migrations";

export class Migration20261017000001_InitialSchema extends Migration {
  override async up(): Promise<void> {
    // 1. Wallets
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id VARCHAR(128) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_amount NUMERIC(20, 2) NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1)
      );
    `);

    // 2. Wager Transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(128) NOT NULL,
        external_transaction_id VARCHAR(128) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        player_id VARCHAR(128) NOT NULL,
        round_id VARCHAR(128) NOT NULL,
        game_id VARCHAR(128) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        status VARCHAR(32) NOT NULL,
        reference_external_transaction_id VARCHAR(128) NULL,
        reference_transaction_id UUID NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        failure_code VARCHAR(64) NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_wager_tx_provider_ext UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT chk_wager_tx_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT chk_wager_tx_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT chk_wager_tx_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_wager_tx_amount_by_kind CHECK (
          (kind = 'LOSS' AND amount >= 0) OR
          (kind <> 'LOSS' AND amount > 0)
        ),
        CONSTRAINT chk_wager_tx_reference_required CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL) OR
          (kind NOT IN ('REFUND', 'ROLLBACK'))
        ),
        CONSTRAINT chk_wager_tx_processed_has_ref_id CHECK (
          NOT (status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NULL)
        )
      );
    `);

    // Impede que uma mesma transação referenciada seja revertida mais de uma vez com sucesso
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_processed_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);

    // Índices operacionais para consultas e reconciliação de PENDING_REFERENCE
    this.addSql(`
      CREATE INDEX idx_wager_tx_wallet_created
        ON wager_transactions (wallet_id, created_at DESC);

      CREATE INDEX idx_wager_tx_pending_reference_due
        ON wager_transactions (next_retry_at, created_at)
        WHERE status = 'PENDING_REFERENCE';
    `);

    // 3. Wallet Ledger Entries (Imutável / Append-Only)
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        direction VARCHAR(16) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before NUMERIC(20, 2) NOT NULL,
        balance_after NUMERIC(20, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_ledger_single_entry_per_tx UNIQUE (transaction_id),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT chk_ledger_arithmetic_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_cursor
        ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    // Trigger no banco para proibir UPDATE ou DELETE em wallet_ledger_entries
    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is forbidden', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wallet_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_wallet_ledger_mutation();
    `);

    // 4. Inbox Messages
    this.addSql(`
      CREATE TABLE inbox_messages (
        message_id VARCHAR(255) NOT NULL,
        consumer_name VARCHAR(128) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (message_id, consumer_name)
      );
    `);

    // 5. Outbox Messages
    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id VARCHAR(128) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL,
        CONSTRAINT chk_outbox_attempts_non_negative CHECK (attempts >= 0)
      );

      CREATE INDEX idx_outbox_unpublished_due
        ON outbox_messages (next_attempt_at ASC NULLS FIRST, occurred_at ASC)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages CASCADE;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_wallet_ledger_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallets CASCADE;`);
  }
}
