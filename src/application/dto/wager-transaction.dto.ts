import type { FailureCode } from "@domain/shared/domain-errors";
import type { MoneyProps } from "@domain/shared/money";
import type { WagerTransactionKind, WagerTransactionStatus } from "@domain/wagering/wager-transaction";

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface TransactionExecutionContext {
  correlationId: string;
  causationId?: string;
  inboxMessage?: {
    messageId: string;
    consumerName: string;
  };
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}
