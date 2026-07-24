import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The ONLY place the app talks to an external FX provider. Isolated behind this seam so a
 * future swap (a keyed provider, a cache) is a one-file change that never touches wallet logic.
 * Fail-closed: any failure throws 503 and the caller moves no money.
 */
@Injectable()
export class RatesService {
  private readonly base = 'https://api.frankfurter.app';

  async getRate(from: string, to: string): Promise<Prisma.Decimal> {
    // No conversion needed — never bother the network.
    if (from === to) return new Prisma.Decimal(1);

    let res: Response;
    try {
      res = await fetch(`${this.base}/latest?base=${from}&symbols=${to}`);
    } catch {
      throw new ServiceUnavailableException('Exchange rate provider unavailable');
    }
    if (!res.ok) {
      throw new ServiceUnavailableException('Exchange rate provider unavailable');
    }

    const body = (await res.json()) as { rates?: Record<string, number> };
    const rate = body?.rates?.[to];
    if (rate == null) {
      throw new ServiceUnavailableException(`No exchange rate for ${from} -> ${to}`);
    }
    return new Prisma.Decimal(rate);
  }
}
