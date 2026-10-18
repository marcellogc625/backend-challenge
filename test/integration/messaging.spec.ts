import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { OpenWalletUseCase } from "@application/use-cases/open-wallet.use-case.ts";
import { ProcessWagerTransactionUseCase } from "@application/use-cases/process-wager-transaction.use-case.ts";
import { WagerTransactionKind, WagerTransactionStatus } from "@domain/wagering/wager-transaction.ts";
import { OutboxPublisherWorker } from "@infrastructure/messaging/outbox-publisher.worker.ts";
import { createSqsClient, getSqsConfig, type SqsConfig } from "@infrastructure/messaging/sqs.config.ts";
import {
  type SqsWagerMessageEnvelope,
  WagerTransactionsConsumer,
} from "@infrastructure/messaging/wager-transactions.consumer.ts";
import { buildMikroOrmOptions } from "@infrastructure/persistence/mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "@infrastructure/persistence/repositories/mikro-orm-unit-of-work.ts";

describe("Messaging Layer Integration Tests (LocalStack SQS & PostgreSQL)", () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  let sqsClient: SQSClient;
  let sqsConfig: SqsConfig;

  let openWalletUseCase: OpenWalletUseCase;
  let processWagerTxUseCase: ProcessWagerTransactionUseCase;
  let outboxPublisher: OutboxPublisherWorker;
  let consumer: WagerTransactionsConsumer;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    orm = await MikroORM.init(buildMikroOrmOptions());
    uow = new MikroOrmUnitOfWork(orm.em);

    sqsConfig = getSqsConfig();
    sqsClient = createSqsClient(sqsConfig);

    openWalletUseCase = new OpenWalletUseCase(uow);
    processWagerTxUseCase = new ProcessWagerTransactionUseCase(uow);
    outboxPublisher = new OutboxPublisherWorker(uow);
    consumer = new WagerTransactionsConsumer(processWagerTxUseCase);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
    sqsClient.destroy();
  });

  beforeEach(async () => {
    const conn = orm.em.getConnection();
    await conn.execute(`
      TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE;
    `);

    // Limpa filas do SQS antes de cada teste
    try {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: sqsConfig.queues.wagerTransactionsUrl }));
    } catch {}
    try {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: sqsConfig.queues.integrationEventsUrl }));
    } catch {}
  });

  it("consumes wager transaction from SQS FIFO, performs atomic DB commit, and ACKs message", async () => {
    const wallet = await openWalletUseCase.execute({
      playerId: "player-sqs-1",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const envelope: SqsWagerMessageEnvelope = {
      messageId: "sqs-msg-bet-001",
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "prv-sqs",
        externalTransactionId: "ext-sqs-bet-001",
        idempotencyKey: "prv-sqs:ext-sqs-bet-001",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "rnd-sqs-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
      },
    };

    // 1. Envia mensagem para a fila SQS FIFO
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: sqsConfig.queues.wagerTransactionsUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: envelope.messageId,
      }),
    );

    // 2. Consumidor processa lote
    const processedCount = await consumer.pollAndProcessBatch(1);
    expect(processedCount).toBe(1);

    // 3. Verifica que a carteira foi debitada e o inbox foi registrado no banco
    const readCtx = uow.getReadContext();
    const updatedWallet = await readCtx.wallets.findById(wallet.id);
    expect(updatedWallet?.balance.amount).toBe("75.00");

    const tx = await readCtx.transactions.findByIdempotencyKey(envelope.data.idempotencyKey);
    expect(tx?.status).toBe(WagerTransactionStatus.Processed);

    // 4. Verifica que a mensagem foi ACKada (removida da fila)
    const checkQueue = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: sqsConfig.queues.wagerTransactionsUrl,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(checkQueue.Messages?.length ?? 0).toBe(0);
  });

  it("publishes pending outbox messages to SQS FIFO and marks them as published in PostgreSQL", async () => {
    // Abrir wallet com saldo positivo gera evento na Outbox
    const wallet = await openWalletUseCase.execute({
      playerId: "player-sqs-2",
      initialBalance: { amount: "50.00", currency: "BRL" },
    });

    const readCtx = uow.getReadContext();
    const initialPending = await readCtx.outbox.countPending();
    expect(initialPending).toBeGreaterThanOrEqual(1);

    // Executa ciclo de publicação da outbox
    const publishedCount = await outboxPublisher.pollAndPublish(10);
    expect(publishedCount).toBeGreaterThanOrEqual(1);

    // Verifica que não há mais mensagens pendentes
    const finalPending = await readCtx.outbox.countPending();
    expect(finalPending).toBe(0);

    // Verifica que o evento chegou na fila integration-events.fifo
    const received = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: sqsConfig.queues.integrationEventsUrl,
        WaitTimeSeconds: 2,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toBeDefined();
    expect(received.Messages!.length).toBeGreaterThanOrEqual(1);

    const receivedPayload = JSON.parse(received.Messages![0]?.Body ?? "{}");
    expect(receivedPayload.eventType).toBe("WalletBalanceChanged");
    expect(receivedPayload.aggregateId).toBe(wallet.id);
  });
});
