import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./domain-errors.ts";

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;
const NON_NEGATIVE_DECIMAL_2_REGEX = /^\d+\.\d{2}$/;
const SIGNED_DECIMAL_2_REGEX = /^-?\d+\.\d{2}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps, options?: { allowNegative?: boolean }): Money {
    if (!props || typeof props.amount !== "string" || typeof props.currency !== "string") {
      throw new InvalidMoneyError("Money requires string amount and currency");
    }

    if (!ISO_CURRENCY_REGEX.test(props.currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency code: '${props.currency}'`);
    }

    const allowNegative = options?.allowNegative ?? false;
    const pattern = allowNegative ? SIGNED_DECIMAL_2_REGEX : NON_NEGATIVE_DECIMAL_2_REGEX;

    if (!pattern.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid monetary amount '${props.amount}': must be a decimal string with exact scale of 2`);
    }

    if (props.amount === "-0.00") {
      throw new InvalidMoneyError("Negative zero '-0.00' is not allowed");
    }

    const decimalValue = new Decimal(props.amount);
    if (!decimalValue.isFinite()) {
      throw new InvalidMoneyError(`Amount '${props.amount}' must be finite`);
    }

    return new Money(decimalValue, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    if (this.value.isZero()) {
      return this;
    }
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
