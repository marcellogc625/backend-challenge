import { MikroORM } from "@mikro-orm/postgresql";
import { buildMikroOrmOptions } from "../mikro-orm.config.ts";

async function run(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const orm = await MikroORM.init(buildMikroOrmOptions());

  try {
    const migrator = orm.migrator;
    if (command === "up") {
      const executed = await migrator.up();
      console.log(`Executed ${executed.length} migration(s).`);
    } else if (command === "down") {
      const reverted = await migrator.down();
      console.log(`Reverted ${reverted.length} migration(s).`);
    } else if (command === "status") {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      console.log({
        executed: executed.map((m) => m.name),
        pending: pending.map((m) => m.name),
      });
    } else {
      throw new Error(`Unknown migration command '${command}'. Use: up | down | status`);
    }
  } finally {
    await orm.close(true);
  }
}

run().catch((err) => {
  console.error("Migration CLI failed:", err);
  process.exit(1);
});
