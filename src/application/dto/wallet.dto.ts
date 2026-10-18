import type { MoneyProps } from "@domain/shared/money";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletResponseDto {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}
