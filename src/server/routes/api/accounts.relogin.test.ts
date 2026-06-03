import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const attemptAccountPasswordReloginMock = vi.fn();
const hasSavedAccountReloginPasswordMock = vi.fn();
const convergeAccountMutationMock = vi.fn();
const rebuildRoutesBestEffortMock = vi.fn();

vi.mock('../../services/accountReloginService.js', () => ({
  attemptAccountPasswordRelogin: (...args: unknown[]) => attemptAccountPasswordReloginMock(...args),
  hasSavedAccountReloginPassword: (...args: unknown[]) => hasSavedAccountReloginPasswordMock(...args),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: (...args: unknown[]) => rebuildRoutesBestEffortMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts relogin api', { timeout: 15_000 }, () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-relogin-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    attemptAccountPasswordReloginMock.mockReset();
    hasSavedAccountReloginPasswordMock.mockReset();
    convergeAccountMutationMock.mockReset();
    rebuildRoutesBestEffortMock.mockReset();
    convergeAccountMutationMock.mockResolvedValue({});
    rebuildRoutesBestEffortMock.mockResolvedValue(true);

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function createExpiredAccount() {
    const site = await db.insert(schema.sites).values({
      name: 'Relogin Site',
      url: 'https://relogin.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_1001',
      accessToken: 'expired-access-token',
      apiToken: 'sk-existing',
      status: 'expired',
    }).returning().get();

    return { site, account };
  }

  it('rejects saved-password relogin when no saved password exists', async () => {
    const { account } = await createExpiredAccount();
    hasSavedAccountReloginPasswordMock.mockReturnValue(false);

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/relogin`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '当前账号没有保存的登录密码',
    });
    expect(attemptAccountPasswordReloginMock).not.toHaveBeenCalled();
  });

  it('uses saved relogin credentials when username and password are omitted', async () => {
    const { account } = await createExpiredAccount();
    hasSavedAccountReloginPasswordMock.mockReturnValue(true);
    attemptAccountPasswordReloginMock.mockResolvedValue({
      success: true,
      accessToken: 'fresh-access-token',
      username: 'linuxdo_1001',
      savedPassword: true,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/relogin`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true });
    expect(attemptAccountPasswordReloginMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'manual',
      credentials: undefined,
      log: true,
    }));
    expect(convergeAccountMutationMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: account.id,
      refreshBalance: true,
      refreshModels: true,
      rebuildRoutes: true,
    }));
  });

  it('uses provided username and password for relogin', async () => {
    const { account } = await createExpiredAccount();
    hasSavedAccountReloginPasswordMock.mockReturnValue(false);
    attemptAccountPasswordReloginMock.mockResolvedValue({
      success: true,
      accessToken: 'fresh-access-token',
      username: 'linuxdo_2002',
      savedPassword: true,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/relogin`,
      payload: {
        username: 'linuxdo_2002',
        password: 'new-password',
        rememberPassword: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true });
    expect(attemptAccountPasswordReloginMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'manual',
      credentials: {
        username: 'linuxdo_2002',
        password: 'new-password',
        rememberPassword: true,
      },
      log: true,
    }));
  });
});
