import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class MoneyAmountDto {
  // Minor units (cents). Positive integers only — direction comes from the route, not a sign.
  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
