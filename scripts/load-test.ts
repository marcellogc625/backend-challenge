import { performance } from "node:perf_hooks";
import { MikroORM } from "@mikro-orm/postgresql";
import { OpenWalletUseCase } from "../src/application/use-cases/open-wallet.use-case.ts";
import { ProcessWagerTransactionUseCase } from "../src/application/use-cases/process-wager-transaction.use-case.ts";
import { ReconcileWalletUseCase } from "../src/application/use-cases/reconcile-wallet.use-case.ts";
import { WagerTransactionKind } from "../src/domain/wagering/wager-transaction.ts";
import { buildMikroOrmOptions } from "../src/infrastructure/persistence/mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "../src/infrastructure/persistence/repositories/mikro-orm-unit-of-work.ts";

async function main(): Promise<void> {
  console.log("=== DISTRIBUTED WAGERING PROCESSOR: LOAD TEST ===");
  const orm = await MikroORM.init(buildMikroOrmOptions());
  const uow = new MikroOrmUnitOfWork(orm.em);

  const openWallet = new OpenWalletUseCase(uow);
  const processTx = new ProcessWagerTransactionUseCase(uow);
  const reconcile = new ReconcileWalletUseCase(uow);

  const totalWallets = 20;
  const iterationsPerWallet = 25;
  const totalOperations = totalWallets * iterationsPerWallet;
  const runId = Date.now();

  console.log(`Setting up ${totalWallets} test wallets with 1000.00 BRL (runId: ${runId})...`);
  const wallets = await Promise.all(
    Array.from({ length: totalWallets }, (_, i) =>
      openWallet.execute({
        playerId: `load-${runId}-player-${i}`,
        initialBalance: { amount: "1000.00", currency: "BRL" },
      }),
    ),
  );

  console.log(`Starting load test: ${totalOperations} transactions across ${totalWallets} concurrent workers...`);
  const latenciesMs: number[] = [];
  let successfulTxs = 0;
  let rejectedTxs = 0;
  let errorCount = 0;

  const startTime = performance.now();

  // Executa carga concorrente
  const workerPromises = wallets.map(async (wallet, wIdx) => {
    for (let j = 0; j < iterationsPerWallet; j++) {
      const txStart = performance.now();
      try {
        const res = await processTx.execute(
          {
            providerId: "load-prv",
            externalTransactionId: `load-tx-${runId}-${wIdx}-${j}`,
            idempotencyKey: `load-prv:load-tx-${runId}-${wIdx}-${j}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `round-${runId}-${j}`,
            gameId: "load-slots",
            kind: j % 2 === 0 ? WagerTransactionKind.Bet : WagerTransactionKind.Win,
            money: { amount: "10.00", currency: "BRL" },
          },
          { correlationId: `load-corr-${runId}-${wIdx}-${j}` },
        );

        const txDuration = performance.now() - txStart;
        latenciesMs.push(txDuration);

        if (res.status === "PROCESSED") {
          successfulTxs += 1;
        } else {
          rejectedTxs += 1;
        }
      } catch (err) {
        errorCount += 1;
      }
    }
  });

  await Promise.all(workerPromises);
  const totalDurationSeconds = (performance.now() - startTime) / 1000;
  const throughputRps = (totalOperations / totalDurationSeconds).toFixed(2);

  // Calcula percentis
  latenciesMs.sort((a, b) => a - b);
  const p50 = latenciesMs[Math.floor(latenciesMs.length * 0.5)]?.toFixed(2) ?? "0";
  const p95 = latenciesMs[Math.floor(latenciesMs.length * 0.95)]?.toFixed(2) ?? "0";
  const p99 = latenciesMs[Math.floor(latenciesMs.length * 0.99)]?.toFixed(2) ?? "0";

  const readCtx = uow.getReadContext();
  const pendingOutbox = await readCtx.outbox.countPending();
  const outboxLag = await readCtx.outbox.oldestPendingAgeSeconds();

  console.log("\n=== LOAD TEST RESULTS ===");
  console.log(`Environment:           Linux x86_64 / Bun ${Bun.version} / PostgreSQL 16 (Local Docker)`);
  console.log(`Total Operations:      ${totalOperations}`);
  console.log(`Duration:              ${totalDurationSeconds.toFixed(2)}s`);
  console.log(`Throughput:            ${throughputRps} ops/sec`);
  console.log(`Latency p50:           ${p50} ms`);
  console.log(`Latency p95:           ${p95} ms`);
  console.log(`Latency p99:           ${p99} ms`);
  console.log(`Successful Txs:        ${successfulTxs}`);
  console.log(`Rejected Txs:          ${rejectedTxs}`);
  console.log(`Unexpected Errors:     ${errorCount}`);
  console.log(`Pending Outbox Msgs:   ${pendingOutbox}`);
  console.log(`Outbox Lag:            ${outboxLag.toFixed(2)}s`);

  console.log("\nValidating ledger consistency across all wallets...");
  let allConsistent = true;
  for (const wallet of wallets) {
    const rec = await reconcile.execute(wallet.id);
    if (!rec.consistent) {
      allConsistent = false;
      console.error(`Inconsistency found in wallet ${wallet.id}:`, rec);
    }
  }

  console.log(`Global Ledger Consistency: ${allConsistent ? "PASS (100% Consistent)" : "FAIL"}`);

  await orm.close(true);
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
