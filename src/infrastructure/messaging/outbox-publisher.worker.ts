import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "@application/ports/unit-of-work.port";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createSqsClient, getSqsConfig, type SqsConfig } from "./sqs.config";

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly sqsClient: SQSClient;
  private readonly sqsConfig: SqsConfig;
  private isRunning = false;
  private loopPromise?: Promise<void>;

  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {
    this.sqsConfig = getSqsConfig();
    this.sqsClient = createSqsClient(this.sqsConfig);
  }

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
      await this.loopPromise;
    }
    this.sqsClient.destroy();
  }

  /**
   * Executa um ciclo de publicação para testes ou chamada síncrona.
   */
  async pollAndPublish(batchSize = 50): Promise<number> {
    const now = new Date();
    let publishedCount = 0;

    await this.uow.runInTransaction(async (tx) => {
      // Busca mensagens prontas com lock pessimista, evitando disputa entre workers.
      const messages = await tx.outbox.claimDueBatch(batchSize, now);

      for (const msg of messages) {
        try {
          await this.sqsClient.send(
            new SendMessageCommand({
              QueueUrl: this.sqsConfig.queues.integrationEventsUrl,
              MessageBody: JSON.stringify(msg.payload),
              MessageGroupId: msg.aggregateId, // Ordenação estrita por carteira
              MessageDeduplicationId: msg.id, // Deduplicação por ID do evento
            }),
          );
          msg.markPublished(new Date());
          await tx.outbox.save(msg);
          publishedCount += 1;
        } catch (error) {
          // Em caso de falha de envio para rede/SQS, calcula backoff exponencial.
          msg.scheduleRetry(new Date());
          await tx.outbox.save(msg);
        }
      }
    });
    return publishedCount;
  }

  private async runLoop(): Promise<void> {
    const pollinterval = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500);
    const batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 50);

    while (this.isRunning) {
      try {
        const count = await this.pollAndPublish(batchSize);
        // Se encontrou mensagens no lote, continua consumindo imediatamente.
        if (count === 0 && this.isRunning) {
          await new Promise((resolve) => setTimeout(resolve, pollinterval));
        }
      } catch (err) {
        if (this.isRunning) {
          await new Promise((resolve) => setTimeout(resolve, pollinterval * 2));
        }
      }
    }
  }
}
