export const ACCOUNT_STATUS_ACTIVE = 'active';
export const ACCOUNT_STATUS_DISABLED = 'disabled';
export const ACCOUNT_STATUS_EXPIRED = 'expired';

export const ACCOUNT_API_KEY_ROUTE_STATUSES = [
  ACCOUNT_STATUS_ACTIVE,
  ACCOUNT_STATUS_EXPIRED,
];

export function normalizeAccountLifecycleStatus(status?: string | null): string {
  const normalized = (status || ACCOUNT_STATUS_ACTIVE).trim().toLowerCase();
  return normalized || ACCOUNT_STATUS_ACTIVE;
}

export function isAccountSessionActive(status?: string | null): boolean {
  return normalizeAccountLifecycleStatus(status) === ACCOUNT_STATUS_ACTIVE;
}

export function canAccountRouteApiKey(status?: string | null): boolean {
  const normalized = normalizeAccountLifecycleStatus(status);
  return ACCOUNT_API_KEY_ROUTE_STATUSES.includes(normalized);
}

export function isAccountDisabled(status?: string | null): boolean {
  return normalizeAccountLifecycleStatus(status) === ACCOUNT_STATUS_DISABLED;
}
