import { InboxMessage } from "@domain/messaging/inbox-message.ts";
import {
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "@domain/messaging/integration-events.ts";
import { OutboxMessage } from "@domain/messaging/outbox-message.ts";
import { computeWagerPayloadHash } from "@domain/shared/canonical-hash.ts";
import { FailureCode, IdempotencyConflictError, InsufficientFundsError } from "@domain/shared/domain-errors.ts";
import { Money } from "@domain/shared/money.ts";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "@domain/wagering/wager-transaction.ts";
import { LedgerDirection, type WalletLedgerEntry } from "@domain/wallet/wallet-ledger-entry.ts";
import { Wallet } from "@domain/wallet/wallet.ts";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { type ProcessWagerTransactionCommand, type ProcessWagerTransactionResult, type TransactionExecutionContext } from "../dto/wager-transaction.dto.ts";
import { WalletNotFoundError } from "../errors/application-errors.ts";
import { type TransactionContext, UNIT_OF_WORK_PORT, type UnitOfWorkPort } from "../ports/unit-of-work.port.ts";

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(command: ProcessWagerTransactionCommand, context: TransactionExecutionContext): Promise<ProcessWagerTransactionResult> {
    const payloadHash = computeWagerPayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    return this.uow.runInTransaction(async (tx) => {
      const now = new Date();

      // 1. Deduplicação via Inbox se mensagem originada de fila
      if (context.inboxMessage) {
        const inbox = InboxMessage.receive({
          messageId: context.inboxMessage.messageId,
          consumerName: context.inboxMessage.consumerName,
          payloadHash,
          receivedAt: now,
        });

        const accepted = await tx.inbox.tryAccept(inbox);
        if (!accepted.inserted && accepted.message.isProcessed()) {
          // Mensagem já processada anteriormente: consulta resultado idempotente
          const existingTx = await tx.transactions.findByIdempotencyKey(command.idempotencyKey);
          if (existingTx) {
            const wallet = await tx.wallets.findById(command.walletId);
            return {
              transactionId: existingTx.id,
              status: existingTx.status,
              balance: wallet ? wallet.balance.toJSON() : command.money,
              idempotentReplay: true,
              failureCode: existingTx.failureCode,
            };
          }
        }
      }

      // 2. Verificação de Idempotência
      const existingTx = await tx.transactions.findByIdempotencyKeyForUpdate(command.idempotencyKey);
      if (existingTx) {
        if (!existingTx.matchesPayload(payloadHash)) {
          throw new IdempotencyConflictError(command.idempotencyKey);
        }

        const wallet = await tx.wallets.findById(command.walletId);
        return {
          transactionId: existingTx.id,
          status: existingTx.status,
          balance: wallet ? wallet.balance.toJSON() : command.money,
          idempotentReplay: true,
          failureCode: existingTx.failureCode,
        };
      }

      // 3. Bloqueio pessimista da Carteira (unidade de concorrência)
      const wallet = await tx.wallets.findByIdForUpdate(command.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(command.walletId);
      }

      const txMoney = Money.from(command.money);
      const transactionId = randomUUID();

      const wagerTx = WagerTransaction.create({
        id: transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: txMoney,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: now,
      });

      // 4. Validação e aplicação conforme tipo de operação
      const result = await this.applyTransaction(tx, wallet, wagerTx, command, context, now);

      // Marca inbox como processada se aplicável
      if (context.inboxMessage) {
        await tx.inbox.markProcessed(context.inboxMessage.messageId, context.inboxMessage.consumerName, now);
      }

      return result;
    });
  }

  private async applyTransaction(
    tx: TransactionContext,
    wallet: Wallet,
    wagerTx: WagerTransaction,
    cmd: ProcessWagerTransactionCommand,
    ctx: TransactionExecutionContext,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const eventsToPublish: IntegrationEvent<unknown>[] = [];

    // Verificação de inconsistência de jogador ou moeda
    if (wallet.playerId !== cmd.playerId) {
      wagerTx.reject(FailureCode.PlayerWalletMismatch, now);
      await tx.transactions.insert(wagerTx);
      const rejectedEvt = WagerTransactionRejected.from(wagerTx, FailureCode.PlayerWalletMismatch, {
        eventId: randomUUID(),
        correlationId: ctx.correlationId,
        causationId: wagerTx.id,
        occurredAt: now,
      });
      await tx.outbox.enqueue(OutboxMessage.enqueue(rejectedEvt));
      return {
        transactionId: wagerTx.id,
        status: WagerTransactionStatus.Rejected,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        failureCode: FailureCode.PlayerWalletMismatch,
      };
    }

    if (wallet.currency !== cmd.money.currency) {
      wagerTx.reject(FailureCode.CurrencyMismatch, now);
      await tx.transactions.insert(wagerTx);
      const rejectedEvt = WagerTransactionRejected.from(wagerTx, FailureCode.CurrencyMismatch, {
        eventId: randomUUID(),
        correlationId: ctx.correlationId,
        causationId: wagerTx.id,
        occurredAt: now,
      });
      await tx.outbox.enqueue(OutboxMessage.enqueue(rejectedEvt));
      return {
        transactionId: wagerTx.id,
        status: WagerTransactionStatus.Rejected,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        failureCode: FailureCode.CurrencyMismatch,
      };
    }

    // 4.1 Operação de LOSS (não move saldo nem gera ledger)
    if (wagerTx.kind === WagerTransactionKind.Loss) {
      wagerTx.markProcessed(undefined, now);
      await tx.transactions.insert(wagerTx);
      eventsToPublish.push(
        WagerTransactionProcessed.from(wagerTx, wallet.balance.toJSON(), {
          eventId: randomUUID(),
          correlationId: ctx.correlationId,
          causationId: wagerTx.id,
          occurredAt: now,
        }),
      );
      await this.saveOutbox(tx, eventsToPublish);
      return {
        transactionId: wagerTx.id,
        status: WagerTransactionStatus.Processed,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    // 4.2 Operações que exigem referência: REFUND e ROLLBACK
    let referenceTx: WagerTransaction | null = null;
    if (wagerTx.requiresReference()) {
      referenceTx = await tx.transactions.findByProviderAndExternalId(cmd.providerId, cmd.referenceExternalTransactionId!);

      // Referência ausente -> PENDING_REFERENCE
      if (!referenceTx) {
        wagerTx.markPendingReference();
        await tx.transactions.insert(wagerTx);
        eventsToPublish.push(
          WagerTransactionPendingReference.from(wagerTx, {
            eventId: randomUUID(),
            correlationId: ctx.correlationId,
            causationId: wagerTx.id,
            occurredAt: now,
          }),
        );
        await this.saveOutbox(tx, eventsToPublish);
        return {
          transactionId: wagerTx.id,
          status: WagerTransactionStatus.PendingReference,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
      }

      // Validações da referência
      const validationError = this.validateReference(wagerTx, referenceTx, wallet);
      if (validationError) {
        wagerTx.reject(validationError, now);
        await tx.transactions.insert(wagerTx);
        eventsToPublish.push(
          WagerTransactionRejected.from(wagerTx, validationError, {
            eventId: randomUUID(),
            correlationId: ctx.correlationId,
            causationId: wagerTx.id,
            occurredAt: now,
          }),
        );
        await this.saveOutbox(tx, eventsToPublish);
        return {
          transactionId: wagerTx.id,
          status: WagerTransactionStatus.Rejected,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
          failureCode: validationError,
        };
      }

      // Verificação de dupla reversão
      const existingReversal = await tx.transactions.findAnyProcessedReversal(referenceTx.id);
      if (existingReversal) {
        wagerTx.reject(FailureCode.DuplicateReversal, now);
        await tx.transactions.insert(wagerTx);
        eventsToPublish.push(
          WagerTransactionRejected.from(wagerTx, FailureCode.DuplicateReversal, {
            eventId: randomUUID(),
            correlationId: ctx.correlationId,
            causationId: wagerTx.id,
            occurredAt: now,
          }),
        );
        await this.saveOutbox(tx, eventsToPublish);
        return {
          transactionId: wagerTx.id,
          status: WagerTransactionStatus.Rejected,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
          failureCode: FailureCode.DuplicateReversal,
        };
      }
    }

    // 4.3 Movimentação financeira na Carteira e geração de Ledger
    let ledgerEntry: WalletLedgerEntry;
    try {
      const direction = wagerTx.ledgerDirectionFor(referenceTx ?? undefined);
      const ledgerEntryId = randomUUID();

      if (direction === LedgerDirection.Debit) {
        const insufficientCode = wagerTx.kind === WagerTransactionKind.Rollback ? FailureCode.NegativeBalanceOnReversal : FailureCode.InsufficientFunds;

        ledgerEntry = wallet.debit({
          ledgerEntryId,
          transactionId: wagerTx.id,
          money: wagerTx.money,
          insufficientFundsCode: insufficientCode,
          now,
        });
      } else {
        ledgerEntry = wallet.credit({
          ledgerEntryId,
          transactionId: wagerTx.id,
          money: wagerTx.money,
          now,
        });
      }
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        wagerTx.reject(err.failureCode, now);
        await tx.transactions.insert(wagerTx);
        eventsToPublish.push(
          WagerTransactionRejected.from(wagerTx, err.failureCode, {
            eventId: randomUUID(),
            correlationId: ctx.correlationId,
            causationId: wagerTx.id,
            occurredAt: now,
          }),
        );
        await this.saveOutbox(tx, eventsToPublish);
        return {
          transactionId: wagerTx.id,
          status: WagerTransactionStatus.Rejected,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
          failureCode: err.failureCode,
        };
      }
      throw err;
    }

    // 4.4 Sucesso: persiste wallet, transaction, ledger e outbox
    wagerTx.markProcessed(referenceTx ? referenceTx.id : undefined, now);

    eventsToPublish.push(
      WalletBalanceChanged.from(wallet, ledgerEntry, {
        eventId: randomUUID(),
        correlationId: ctx.correlationId,
        causationId: wagerTx.id,
        occurredAt: now,
      }),
      WagerTransactionProcessed.from(wagerTx, wallet.balance.toJSON(), {
        eventId: randomUUID(),
        correlationId: ctx.correlationId,
        causationId: wagerTx.id,
        occurredAt: now,
      }),
    );

    await tx.wallets.save(wallet);
    await tx.transactions.insert(wagerTx);
    await tx.ledger.insert(ledgerEntry);
    await this.saveOutbox(tx, eventsToPublish);

    return {
      transactionId: wagerTx.id,
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private validateReference(tx: WagerTransaction, ref: WagerTransaction, wallet: Wallet): FailureCode | null {
    if (ref.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }

    if (
      ref.providerId !== tx.providerId ||
      ref.playerId !== tx.playerId ||
      ref.walletId !== tx.walletId ||
      ref.roundId !== tx.roundId ||
      ref.money.currency !== tx.money.currency
    ) {
      return FailureCode.ReferenceContextMismatch;
    }

    if (tx.kind === WagerTransactionKind.Refund && ref.kind !== WagerTransactionKind.Bet) {
      return FailureCode.InvalidReferenceKind;
    }

    if (
      tx.kind === WagerTransactionKind.Rollback &&
      ref.kind !== WagerTransactionKind.Bet &&
      ref.kind !== WagerTransactionKind.Win &&
      ref.kind !== WagerTransactionKind.Refund
    ) {
      return FailureCode.InvalidReferenceKind;
    }

    if (!tx.money.equals(ref.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }

    return null;
  }

  private async saveOutbox(tx: TransactionContext, events: IntegrationEvent<unknown>[]): Promise<void> {
    const outboxMessages = events.map((evt) => OutboxMessage.enqueue(evt));
    await tx.outbox.enqueueMany(outboxMessages);
  }
}
