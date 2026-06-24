import { describe, expect, it } from 'vitest';
import { summarizeUpstreamError, summarizeUpstreamExecutionError } from './upstreamError.js';

describe('summarizeUpstreamError', () => {
  it('extracts concise message from JSON error payload', () => {
    const message = summarizeUpstreamError(400, JSON.stringify({
      error: {
        message: 'messages is required',
        type: 'bad_request',
      },
    }));

    expect(message).toBe('Upstream returned HTTP 400: messages is required');
  });

  it('summarizes Cloudflare 5xx HTML page without dumping full body', () => {
    const html = `<!DOCTYPE html><html><head><title>qaq.al | 502: Bad gateway</title></head><body>Cloudflare Ray ID: abc</body></html>`;
    const message = summarizeUpstreamError(502, html);

    expect(message).toContain('Upstream returned HTTP 502');
    expect(message).toContain('Cloudflare 502: Bad gateway');
    expect(message).not.toContain('<!DOCTYPE html>');
  });

  it('truncates oversized plain text payloads', () => {
    const longText = 'x'.repeat(800);
    const message = summarizeUpstreamError(500, longText);

    expect(message).toContain('Upstream returned HTTP 500:');
    expect(message).toContain('...(truncated)');
    expect(message.length).toBeLessThan(500);
  });
});

describe('summarizeUpstreamExecutionError', () => {
  it('expands undici terminated body reads into actionable connection details', () => {
    const error = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), {
        name: 'SocketError',
        code: 'UND_ERR_SOCKET',
        socketCode: 'ECONNRESET',
      }),
    });

    const message = summarizeUpstreamExecutionError(error);

    expect(message).toContain('upstream connection closed while reading response body');
    expect(message).toContain('code=UND_ERR_SOCKET');
    expect(message).toContain('socketCode=ECONNRESET');
    expect(message).toContain('cause=SocketError');
  });

  it('preserves ordinary execution error messages', () => {
    expect(summarizeUpstreamExecutionError(new Error('proxy init failed'))).toBe('proxy init failed');
  });
});

