import { describe, it, expect, beforeEach } from 'vitest';
import { withSiteRateLimit, withSiteRateLimitBatch, __clearSiteRateLimiterForTests } from './siteRateLimiter.js';

describe('siteRateLimiter', () => {
  beforeEach(() => {
    __clearSiteRateLimiterForTests();
  });

  it('executes operations sequentially for the same site', async () => {
    const executionOrder: number[] = [];
    const delayMs = 50;

    const promises = [
      withSiteRateLimit(1, 101, async () => {
        executionOrder.push(1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'result1';
      }, delayMs),
      withSiteRateLimit(1, 102, async () => {
        executionOrder.push(2);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'result2';
      }, delayMs),
      withSiteRateLimit(1, 103, async () => {
        executionOrder.push(3);
        return 'result3';
      }, delayMs),
    ];

    const results = await Promise.all(promises);

    expect(results).toEqual(['result1', 'result2', 'result3']);
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it('executes operations in parallel for different sites', async () => {
    const executionTimes = new Map<number, number>();
    const startTime = Date.now();

    const promises = [
      withSiteRateLimit(1, 101, async () => {
        executionTimes.set(101, Date.now() - startTime);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'site1-account1';
      }, 100),
      withSiteRateLimit(2, 201, async () => {
        executionTimes.set(201, Date.now() - startTime);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'site2-account1';
      }, 100),
      withSiteRateLimit(3, 301, async () => {
        executionTimes.set(301, Date.now() - startTime);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'site3-account1';
      }, 100),
    ];

    const results = await Promise.all(promises);

    expect(results).toHaveLength(3);
    // All three should start roughly at the same time (within 50ms of each other)
    const times = Array.from(executionTimes.values());
    const maxDiff = Math.max(...times) - Math.min(...times);
    expect(maxDiff).toBeLessThan(50);
  });

  it('respects delay between operations on the same site', async () => {
    const executionTimes: number[] = [];
    const startTime = Date.now();
    const delayMs = 100;

    const promises = [
      withSiteRateLimit(1, 101, async () => {
        executionTimes.push(Date.now() - startTime);
        return 1;
      }, delayMs),
      withSiteRateLimit(1, 102, async () => {
        executionTimes.push(Date.now() - startTime);
        return 2;
      }, delayMs),
      withSiteRateLimit(1, 103, async () => {
        executionTimes.push(Date.now() - startTime);
        return 3;
      }, delayMs),
    ];

    await Promise.all(promises);

    expect(executionTimes).toHaveLength(3);
    // Second operation should start at least delayMs after first
    expect(executionTimes[1]! - executionTimes[0]!).toBeGreaterThanOrEqual(delayMs - 10);
    // Third operation should start at least delayMs after second
    expect(executionTimes[2]! - executionTimes[1]!).toBeGreaterThanOrEqual(delayMs - 10);
  });

  it('handles errors without blocking the queue', async () => {
    const results: Array<string | Error> = [];

    const promises = [
      withSiteRateLimit(1, 101, async () => {
        return 'success1';
      }, 50).then((r) => {
        results.push(r);
        return r;
      }).catch((e) => {
        results.push(e);
        throw e;
      }),
      withSiteRateLimit(1, 102, async () => {
        throw new Error('intentional error');
      }, 50).then((r) => {
        results.push(r);
        return r;
      }).catch((e) => {
        results.push(e);
        return e;
      }),
      withSiteRateLimit(1, 103, async () => {
        return 'success3';
      }, 50).then((r) => {
        results.push(r);
        return r;
      }).catch((e) => {
        results.push(e);
        throw e;
      }),
    ];

    await Promise.all(promises.map((p) => p.catch(() => {})));

    expect(results).toHaveLength(3);
    expect(results[0]).toBe('success1');
    expect(results[1]).toBeInstanceOf(Error);
    expect(results[2]).toBe('success3');
  });

  it('withSiteRateLimitBatch groups by site and respects delays', async () => {
    const executionOrder: number[] = [];
    const startTime = Date.now();
    const delayMs = 50;

    const items = [
      { siteId: 1, accountId: 101, data: { value: 1 } },
      { siteId: 1, accountId: 102, data: { value: 2 } },
      { siteId: 2, accountId: 201, data: { value: 3 } },
      { siteId: 2, accountId: 202, data: { value: 4 } },
    ];

    const results = await withSiteRateLimitBatch(
      items,
      async (item, accountId) => {
        const elapsed = Date.now() - startTime;
        executionOrder.push(accountId);
        return { accountId, value: item.value, elapsed };
      },
      delayMs,
    );

    expect(results).toHaveLength(4);
    
    // Site 1 accounts should be sequential
    const site1Results = results.filter((r) => r.accountId === 101 || r.accountId === 102);
    expect(site1Results[1]!.elapsed - site1Results[0]!.elapsed).toBeGreaterThanOrEqual(delayMs - 10);

    // Site 2 accounts should be sequential
    const site2Results = results.filter((r) => r.accountId === 201 || r.accountId === 202);
    expect(site2Results[1]!.elapsed - site2Results[0]!.elapsed).toBeGreaterThanOrEqual(delayMs - 10);
  });
});
