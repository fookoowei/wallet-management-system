import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class TransferDto {
  // Validated as a UUID here so a malformed id fails at the boundary, not in the DB.
  @IsUUID()
  toWalletId!: string;

  // Minor units (cents). Positive integers only — direction comes from the route.
  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
