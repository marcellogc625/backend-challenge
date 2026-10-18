export abstract class ApplicationError extends Error {
  public readonly code: string;

  protected constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super("WALLET_NOT_FOUND", `Wallet '${walletId} was not found.`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(playerId: string, currency: string) {
    super("WALLET_ALREADY_EXISTS", `Wallet already exists for player '${playerId}' and currency '${currency}.'`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor(identifier: string) {
    super("TRANSACTION_NOT_FOUND", `Transaction '${identifier} was not found.`);
  }
}
