import { TransactionNotFoundError } from "@application/errors/application-errors.ts";
import { type UnitOfWorkPort, UNIT_OF_WORK_PORT } from "@application/ports/unit-of-work.port.ts";
import { ProcessWagerTransactionUseCase } from "@application/use-cases/process-wager-transaction.use-case.ts";
import { WagerTransactionStatus } from "@domain/wagering/wager-transaction.ts";
import { BadRequestException, Body, Controller, Get, Headers, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { SubmitWagerTransactionDto } from "../dto/wagering-request.dto.ts";
import { MetricsService } from "../metrics/metrics.service.ts";

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTxUseCase: ProcessWagerTransactionUseCase,
    private readonly metrics: MetricsService,
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Headers("x-correlation-id") correlationIdHeader: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res() res: Response,
  ): Promise<void> {
    const idempotencyKey = idempotencyKeyHeader ?? `${dto.providerId}:${dto.externalTransactionId}`;
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      throw new BadRequestException("Header 'Idempotency-Key' is required");
    }

    const correlationId = correlationIdHeader ?? idempotencyKey;
    const start = performance.now();

    const result = await this.processWagerTxUseCase.execute(
      {
        ...dto,
        idempotencyKey,
      },
      { correlationId },
    );

    const durationSeconds = (performance.now() - start) / 1000;
    this.metrics.transactionsTotal.inc({ kind: dto.kind, status: result.status, provider: dto.providerId });
    this.metrics.processingLatency.observe({ kind: dto.kind, status: result.status }, durationSeconds);

    if (result.idempotentReplay) {
      this.metrics.idempotentReplaysTotal.inc({ provider: dto.providerId });
    }

    // Mapeamento semântico de status HTTP
    if (result.status === WagerTransactionStatus.Processed) {
      res.status(HttpStatus.OK).json(result);
    } else if (result.status === WagerTransactionStatus.PendingReference) {
      res.status(HttpStatus.ACCEPTED).json(result);
    } else {
      // REJECTED por regras de negócio
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(result);
    }
  }

  @Get("wagering/transactions/:transactionId")
  async getTransactionById(@Param("transactionId", ParseUUIDPipe) id: string): Promise<unknown> {
    const readCtx = this.uow.getReadContext();
    const tx = await readCtx.transactions.findById(id);
    if (!tx) {
      throw new TransactionNotFoundError(id);
    }
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt?.toISOString(),
    };
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByExternalId(@Param("providerId") providerId: string, @Param("externalTransactionId") externalTransactionId: string): Promise<unknown> {
    const readCtx = this.uow.getReadContext();
    const tx = await readCtx.transactions.findByProviderAndExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt?.toISOString(),
    };
  }
}
