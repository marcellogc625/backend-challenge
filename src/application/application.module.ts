import { Global, Module } from "@nestjs/common";
import { GetWalletLedgerUseCase } from "./use-cases/get-wallet-ledger.use-case.ts";
import { OpenWalletUseCase } from "./use-cases/open-wallet.use-case.ts";
import { ProcessWagerTransactionUseCase } from "./use-cases/process-wager-transaction.use-case.ts";
import { ReconcilePendingReferencesUseCase } from "./use-cases/reconcile-pending-references.use-case.ts";
import { ReconcileWalletUseCase } from "./use-cases/reconcile-wallet.use-case.ts";

@Global()
@Module({
  providers: [
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    GetWalletLedgerUseCase,
    ReconcileWalletUseCase,
    ReconcilePendingReferencesUseCase,
  ],
  exports: [
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    GetWalletLedgerUseCase,
    ReconcileWalletUseCase,
    ReconcilePendingReferencesUseCase,
  ],
})
export class ApplicationModule {}
