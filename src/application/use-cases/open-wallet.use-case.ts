import type { OpenWalletCommand, WalletResponseDto } from "@application/dto/wallet.dto";
import { WalletAlreadyExistsError } from "@application/errors/application-errors";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "@application/ports/unit-of-work.port";
import { WalletBalanceChanged } from "@domain/messaging/integration-events";
import { OutboxMessage } from "@domain/messaging/outbox-message";
import { computeCanonicalHash } from "@domain/shared/canonical-hash";
import { Money } from "@domain/shared/money";
import { WagerTransaction } from "@domain/wagering/wager-transaction";
import { Wallet } from "@domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "@domain/wallet/wallet-ledger-entry";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

@Injectable()
export class OpenWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletResponseDto> {
    const initialMoney = Money.from(command.initialBalance);
    return this.uow.runInTransaction(async (tx) => {
      const existing = await tx.wallets.findByPlayerAndCurrency(command.playerId, initialMoney.currency);
      if (existing) {
        throw new WalletAlreadyExistsError(command.playerId, initialMoney.currency);
      }
      const walletId = randomUUID();
      const now = new Date();
      const wallet = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance: initialMoney,
        now,
      });
      await tx.wallets.insert(wallet);

      // Se initialBalance > 0, registra a transação interna 'OPENING' e o lançamento no ledger.
      if (initialMoney.isPositive()) {
        const openingTxId = randomUUID();
        const ledgerId = randomUUID();
        const payloadHash = computeCanonicalHash({
          internal: true,
          action: "OPENING",
          walletId,
          playerId: command.playerId,
          amount: initialMoney.amount,
          currency: initialMoney.currency,
        });
        const openingTx = WagerTransaction.createOpening({
          id: openingTxId,
          walletId,
          playerId: command.playerId,
          money: initialMoney,
          payloadHash,
          createdAt: now,
        });
        const ledgerEntry = WalletLedgerEntry.create({
          id: ledgerId,
          walletId,
          transactionId: openingTxId,
          direction: LedgerDirection.Credit,
          money: initialMoney,
          balanceBefore: Money.zero(initialMoney.currency),
          balanceAfter: initialMoney,
          createdAt: now,
        });
        const balanceChangedEvent = WalletBalanceChanged.from(wallet, ledgerEntry, {
          eventId: randomUUID(),
          correlationId: `open:${walletId}`,
          causationId: openingTxId,
          occurredAt: now,
        });

        await tx.transactions.insert(openingTx);
        await tx.ledger.insert(ledgerEntry);
        await tx.outbox.enqueue(OutboxMessage.enqueue(balanceChangedEvent));
      }
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
