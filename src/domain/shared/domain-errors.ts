export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  NegativeBalanceOnReversal = "NEGATIVE_BALANCE_ON_REVERSAL",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  ReferenceNotFoundTimeout = "REFERENCE_NOT_FOUND_TIMEOUT",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceContextMismatch = "REFERENCE_CONTEXT_MISMATCH",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  DuplicateReversal = "DUPLICATE_REVERSAL",
  InfrastructureFailure = "INFRASTRUCTURE_FAILURE",
}

export abstract class DomainError extends Error {
  public readonly code: string;

  protected constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super("INVALID_MONEY", message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(FailureCode.CurrencyMismatch, `Currency Mismatch: expected ${expected}, received ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  public readonly failureCode: FailureCode;

  constructor(message = "Insufficient wallet balance", failureCode: FailureCode = FailureCode.InsufficientFunds) {
    super(failureCode, message);
    this.failureCode = failureCode;
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(currentStatus: string, targetStatus: string) {
    super("INVALID_TRANSACTION_STATE", `Cannot transition transaction from ${currentStatus} to ${targetStatus}`);
  }
}

export class InvalidTransactionRuleError extends DomainError {
  constructor(message: string, code = "INVALID_TRANSACTION_RULE") {
    super(code, message);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  constructor(message = "Ledger entry arithmetic is unbalanced.") {
    super("UNBALANCED_LEDGER_ENTRY", message);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super("IDEMPOTENCY_CONFLICT", `Idempotency key '${idempotencyKey}' was already used with a different payload`);
  }
}
