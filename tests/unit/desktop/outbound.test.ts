import { expect, it, vi } from 'vitest';
import { createLarkChannel, type LarkChannelOptions } from '@larksuite/channel';
import { desktopOutboundConfig } from '../../../src/desktop/outbound';

it.each([
  ['markdown', 'reset'], ['card', 'reset'], ['markdown', 'timeout'], ['card', 'timeout'],
  ['markdown', 'missing-receipt'], ['card', 'missing-receipt'],
] as const)('does not retry an inconclusive %s reply (%s) in the actual channel/SDK', async (kind, failure) => {
  const transport = vi.fn(async (options: any) => {
    if (String(options.url).includes('/auth/')) return { code: 0, tenant_access_token: 'test-only-token', expire: 3600 };
    if (failure === 'missing-receipt') return { code: 0, data: {} };
    throw Object.assign(new Error('test transport failure after an unknown send outcome'), { code: failure === 'timeout' ? 'ETIMEDOUT' : 'ECONNRESET' });
  });
  const http = { request: transport, post: (url: string, data: unknown) => transport({ url, data, method: 'post' }) } as unknown as NonNullable<LarkChannelOptions['httpInstance']>;
  const channel = createLarkChannel({ appId: 'test-app-' + kind, appSecret: 'test-only-secret', httpInstance: http,
    outbound: desktopOutboundConfig, logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
  const input = kind === 'markdown' ? { markdown: 'saved result' } : { card: { schema: '2.0', body: { elements: [] } } };
  await expect(channel.send('oc_test', input, { replyTo: 'om_test' })).rejects.toMatchObject({ code: failure === 'timeout' ? 'send_timeout' : 'unknown' });
  const replies = transport.mock.calls.filter(([options]) => String(options.url).includes('/messages/om_test/reply'));
  expect(replies).toHaveLength(1);
});
