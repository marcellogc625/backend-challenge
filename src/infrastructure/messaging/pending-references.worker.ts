import { ReconcilePendingReferencesUseCase } from "@application/use-cases/reconcile-pending-references.use-case.ts";
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

@Injectable()
export class PendingReferencesWorker implements OnModuleInit, OnModuleDestroy {
  private isRunning = false;
  private loopPromise?: Promise<void>;

  constructor(private readonly reconcilePendingRefUseCase: ReconcilePendingReferencesUseCase) {}

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.loopPromise) {
      await Promise.race([this.loopPromise, new Promise((resolve) => setTimeout(resolve, 200))]);
    }
  }

  async runOnce(batchSize = 50): Promise<{ reconciled: number; timedOut: number; retried: number }> {
    return this.reconcilePendingRefUseCase.execute(batchSize);
  }

  private async runLoop(): Promise<void> {
    const pollInterval = Number(process.env.PENDING_REF_POLL_INTERVAL_MS ?? 1_000);

    while (this.isRunning) {
      try {
        await this.runOnce();
      } catch (err) {
        // Erro transitório no ciclo: aguarda intervalo
      }

      if (this.isRunning) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }
  }
}
