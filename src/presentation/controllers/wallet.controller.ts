import { WalletNotFoundError } from "@application/errors/application-errors.ts";
import { type UnitOfWorkPort, UNIT_OF_WORK_PORT } from "@application/ports/unit-of-work.port.ts";
import { GetWalletLedgerUseCase } from "@application/use-cases/get-wallet-ledger.use-case.ts";
import { OpenWalletUseCase } from "@application/use-cases/open-wallet.use-case.ts";
import { ReconcileWalletUseCase } from "@application/use-cases/reconcile-wallet.use-case.ts";
import { Body, Controller, Get, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CreateWalletDto, GetLedgerQueryDto } from "../dto/wallet-request.dto.ts";

@Controller("wallets")
export class WalletController {
  constructor(
    private readonly openWalletUseCase: OpenWalletUseCase,
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  @Post()
  async openWallet(@Body() dto: CreateWalletDto, @Res() res: Response): Promise<void> {
    const result = await this.openWalletUseCase.execute(dto);
    res.status(HttpStatus.CREATED).json(result);
  }

  @Get(":walletId")
  async getWallet(@Param("walletId", ParseUUIDPipe) walletId: string): Promise<unknown> {
    const readCtx = this.uow.getReadContext();
    const wallet = await readCtx.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(":walletId/ledger")
  async getLedger(@Param("walletId", ParseUUIDPipe) walletId: string, @Query() query: GetLedgerQueryDto): Promise<unknown> {
    const page = await this.getWalletLedgerUseCase.execute(walletId, query.limit, query.cursor);
    return {
      items: page.items.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(":walletId/reconciliation")
  async reconcileWallet(@Param("walletId", ParseUUIDPipe) walletId: string): Promise<unknown> {
    return this.reconcileWalletUseCase.execute(walletId);
  }
}
