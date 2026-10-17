import { type FailureCode, InvalidMoneyError, InvalidTransactionRuleError, InvalidTransactionStateError } from "@domain/shared/domain-errors.ts";
import type { Money } from "@domain/shared/money.ts";
import { LedgerDirection } from "@domain/wallet/wallet-ledger-entry.ts";

export enum WagerTransactionKind {
  Opening = "OPENING", // interno: crédito de abertura da wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE", // aguardando a transação referenciada
  Processed = "PROCESSED", // aplicada (terminal)
  Rejected = "REJECTED", // violação de regra de negócio (terminal)
  Failed = "FAILED", // erro permanente de infraestrutura (terminal, auditável)
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind e proíbe OPENING externo. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionRuleError("OPENING transaction is internal only and cannot be submitted externally", "OPENING_NOT_ALLOWED");
    }

    if (
      (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) &&
      (!props.referenceExternalTransactionId || props.referenceExternalTransactionId.trim() === "")
    ) {
      throw new InvalidTransactionRuleError(`${props.kind} requires referenceExternalTransactionId`, "MISSING_REFERENCE_EXTERNAL_TRANSACTION_ID");
    }

    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidMoneyError(`Transaction of kind ${props.kind} requires a strictly positive amount`);
    }

    if (props.money.isNegative()) {
      throw new InvalidMoneyError("Transaction money cannot be negative");
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  /** Cria a transação interna OPENING (seção 9 - Criar wallet com initialBalance > 0). */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError("OPENING transaction requires positive initial balance");
    }

    const now = props.createdAt ?? new Date();
    return new WagerTransaction(
      props.id,
      "internal",
      `opening:${props.walletId}`,
      `internal:opening:${props.walletId}`,
      props.payloadHash,
      props.walletId,
      props.playerId,
      `opening:${props.walletId}`,
      "wallet-opening",
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      now,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      now,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date = new Date()): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);

    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionRuleError(`${this.kind} cannot be marked PROCESSED without a resolved referenceTransactionId`);
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);

    if (!this.requiresReference()) {
      throw new InvalidTransactionRuleError(`Only REFUND or ROLLBACK can transition to PENDING_REFERENCE (got ${this.kind})`);
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed || this._status === WagerTransactionStatus.Rejected || this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionRuleError("ROLLBACK requires the referenced transaction to determine ledger direction");
        }
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }
        if (reference.kind === WagerTransactionKind.Win || reference.kind === WagerTransactionKind.Refund) {
          return LedgerDirection.Debit;
        }
        throw new InvalidTransactionRuleError(`ROLLBACK cannot invert transaction of kind ${reference.kind}`);
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionRuleError("LOSS transaction does not affect balance or generate a ledger entry");
    }
  }

  private assertNotTerminal(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, target);
    }
  }
}
