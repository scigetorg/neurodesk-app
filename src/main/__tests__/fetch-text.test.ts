import { fetchText } from '../net/fetchText';

jest.mock('https', () => ({ request: jest.fn() }));
const { request: mockRequest } = require('https');

type Reply = { status: number; body?: string | string[]; location?: string };

// Answer each request with the next reply in order. Like the real module,
// the response callback runs after request() returns.
function serve(...replies: Reply[]) {
  const req = {
    on: jest.fn().mockReturnThis(),
    end: jest.fn(),
    destroy: jest.fn()
  };
  mockRequest.mockImplementation(
    (_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      const reply = replies.shift();
      const chunks = Array.isArray(reply.body)
        ? reply.body
        : [reply.body ?? ''];
      const res = {
        statusCode: reply.status,
        headers: reply.location ? { location: reply.location } : {},
        on: jest.fn((event: string, handler: (chunk?: string) => void) => {
          if (event === 'data') chunks.forEach(c => handler(c));
          if (event === 'end') handler();
          return res;
        })
      };
      setImmediate(() => cb(res));
      return req;
    }
  );
  return req;
}

beforeEach(() => mockRequest.mockReset());

describe('fetchText', () => {
  it('returns the body of a 200 response', async () => {
    serve({ status: 200, body: ['a', 'b'] });
    await expect(fetchText('https://x.test/a')).resolves.toBe('ab');
  });

  it('refuses a non-https URL without making a request', async () => {
    await expect(fetchText('http://x.test/a')).rejects.toThrow('non-https');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('follows an https redirect, including a relative one', async () => {
    serve({ status: 302, location: '/moved' }, { status: 200, body: 'ok' });
    await expect(fetchText('https://x.test/a')).resolves.toBe('ok');
    expect(mockRequest.mock.calls[1][0]).toBe('https://x.test/moved');
  });

  it('refuses a redirect to plain http', async () => {
    serve({ status: 301, location: 'http://evil.test/a' });
    await expect(fetchText('https://x.test/a')).rejects.toThrow('non-https');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('stops after maxRedirects', async () => {
    serve(
      { status: 302, location: 'https://x.test/1' },
      { status: 302, location: 'https://x.test/2' },
      { status: 302, location: 'https://x.test/3' }
    );
    await expect(
      fetchText('https://x.test/a', { maxRedirects: 2 })
    ).rejects.toThrow('Too many redirects');
  });

  it('rejects a non-200 status', async () => {
    serve({ status: 404 });
    await expect(fetchText('https://x.test/a')).rejects.toThrow('HTTP 404');
  });

  it('rejects and aborts a body over maxBytes', async () => {
    const req = serve({ status: 200, body: ['12345', '67890'] });
    await expect(
      fetchText('https://x.test/a', { maxBytes: 8 })
    ).rejects.toThrow('exceeds 8 bytes');
    expect(req.destroy).toHaveBeenCalled();
  });
});
