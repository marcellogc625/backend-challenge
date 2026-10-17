import { describe, expect, it } from "bun:test";
import {
  CurrencyMismatchError,
  FailureCode,
  InsufficientFundsError,
  InvalidMoneyError,
  UnbalancedLedgerEntryError,
} from "@domain/shared/domain-errors.ts";
import { Money } from "@domain/shared/money.ts";
import { LedgerDirection, WalletLedgerEntry } from "@domain/wallet/wallet-ledger-entry.ts";
import { Wallet } from "@domain/wallet/wallet.ts";

describe("Wallet Aggregate & WalletLedgerEntry", () => {
  it("opens a wallet with initialBalance >= 0 and version = 1", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    expect(wallet.id).toBe("wallet-1");
    expect(wallet.playerId).toBe("player-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  it("rejects opening a wallet with negative initialBalance", () => {
    const negative = Money.from({ amount: "10.00", currency: "BRL" }).negate();
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: negative,
      }),
    ).toThrow(InvalidMoneyError);
  });

  it("debits and credits wallet, incrementing version on each balance change and producing balanced ledger entries", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const debitEntry = wallet.debit({
      ledgerEntryId: "le-1",
      transactionId: "tx-1",
      money: Money.from({ amount: "35.50", currency: "BRL" }),
    });

    expect(wallet.balance.amount).toBe("64.50");
    expect(wallet.version).toBe(2);
    expect(debitEntry.direction).toBe(LedgerDirection.Debit);
    expect(debitEntry.balanceBefore.amount).toBe("100.00");
    expect(debitEntry.balanceAfter.amount).toBe("64.50");
    expect(debitEntry.isBalanced()).toBe(true);

    const creditEntry = wallet.credit({
      ledgerEntryId: "le-2",
      transactionId: "tx-2",
      money: Money.from({ amount: "15.50", currency: "BRL" }),
    });

    expect(wallet.balance.amount).toBe("80.00");
    expect(wallet.version).toBe(3);
    expect(creditEntry.direction).toBe(LedgerDirection.Credit);
    expect(creditEntry.balanceBefore.amount).toBe("64.50");
    expect(creditEntry.balanceAfter.amount).toBe("80.00");
    expect(creditEntry.isBalanced()).toBe(true);
  });

  it("throws InsufficientFundsError with INSUFFICIENT_FUNDS by default when debit exceeds balance", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "20.00", currency: "BRL" }),
    });

    expect(() =>
      wallet.debit({
        ledgerEntryId: "le-1",
        transactionId: "tx-1",
        money: Money.from({ amount: "20.01", currency: "BRL" }),
      }),
    ).toThrow(InsufficientFundsError);

    // Balance and version remain untouched
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(1);
  });

  it("supports custom failureCode (NEGATIVE_BALANCE_ON_REVERSAL) when debiting for ROLLBACK of WIN/REFUND", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
    });

    try {
      wallet.debit({
        ledgerEntryId: "le-1",
        transactionId: "tx-rollback",
        money: Money.from({ amount: "50.00", currency: "BRL" }),
        insufficientFundsCode: FailureCode.NegativeBalanceOnReversal,
      });
      expect.unreachable("Should have thrown InsufficientFundsError");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientFundsError);
      expect((err as InsufficientFundsError).failureCode).toBe(FailureCode.NegativeBalanceOnReversal);
    }
  });

  it("rejects debit or credit with zero amount or mismatched currency", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    expect(() =>
      wallet.debit({
        ledgerEntryId: "le-1",
        transactionId: "tx-1",
        money: Money.zero("BRL"),
      }),
    ).toThrow(InvalidMoneyError);

    expect(() =>
      wallet.credit({
        ledgerEntryId: "le-2",
        transactionId: "tx-2",
        money: Money.zero("BRL"),
      }),
    ).toThrow(InvalidMoneyError);

    expect(() =>
      wallet.credit({
        ledgerEntryId: "le-3",
        transactionId: "tx-3",
        money: Money.from({ amount: "10.00", currency: "USD" }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("validates WalletLedgerEntry arithmetic invariant on creation", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "le-bad",
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "50.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "45.00", currency: "BRL" }),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });
});
