import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListUsersQueryDto {
  // Query strings always arrive as text ("10", not 10). @Type tells the global
  // ValidationPipe (transform: true) to convert before @IsInt judges it.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100) // hard cap: a caller must never be able to ask for the whole table
  take?: number = 20;
}
