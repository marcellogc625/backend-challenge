import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min, ValidateNested } from "class-validator";

export class MoneyDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d+\.\d{2}$/, { message: "Amount must be a non-negative decimal string with exact scale of 2" })
  amount!: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: "Currency must be a valid ISO-4217 3-letter uppercase code" })
  currency!: string;
}

export class CreateWalletDto {
  @IsNotEmpty()
  @IsString()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  @IsNotEmpty()
  initialBalance!: MoneyDto;
}

export class GetLedgerQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @IsOptional()
  @IsString()
  cursor?: string;
}
