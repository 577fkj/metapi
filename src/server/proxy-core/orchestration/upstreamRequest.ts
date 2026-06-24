export type UpstreamEndpoint = 'chat' | 'messages' | 'responses';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function asErrorRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function extractErrorCauseChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }

  return chain;
}

function getErrorStringField(error: Record<string, unknown>, field: string): string {
  const value = error[field];
  return typeof value === 'string' ? collapseWhitespace(value) : '';
}

export function summarizeUpstreamExecutionError(error: unknown): string {
  const chain = extractErrorCauseChain(error);
  const root = chain[0] || asErrorRecord(error);
  const message = root
    ? getErrorStringField(root, 'message')
    : (typeof error === 'string' ? collapseWhitespace(error) : '');
  const name = root ? getErrorStringField(root, 'name') : '';
  const cause = chain.length > 1 ? chain[1] : null;
  const causeMessage = cause ? getErrorStringField(cause, 'message') : '';
  const causeName = cause ? getErrorStringField(cause, 'name') : '';
  const code = chain.map((item) => getErrorStringField(item, 'code')).find(Boolean) || '';
  const socketCode = chain.map((item) => getErrorStringField(item, 'socketCode')).find(Boolean) || '';
  const detailParts: string[] = [];

  if (code) detailParts.push(`code=${code}`);
  if (socketCode && socketCode !== code) detailParts.push(`socketCode=${socketCode}`);
  if (causeName && causeName !== name) detailParts.push(`cause=${causeName}`);
  if (causeMessage && causeMessage !== message) detailParts.push(`causeMessage=${causeMessage}`);

  const combined = [message, causeMessage, code, socketCode].join(' ').toLowerCase();
  const isBodyTerminated = message.toLowerCase() === 'terminated' || /\bterminated\b/.test(combined);
  const isConnectionReset = /\beconnreset\b|connection reset|socket hang up/.test(combined);
  const isContentLengthMismatch = /\bund_err_res_content_length_mismatch\b|content length mismatch/.test(combined);
  const isSocketError = name === 'SocketError' || causeName === 'SocketError';

  let prefix = message || name || 'network failure';
  if (isBodyTerminated || isConnectionReset || isContentLengthMismatch || isSocketError) {
    prefix = 'upstream connection closed while reading response body';
  }

  return detailParts.length > 0
    ? `${prefix} (${detailParts.join(', ')})`
    : prefix;
}

function extractJsonErrorMessage(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    const root = isRecord(parsed) ? parsed : null;
    const error = (root && isRecord(root.error)) ? root.error : root;
    if (!error) return '';

    const message = typeof error.message === 'string' ? collapseWhitespace(error.message) : '';
    if (message) return message;

    const code = typeof error.code === 'string' ? collapseWhitespace(error.code) : '';
    const type = typeof error.type === 'string' ? collapseWhitespace(error.type) : '';
    return [type, code].filter((part) => part.length > 0).join('/');
  } catch {
    return '';
  }
}

function extractHtmlTitle(rawText: string): string {
  const match = rawText.match(/<title[^>]*>([^<>]*)<\/title>/i);
  if (!match?.[1]) return '';
  return collapseWhitespace(match[1]);
}

function extractCloudflareHtmlSummary(rawText: string, status: number): string {
  if (!/cloudflare/i.test(rawText)) return '';
  const title = extractHtmlTitle(rawText);
  const codeMatch = (
    title.match(/\b(\d{3,4})\s*:\s*([^\|<]+)/i)
    || rawText.match(/Error code\s*(\d{3,4})/i)
  );
  const code = codeMatch?.[1] || (status > 0 ? String(status) : '');
  const reason = collapseWhitespace(
    (typeof codeMatch?.[2] === 'string' ? codeMatch[2] : '')
    || (status >= 500 ? 'origin host error' : 'request blocked')
  );
  if (code) return `Cloudflare ${code}: ${reason}`;
  return `Cloudflare: ${reason}`;
}

function extractHtmlSummary(rawText: string, status: number): string {
  if (!/(<!doctype|<html)/i.test(rawText)) return '';

  const cloudflareSummary = extractCloudflareHtmlSummary(rawText, status);
  if (cloudflareSummary) return cloudflareSummary;

  const title = extractHtmlTitle(rawText);
  if (title) return title;

  const heading = rawText.match(/<h1[^>]*>([^<>]*)<\/h1>/i)?.[1] || '';
  return collapseWhitespace(heading);
}

function formatUrlOrigin(url: URL): string {
  const username = url.username ? encodeURIComponent(url.username) : '';
  const password = url.password ? encodeURIComponent(url.password) : '';
  const auth = username
    ? `${username}${password ? `:${password}` : ''}@`
    : '';

  return `${url.protocol}//${auth}${url.host}`;
}

function joinPath(basePath: string, requestPath: string): string {
  const base = basePath.replace(/\/+$/, '');
  const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;

  if (!base || base === '/') return path || '/';
  if (!path || path === '/') return base;
  return `${base}${path}`;
}

export function summarizeUpstreamError(status: number, rawErrorText: string): string {
  const statusPrefix = status > 0
    ? `Upstream returned HTTP ${status}`
    : 'Upstream request failed';

  const raw = typeof rawErrorText === 'string' ? rawErrorText.trim() : '';
  if (!raw) return statusPrefix;

  const jsonMessage = extractJsonErrorMessage(raw);
  if (jsonMessage) return `${statusPrefix}: ${jsonMessage}`;

  const htmlMessage = extractHtmlSummary(raw, status);
  if (htmlMessage) return `${statusPrefix}: ${htmlMessage}`;

  const compact = collapseWhitespace(raw);
  if (!compact) return statusPrefix;
  if (compact.length <= 400) return `${statusPrefix}: ${compact}`;
  return `${statusPrefix}: ${compact.slice(0, 400)}...(truncated)`;
}

export function buildUpstreamUrl(siteUrl: string, requestPath: string): string {
  const baseRaw = typeof siteUrl === 'string' ? siteUrl.trim() : '';
  const pathRaw = typeof requestPath === 'string' ? requestPath.trim() : '';
  const fallbackBase = baseRaw.replace(/\/+$/, '');
  let path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;

  if (!fallbackBase) return path || '/';
  if (!path || path === '/') return fallbackBase;

  try {
    const parsed = new URL(baseRaw);
    const basePath = parsed.pathname.replace(/\/+$/, '');
    const baseHasVersionSuffix = /\/(?:api\/)?v1$/i.test(basePath);
    if (baseHasVersionSuffix) {
      if (path === '/v1') {
        path = '/';
      } else if (path.startsWith('/v1/')) {
        path = path.slice('/v1'.length) || '/';
      }
    }

    const joinedPath = joinPath(basePath, path);
    return `${formatUrlOrigin(parsed)}${joinedPath}${parsed.search}${parsed.hash}`;
  } catch {
    const baseHasVersionSuffix = /\/(?:api\/)?v1$/i.test(fallbackBase);
    if (baseHasVersionSuffix) {
      if (path === '/v1') {
        path = '/';
      } else if (path.startsWith('/v1/')) {
        path = path.slice('/v1'.length) || '/';
      }
    }

    return `${fallbackBase}${path}`;
  }
}
