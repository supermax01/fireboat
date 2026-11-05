import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse, request as httpRequest, RequestOptions } from 'node:http';
import { PassThrough } from 'node:stream';

export type RecordedRequest = { method: string; path: string; body: Buffer; host: string; options: RequestOptions };
export function fakeHttp(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: RecordedRequest[] = [];
  const request = ((options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const client = new EventEmitter() as EventEmitter & { end: (body?: Buffer) => void; destroy: () => void };
    let response: PassThrough | undefined, destroyed = false;
    client.destroy = () => { destroyed = true; response?.destroy(); queueMicrotask(() => client.emit('error', new Error('synthetic connection closed'))); };
    client.end = body => queueMicrotask(() => {
      if (destroyed) return;
      requests.push({ method: options.method!, path: options.path!, body: Buffer.from(body ?? ''),
        host: `${options.hostname}:${options.port}`, options });
      const stream = new PassThrough(); response = stream;
      let delivered = false;
      const headers: Record<string, string | number> = {};
      const res = stream as unknown as ServerResponse & { headers: typeof headers; statusCode: number };
      res.statusCode = 200; res.headers = headers;
      res.setHeader = ((key: string, value: string | number) => { headers[key.toLowerCase()] = value; return res; }) as typeof res.setHeader;
      res.writeHead = ((status: number, value?: Record<string, string | number>) => {
        res.statusCode = status;
        for (const [key, item] of Object.entries(value ?? {})) res.setHeader(key, item);
        return res;
      }) as typeof res.writeHead;
      const deliver = () => { if (!delivered) { delivered = true; callback(res as unknown as IncomingMessage); } };
      const write = stream.write.bind(stream), end = stream.end.bind(stream);
      stream.write = ((...args: Parameters<typeof stream.write>) => { deliver(); return write(...args); }) as typeof stream.write;
      stream.end = ((...args: Parameters<typeof stream.end>) => { deliver(); return end(...args); }) as typeof stream.end;
      const req = { method: options.method, url: options.path, headers: { host: `${options.hostname}:${options.port}` },
        socket: { destroy: client.destroy } } as unknown as IncomingMessage;
      if (handler) handler(req, res);
      else if (options.path?.endsWith('?_summary=count')) res.end('{"resourceType":"Bundle","type":"searchset","total":0}');
      else { res.statusCode = options.method === 'PUT' ? 201 : 200; res.end('{}'); }
    });
    return client;
  }) as unknown as typeof httpRequest;
  return { requests, request, close: async () => {} };
}
