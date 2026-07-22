import { IsIn, IsInt, IsString, Min, MinLength } from 'class-validator';

export class AdjustmentDto {
  @IsIn(['credit', 'debit'])
  direction!: 'credit' | 'debit';

  @IsInt()
  @Min(1)
  amount!: number;

  // A reason is mandatory for a manual money change — this is the audit trail (M5 formalises it).
  @IsString()
  @MinLength(1)
  note!: string;
}
