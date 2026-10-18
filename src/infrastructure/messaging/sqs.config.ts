import { SQSClient } from "@aws-sdk/client-sqs";

export interface SqsConfig {
  region: string;
  endpoint: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  queues: {
    wagerTransactionsUrl: string;
    wagerTransactionsDlqUrl: string;
    integrationEventsUrl: string;
  };
}

export function getSqsConfig(): SqsConfig {
  const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
  const region = process.env.AWS_REGION ?? "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "test";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "test";

  // Normalização de URLs caso o LocalStack retorne hosts externos
  const resolveQueueUrl = (envUrl: string | undefined, defaultQueueName: string): string => {
    if (envUrl) {
      return envUrl.replace(/http:\/\/[^/]+(:4566)?/, endpoint.replace(/\/$/, ""));
    }
    return `${endpoint.replace(/\/$/, "")}/000000000000/${defaultQueueName}`;
  };
  return {
    region,
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    queues: {
      wagerTransactionsUrl: resolveQueueUrl(process.env.SQS_WAGER_QUEUE_URL, process.env.SQS_WAGER_QUEUE_NAME ?? "wager-transactions.fifo"),
      wagerTransactionsDlqUrl: resolveQueueUrl(process.env.SQS_WAGER_DLQ_URL, process.env.SQS_WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo"),
      integrationEventsUrl: resolveQueueUrl(
        process.env.SQS_INTEGRATION_EVENTS_QUEUE_URL,
        process.env.SQS_INTEGRATION_EVENTS_QUEUE_NAME ?? "integration-events.fifo",
      ),
    },
  };
}

export function createSqsClient(config: SqsConfig = getSqsConfig()): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: config.credentials,
  });
}
