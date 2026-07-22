import { IsOptional, IsString } from 'class-validator';

export class RejectDto {
  @IsOptional()
  @IsString()
  note?: string;
}
