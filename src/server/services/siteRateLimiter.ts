/**
 * Site-level rate limiter to prevent IP bans from upstream providers.
 * Ensures sequential execution of operations (checkin, balance refresh, model refresh)
 * for accounts on the same site with configurable delays between requests.
 */

type SiteOperationQueue = {
  running: boolean;
  queue: Array<{
    accountId: number;
    execute: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }>;
};

const siteQueues = new Map<number, SiteOperationQueue>();

function getOrCreateQueue(siteId: number): SiteOperationQueue {
  let queue = siteQueues.get(siteId);
  if (!queue) {
    queue = { running: false, queue: [] };
    siteQueues.set(siteId, queue);
  }
  return queue;
}

async function processQueue(siteId: number, delayMs: number) {
  const queue = getOrCreateQueue(siteId);
  if (queue.running) return;

  queue.running = true;
  try {
    while (queue.queue.length > 0) {
      const task = queue.queue.shift();
      if (!task) continue;

      try {
        const result = await task.execute();
        task.resolve(result);
      } catch (error) {
        task.reject(error);
      }

      if (queue.queue.length > 0 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    queue.running = false;
  }
}

/**
 * Execute an operation for an account with site-level rate limiting.
 * Operations for the same site are executed sequentially with delays.
 * 
 * @param siteId - Site ID to group rate limiting
 * @param accountId - Account ID for logging/debugging
 * @param execute - Async function to execute
 * @param delayMs - Delay in milliseconds between operations on the same site (default: 1000ms)
 */
export async function withSiteRateLimit<T>(
  siteId: number,
  accountId: number,
  execute: () => Promise<T>,
  delayMs = 1000,
): Promise<T> {
  const queue = getOrCreateQueue(siteId);

  return new Promise<T>((resolve, reject) => {
    queue.queue.push({
      accountId,
      execute,
      resolve,
      reject,
    });

    void processQueue(siteId, delayMs);
  });
}

/**
 * Execute operations for multiple accounts grouped by site with rate limiting.
 * 
 * @param items - Array of items with siteId and accountId
 * @param execute - Function to execute for each item
 * @param delayMs - Delay between operations on the same site (default: 1000ms)
 */
export async function withSiteRateLimitBatch<T, R>(
  items: Array<{ siteId: number; accountId: number; data: T }>,
  execute: (item: T, accountId: number) => Promise<R>,
  delayMs = 1000,
): Promise<R[]> {
  const results = await Promise.all(
    items.map((item) =>
      withSiteRateLimit(
        item.siteId,
        item.accountId,
        () => execute(item.data, item.accountId),
        delayMs,
      ),
    ),
  );
  return results;
}

/**
 * Clear all queues for testing purposes.
 */
export function __clearSiteRateLimiterForTests(): void {
  siteQueues.clear();
}
