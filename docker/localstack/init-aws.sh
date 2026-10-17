#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "Criando filas de FIFO SQS na região ${REGION}..."

# 1. Dead Letter Queue (FIFO)
awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "MessageRetentionPeriod": "1209600"
  }'

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --region "${REGION}" \
  --queue-url "http://sqs.${REGION}.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

# 2. Main Wager Transactions Queue (FIFO) com RedrivePolicy (maxReceiveCount = 5)
awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"ReceiveMessageWaitTimeSeconds\": \"5\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }"

# 3. Integration Events Queue (FIFO) para o Transactional Outbox Publisher
awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name integration-events.fifo \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false"
  }'

echo "Filas SQS FIFO criadas!"