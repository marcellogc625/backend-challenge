import { WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from "@domain/messaging/integration-events.ts";
import { OutboxMessage } from "@domain/messaging/outbox-message.ts";
import { FailureCode, InsufficientFundsError } from "@domain/shared/domain-errors.ts";
import { WagerTransactionKind } from "@domain/wagering/wager-transaction.ts";
import { LedgerDirection, type WalletLedgerEntry } from "@domain/wallet/wallet-ledger-entry.ts";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../ports/unit-of-work.port.ts";

const BASE_RETRY_BACKOFF_MS = 1_000;
const MAX_PENDING_REF_ATTEMPTS = 8;

@Injectable()
export class ReconcilePendingReferencesUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(limit = 50): Promise<{ reconciled: number; timedOut: number; retried: number }> {
    const now = new Date();
    let reconciled = 0;
    let timedOut = 0;
    let retried = 0;

    await this.uow.runInTransaction(async (tx) => {
      const records = await tx.transactions.claimDuePendingReferences(limit, now);

      for (const rec of records) {
        const wagerTx = rec.transaction;
        const refExtId = wagerTx.referenceExternalTransactionId;

        if (!refExtId) {
          continue;
        }

        const reference = await tx.transactions.findByProviderAndExternalId(wagerTx.providerId, refExtId);

        // Se encontrou a referência e ela já está processada
        if (reference && reference.status === "PROCESSED") {
          const wallet = await tx.wallets.findByIdForUpdate(wagerTx.walletId);
          if (!wallet) {
            continue;
          }

          let ledgerEntry: WalletLedgerEntry | null = null;
          try {
            const direction = wagerTx.ledgerDirectionFor(reference);
            const ledgerId = randomUUID();

            if (direction === LedgerDirection.Debit) {
              const code = wagerTx.kind === WagerTransactionKind.Rollback ? FailureCode.NegativeBalanceOnReversal : FailureCode.InsufficientFunds;

              ledgerEntry = wallet.debit({
                ledgerEntryId: ledgerId,
                transactionId: wagerTx.id,
                money: wagerTx.money,
                insufficientFundsCode: code,
                now,
              });
            } else {
              ledgerEntry = wallet.credit({
                ledgerEntryId: ledgerId,
                transactionId: wagerTx.id,
                money: wagerTx.money,
                now,
              });
            }
          } catch (err) {
            if (err instanceof InsufficientFundsError) {
              wagerTx.reject(err.failureCode, now);
              await tx.transactions.save(wagerTx);
              const rejectedEvt = WagerTransactionRejected.from(wagerTx, err.failureCode, {
                eventId: randomUUID(),
                correlationId: `reconcile:${wagerTx.id}`,
                causationId: wagerTx.id,
                occurredAt: now,
              });
              await tx.outbox.enqueue(OutboxMessage.enqueue(rejectedEvt));
              reconciled += 1;
              continue;
            }
            throw err;
          }

          wagerTx.markProcessed(reference.id, now);
          await tx.wallets.save(wallet);
          await tx.transactions.save(wagerTx);

          if (ledgerEntry) {
            await tx.ledger.insert(ledgerEntry);
            const balanceEvt = WalletBalanceChanged.from(wallet, ledgerEntry, {
              eventId: randomUUID(),
              correlationId: `reconcile:${wagerTx.id}`,
              causationId: wagerTx.id,
              occurredAt: now,
            });
            await tx.outbox.enqueue(OutboxMessage.enqueue(balanceEvt));
          }

          const processedEvt = WagerTransactionProcessed.from(wagerTx, wallet.balance.toJSON(), {
            eventId: randomUUID(),
            correlationId: `reconcile:${wagerTx.id}`,
            causationId: wagerTx.id,
            occurredAt: now,
          });
          await tx.outbox.enqueue(OutboxMessage.enqueue(processedEvt));
          reconciled += 1;
        } else if (rec.retryCount + 1 >= MAX_PENDING_REF_ATTEMPTS) {
          // Timeout de referência
          wagerTx.reject(FailureCode.ReferenceNotFoundTimeout, now);
          await tx.transactions.save(wagerTx);

          const rejectedEvt = WagerTransactionRejected.from(wagerTx, FailureCode.ReferenceNotFoundTimeout, {
            eventId: randomUUID(),
            correlationId: `reconcile:timeout:${wagerTx.id}`,
            causationId: wagerTx.id,
            occurredAt: now,
          });
          await tx.outbox.enqueue(OutboxMessage.enqueue(rejectedEvt));
          timedOut += 1;
        } else {
          // Agenda próximo retry com backoff exponencial
          const nextRetryCount = rec.retryCount + 1;
          const delayMs = BASE_RETRY_BACKOFF_MS * Math.pow(2, nextRetryCount - 1);
          const nextRetryAt = new Date(now.getTime() + delayMs);

          await tx.transactions.save(wagerTx, {
            retryCount: nextRetryCount,
            nextRetryAt,
          });
          retried += 1;
        }
      }
    });

    return { reconciled, timedOut, retried };
  }
}
