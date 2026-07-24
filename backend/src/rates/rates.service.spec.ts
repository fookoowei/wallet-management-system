import { ServiceUnavailableException } from '@nestjs/common';
import { RatesService } from './rates.service';

// A minimal stand-in for the parts of the fetch Response we use.
const fakeResponse = (body: any, ok = true) =>
  ({ ok, json: () => Promise.resolve(body) }) as unknown as Response;

describe('RatesService', () => {
  const service = new RatesService();

  afterEach(() => jest.restoreAllMocks());

  it('parses the rate for the requested pair', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse({ rates: { EUR: 0.9234 } }));
    const rate = await service.getRate('USD', 'EUR');
    expect(rate.toString()).toBe('0.9234');
  });

  it('short-circuits same-currency to 1 without hitting the network', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const rate = await service.getRate('USD', 'USD');
    expect(rate.toString()).toBe('1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws 503 when the provider returns a non-200', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse({}, false));
    await expect(service.getRate('USD', 'EUR')).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws 503 when the network call itself fails', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.getRate('USD', 'EUR')).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws 503 when the pair is absent from the response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse({ rates: {} }));
    await expect(service.getRate('USD', 'XYZ')).rejects.toThrow(ServiceUnavailableException);
  });
});
