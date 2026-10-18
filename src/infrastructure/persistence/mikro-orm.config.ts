import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { InboxMessageSchema, OutboxMessageSchema, WagerTransactionSchema, WalletLedgerEntrySchema, WalletSchema } from "./entities/persistence.entities.ts";
import { Migration20261017000001_InitialSchema } from "./migrations/Migration20261017000001_InitialSchema.ts";

export function buildMikroOrmOptions(overrides?: Partial<Options>): Options {
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = Number(process.env.POSTGRES_PORT ?? 5430);
  const user = process.env.POSTGRES_USER ?? "postgres";
  const password = process.env.POSTGRES_PASSWORD ?? "postgres";
  const dbName = process.env.NODE_ENV === "test" ? (process.env.POSTGRES_TEST_DB ?? "wagering_test") : (process.env.POSTGRES_DB ?? "wagering");

  return defineConfig({
    host,
    port,
    user,
    password,
    dbName,
    entities: [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema],
    extensions: [Migrator],
    migrations: {
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      migrationsList: [
        {
          name: "Migration20261017000001_InitialSchema",
          class: Migration20261017000001_InitialSchema,
        },
      ],
    },
    pool: {
      min: 2,
      max: Number(process.env.DB_POOL_MAX ?? 20),
    },
    ...overrides,
  });
}

export default buildMikroOrmOptions();
