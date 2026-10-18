import { Inject, Injectable } from "@nestjs/common";
import { type ReconcileWalletResult } from "../dto/wallet.dto.ts";
import { WalletNotFoundError } from "../errors/application-errors.ts";
import { type UnitOfWorkPort, UNIT_OF_WORK_PORT } from "../ports/unit-of-work.port.ts";

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    const readCtx = this.uow.getReadContext();

    const wallet = await readCtx.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const summary = await readCtx.ledger.calculateWalletSummary(wallet.id, wallet.currency);
    const difference = wallet.balance.subtract(summary.netBalance);
    const consistent = difference.isZero();

    return {
      walletId: wallet.id,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: summary.netBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.entriesCount,
    };
  }
}
