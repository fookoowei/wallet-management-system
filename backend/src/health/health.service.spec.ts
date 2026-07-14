import { Test } from '@nestjs/testing';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthService', () => {
  it('reports db "up" when the query succeeds', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) },
        },
      ],
    }).compile();

    const service = moduleRef.get(HealthService);
    const result = await service.check();
    expect(result).toEqual({ status: 'ok', db: 'up' });
  });

  it('reports db "down" when the query throws', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: { $queryRaw: jest.fn().mockRejectedValue(new Error('no db')) },
        },
      ],
    }).compile();

    const service = moduleRef.get(HealthService);
    const result = await service.check();
    expect(result).toEqual({ status: 'ok', db: 'down' });
  });
});
