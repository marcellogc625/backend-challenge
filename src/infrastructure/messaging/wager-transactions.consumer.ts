import type { ProcessWagerTransactionCommand } from "@application/dto/wager-transaction.dto.ts";
import { ProcessWagerTransactionUseCase } from "@application/use-cases/process-wager-transaction.use-case.ts";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { DomainError, IdempotencyConflictError } from "@domain/shared/domain-errors";
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createSqsClient, getSqsConfig, type SqsConfig } from "./sqs.config";

export interface SqsWagerMessageEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: ProcessWagerTransactionCommand;
}

@Injectable()
export class WagerTransactionsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly sqsClient: SQSClient;
  private readonly sqsConfig: SqsConfig;
  private isRunning = false;
  private loopPromise?: Promise<void>;

  constructor(private readonly processWagerTxUseCase: ProcessWagerTransactionUseCase) {
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
    this.sqsClient.destroy();
    if (this.loopPromise) {
      await Promise.race([this.loopPromise, new Promise((resolve) => setTimeout(resolve, 200))]);
    }
  }

  /**
   * Processa mensagens atualmente disponíveis na fila (útil para testes unitários/integração).
   */
  async pollAndProcessBatch(maxMessages = 10): Promise<number> {
    const response = await this.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: this.sqsConfig.queues.wagerTransactionsUrl,
        MaxNumberOfMessages: Math.min(maxMessages, 10),
        WaitTimeSeconds: 1, // Curto para execuções sob demanda
        VisibilityTimeout: 30,
        AttributeNames: ["All"],
      }),
    );
    const messages = response.Messages ?? [];
    for (const msg of messages) {
      await this.handleMessage(msg);
    }
    return messages.length;
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const response = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: this.sqsConfig.queues.wagerTransactionsUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 10, // Long-polling nativo
            VisibilityTimeout: 30,
            AttributeNames: ["All"],
          }),
        );
        const messages = response.Messages ?? [];
        for (const msg of messages) {
          if (!this.isRunning) {
            // Em shutdown, devolve imediatamente a mensagem para fila
            await this.releaseVisibility(msg);
            continue;
          }
          await this.handleMessage(msg);
        }
      } catch (err) {
        if (this.isRunning) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    }
  }

  private async handleMessage(sqsMsg: Message): Promise<void> {
    if (!sqsMsg.Body || !sqsMsg.ReceiptHandle) {
      return;
    }

    let envelope: SqsWagerMessageEnvelope;
    try {
      envelope = JSON.parse(sqsMsg.Body) as SqsWagerMessageEnvelope;
      if (!envelope.messageId || !envelope.data) {
        throw new Error("Missing required envelope fields");
      }
    } catch (parseError) {
      // Payload corrompido / JSON inválido permanente: envia para DLQ e descarta da fila principal
      await this.moveToDlq(sqsMsg, "Corrupted JSON payload");
      await this.ack(sqsMsg.ReceiptHandle);
      return;
    }

    try {
      await this.processWagerTxUseCase.execute(envelope.data, {
        correlationId: envelope.messageId,
        causationId: sqsMsg.MessageId,
        inboxMessage: {
          messageId: envelope.messageId,
          consumerName: "wager-transactions-consumer",
        },
      });

      // ACK somente após o sucesso do commit
      await this.ack(sqsMsg.ReceiptHandle);
    } catch (err) {
      if (err instanceof IdempotencyConflictError || err instanceof DomainError) {
        // Erro de domínio ou conflito permanente de regra: faz ACK para não travar a FIFO
        await this.ack(sqsMsg.ReceiptHandle);
      } else {
        // Erro transitório de infraestrutura: devolve visibilidade para o SQS redelivery
        await this.releaseVisibility(sqsMsg);
      }
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: this.sqsConfig.queues.wagerTransactionsUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private async releaseVisibility(sqsMsg: Message): Promise<void> {
    if (!sqsMsg.ReceiptHandle) return;
    try {
      await this.sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.sqsConfig.queues.wagerTransactionsUrl,
          ReceiptHandle: sqsMsg.ReceiptHandle,
          VisibilityTimeout: 0, // Libera visibilidade para outro worker imediatamente
        }),
      );
    } catch {
      // Ignora falha de liberação
    }
  }

  private async moveToDlq(sqsMsg: Message, reason: string): Promise<void> {
    try {
      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: this.sqsConfig.queues.wagerTransactionsDlqUrl,
          MessageBody: sqsMsg.Body,
          MessageGroupId: "corrupted-messages",
          MessageDeduplicationId: sqsMsg.MessageId ?? `dlq-${Date.now()}`,
          MessageAttributes: {
            DeadLetterReason: {
              DataType: "String",
              StringValue: reason,
            },
          },
        }),
      );
    } catch {
      // Ignora falha de envio manual caso a fila possua RedrivePolicy automática
    }
  }
}
