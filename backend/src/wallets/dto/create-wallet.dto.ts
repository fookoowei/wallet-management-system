import { IsString, Length, MinLength } from 'class-validator';

export class CreateWalletDto {
  @IsString()
  @MinLength(1)
  name!: string;

  // ISO 4217 code, e.g. "USD". Fixed per wallet; conversion is M4d.
  @IsString()
  @Length(3, 3)
  currency!: string;
}
