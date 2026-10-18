import { WagerTransactionKind } from "@domain/wagering/wager-transaction.ts";
import { Type } from "class-transformer";
import { IsEnum, IsNotEmpty, IsOptional, IsString, ValidateNested } from "class-validator";
import { MoneyDto } from "./wallet-request.dto.ts";

export class SubmitWagerTransactionDto {
  @IsNotEmpty()
  @IsString()
  providerId!: string;

  @IsNotEmpty()
  @IsString()
  externalTransactionId!: string;

  @IsNotEmpty()
  @IsString()
  playerId!: string;

  @IsNotEmpty()
  @IsString()
  walletId!: string;

  @IsNotEmpty()
  @IsString()
  roundId!: string;

  @IsNotEmpty()
  @IsString()
  gameId!: string;

  @IsNotEmpty()
  @IsEnum(WagerTransactionKind, {
    message: "Kind must be one of: BET, WIN, LOSS, REFUND, ROLLBACK",
  })
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  @IsNotEmpty()
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}
