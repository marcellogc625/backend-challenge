import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "@domain/shared/domain-errors.ts";
import { Money } from "@domain/shared/money.ts";

describe("Money Value Object", () => {
  it("creates valid Money with scale 2 and ISO-4217 currency", () => {
    const money = Money.from({ amount: "125.50", currency: "BRL" });
    expect(money.amount).toBe("125.50");
    expect(money.currency).toBe("BRL");
    expect(money.isPositive()).toBe(true);
    expect(money.isZero()).toBe(false);
    expect(money.isNegative()).toBe(false);
    expect(money.toJSON()).toEqual({ amount: "125.50", currency: "BRL" });
    expect(money.toString()).toBe("125.50 BRL");
  });

  it("creates zero Money using Money.zero()", () => {
    const zero = Money.zero("USD");
    expect(zero.amount).toBe("0.00");
    expect(zero.currency).toBe("USD");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(zero.negate().equals(zero)).toBe(true);
  });

  it("rejects invalid decimal strings, wrong scales, scientific notation, NaN, Infinity, and -0.00", () => {
    const invalidAmounts = [
      "",
      "10",
      "10.5",
      "10.500",
      "1e2",
      "10.00e0",
      "NaN",
      "Infinity",
      "-Infinity",
      "-0.00",
      "-10.00",
      "abc",
      " 10.00",
      "10.00 ",
    ];

    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    }
  });

  it("allows negative amounts only when allowNegative is true (except -0.00)", () => {
    const neg = Money.from({ amount: "-15.25", currency: "BRL" }, { allowNegative: true });
    expect(neg.amount).toBe("-15.25");
    expect(neg.isNegative()).toBe(true);
    expect(() => Money.from({ amount: "-0.00", currency: "BRL" }, { allowNegative: true })).toThrow(InvalidMoneyError);
  });

  it("rejects invalid ISO-4217 currency codes", () => {
    const invalidCurrencies = ["", "brl", "BR", "BRLL", "123", "B$L"];
    for (const currency of invalidCurrencies) {
      expect(() => Money.from({ amount: "10.00", currency })).toThrow(InvalidMoneyError);
    }
  });

  it("performs exact decimal arithmetic without IEEE-754 floating-point drift", () => {
    const a = Money.from({ amount: "0.10", currency: "BRL" });
    const b = Money.from({ amount: "0.20", currency: "BRL" });
    const sum = a.add(b);

    expect(sum.amount).toBe("0.30");
    expect(sum.subtract(a).equals(b)).toBe(true);
    // Immutability check
    expect(a.amount).toBe("0.10");
    expect(b.amount).toBe("0.20");
  });

  it("negates positive money into negative money", () => {
    const pos = Money.from({ amount: "42.10", currency: "EUR" });
    const neg = pos.negate();
    expect(neg.amount).toBe("-42.10");
    expect(neg.isNegative()).toBe(true);
  });

  it("throws CurrencyMismatchError when operating on different currencies", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });
});
