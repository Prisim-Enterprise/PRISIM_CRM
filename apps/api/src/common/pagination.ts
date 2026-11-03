import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize = 25;
}

export function paged<T>(items: T[], total: number, q: PageQuery) {
  return { items, total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

export const skipTake = (q: PageQuery) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
