import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getAutoReloginConfig, guessPlatformUserIdFromUsername, mergeAccountExtraConfig, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { decryptAccountPassword, encryptAccountPassword } from './accountCredentialService.js';
import { getAdapter } from './platforms/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { withAccountProxyOverride } from './siteProxy.js';

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;

type ReloginCredentials = {
  username?: string | null;
  password?: string | null;
  rememberPassword?: boolean;
};

type ReloginSource = 'auto-balance' | 'auto-checkin' | 'token-expired' | 'manual';

export type AccountReloginResult =
  | {
      success: true;
      accessToken: string;
      username: string;
      savedPassword: boolean;
    }
  | {
      success: false;
      message: string;
    };

function normalizeCredential(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function hasSavedAccountReloginPassword(account: Pick<AccountRow, 'extraConfig'>): boolean {
  return !!getAutoReloginConfig(account.extraConfig);
}

async function writeReloginEvent(input: {
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  source: ReloginSource;
  success: boolean;
  message: string;
}) {
  const accountLabel = input.username || `ID:${input.accountId}`;
  const siteLabel = input.siteName || 'unknown-site';
  const sourceLabel = input.source === 'manual' ? '手动' : '自动';
  await db.insert(schema.events).values({
    type: 'account',
    title: input.success ? '账号重新登录成功' : '账号重新登录失败',
    message: `${accountLabel} @ ${siteLabel}: ${sourceLabel}重新登录${input.success ? '成功' : '失败'}${input.message ? `，${input.message}` : ''}`,
    level: input.success ? 'info' : 'error',
    relatedId: input.accountId,
    relatedType: 'account',
    createdAt: formatUtcSqlDateTime(new Date()),
  }).run();
}

function resolveReloginCredentials(account: AccountRow, credentials?: ReloginCredentials): {
  username: string;
  password: string;
  shouldSavePassword: boolean;
  fromSavedPassword: boolean;
} | null {
  const username = normalizeCredential(credentials?.username);
  const password = normalizeCredential(credentials?.password);
  if (username && password) {
    return {
      username,
      password,
      shouldSavePassword: credentials?.rememberPassword !== false,
      fromSavedPassword: false,
    };
  }

  const saved = getAutoReloginConfig(account.extraConfig);
  if (!saved) return null;
  const plainPassword = decryptAccountPassword(saved.passwordCipher);
  if (!plainPassword) return null;

  return {
    username: saved.username,
    password: plainPassword,
    shouldSavePassword: true,
    fromSavedPassword: true,
  };
}

export async function attemptAccountPasswordRelogin(input: {
  account: AccountRow;
  site: SiteRow;
  source: ReloginSource;
  credentials?: ReloginCredentials;
  log?: boolean;
}): Promise<AccountReloginResult> {
  const adapter = getAdapter(input.site.platform);
  const resolved = resolveReloginCredentials(input.account, input.credentials);

  const fail = async (message: string): Promise<AccountReloginResult> => {
    if (input.log) {
      await writeReloginEvent({
        accountId: input.account.id,
        username: input.account.username,
        siteName: input.site.name,
        source: input.source,
        success: false,
        message,
      });
    }
    return { success: false, message };
  };

  if (!adapter) return fail(`平台不支持: ${input.site.platform}`);
  if (!resolved) return fail('没有可用的登录信息');

  const loginResult = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(input.account.extraConfig),
    () => adapter.login(input.site.url, resolved.username, resolved.password),
  );
  if (!loginResult.success || !loginResult.accessToken) {
    return fail(loginResult.message || '登录失败');
  }

  const nextUsername = normalizeCredential(loginResult.username) || resolved.username;
  const extraConfigPatch: Record<string, unknown> = {
    credentialMode: 'session',
  };
  const platformUserId = guessPlatformUserIdFromUsername(nextUsername);
  if (platformUserId) extraConfigPatch.platformUserId = platformUserId;
  if (!resolved.fromSavedPassword && resolved.shouldSavePassword) {
    extraConfigPatch.autoRelogin = {
      username: nextUsername,
      passwordCipher: encryptAccountPassword(resolved.password),
      updatedAt: new Date().toISOString(),
    };
  }

  await db.update(schema.accounts)
    .set({
      username: nextUsername || input.account.username,
      accessToken: loginResult.accessToken,
      status: 'active',
      extraConfig: mergeAccountExtraConfig(input.account.extraConfig, extraConfigPatch),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.accounts.id, input.account.id))
    .run();

  if (input.log) {
    await writeReloginEvent({
      accountId: input.account.id,
      username: nextUsername || input.account.username,
      siteName: input.site.name,
      source: input.source,
      success: true,
      message: resolved.fromSavedPassword ? '已使用保存的登录信息' : '已使用本次提供的登录信息',
    });
  }

  return {
    success: true,
    accessToken: loginResult.accessToken,
    username: nextUsername,
    savedPassword: resolved.fromSavedPassword || resolved.shouldSavePassword,
  };
}
