import { Inject, Injectable } from "@nestjs/common";
import { WalletNotFoundError } from "../errors/application-errors.ts";
import { type LedgerPageResult } from "../ports/repositories.port.ts";
import { type UnitOfWorkPort, UNIT_OF_WORK_PORT } from "../ports/unit-of-work.port.ts";

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(walletId: string, limit: number, cursor?: string): Promise<LedgerPageResult> {
    const readCtx = this.uow.getReadContext();

    const wallet = await readCtx.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    return readCtx.ledger.listByWallet(walletId, limit, cursor);
  }
}
