import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

@Injectable()
export class MetricsService {
  public readonly registry = new Registry();

  public readonly transactionsTotal = new Counter({
    name: "wagering_transactions_total",
    help: "Total wager transactions processed by kind and status",
    labelNames: ["kind", "status", "provider"],
    registers: [this.registry],
  });

  public readonly idempotentReplaysTotal = new Counter({
    name: "wagering_idempotent_replays_total",
    help: "Total idempotent replays detected",
    labelNames: ["provider"],
    registers: [this.registry],
  });

  public readonly processingLatency = new Histogram({
    name: "wagering_transaction_duration_seconds",
    help: "Latency of wager transaction processing in seconds",
    labelNames: ["kind", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  public readonly outboxLagGauge = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age in seconds of the oldest pending outbox message",
    registers: [this.registry],
  });

  public readonly outboxPendingCount = new Gauge({
    name: "wagering_outbox_pending_count",
    help: "Number of pending outbox messages waiting to be published",
    registers: [this.registry],
  });

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
