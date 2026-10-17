import { CurrencyMismatchError, FailureCode, InsufficientFundsError, InvalidMoneyError } from "@domain/shared/domain-errors.ts";
import type { Money } from "@domain/shared/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.ts";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  insufficientFundsCode?: FailureCode;
  now?: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("Initial wallet balance cannot be negative");
    }

    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidMoneyError("Debit amount must be strictly positive");
    }

    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(
        `Insufficient balance: have ${this._balance.toString()}, needed ${props.money.toString()}`,
        props.insufficientFundsCode ?? FailureCode.InsufficientFunds,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(props.money);
    const now = props.now ?? new Date();

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidMoneyError("Credit amount must be strictly positive");
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(props.money);
    const now = props.now ?? new Date();

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
