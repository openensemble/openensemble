import { PassThrough, Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import {
  SKILL_SANDBOX_MAX_FRAME_BYTES,
  attachSandboxWireReader,
  createSandboxWireWriter,
  isSafeSandboxPathSegment,
  writeSandboxWireMessage,
} from './skill-sandbox-wire.mjs';

describe('custom-skill runner wire protocol', () => {
  it('round-trips NDJSON messages', () => {
    const stream = new PassThrough();
    const messages = [];
    const errors = [];
    const detach = attachSandboxWireReader(stream, {
      onMessage: value => messages.push(value),
      onError: error => errors.push(error),
    });
    writeSandboxWireMessage(stream, { t: 'event', event: { type: 'token', text: 'ok' } });
    expect(messages).toEqual([{ t: 'event', event: { type: 'token', text: 'ok' } }]);
    expect(errors).toEqual([]);
    detach();
  });

  it('preserves multibyte UTF-8 split across transport chunks', () => {
    const stream = new PassThrough();
    const messages = [];
    const errors = [];
    attachSandboxWireReader(stream, {
      onMessage: value => messages.push(value),
      onError: error => errors.push(error),
    });
    const frame = Buffer.from(`${JSON.stringify({ t: 'result', ok: true, result: 'café 🧪' })}\n`);
    const split = frame.indexOf(Buffer.from('🧪')) + 1;
    stream.write(frame.subarray(0, split));
    stream.write(frame.subarray(split));
    expect(messages).toEqual([{ t: 'result', ok: true, result: 'café 🧪' }]);
    expect(errors).toEqual([]);
  });

  it('fails a malformed or oversized protocol frame closed', () => {
    const malformed = new PassThrough();
    const malformedError = vi.fn();
    attachSandboxWireReader(malformed, { onMessage: vi.fn(), onError: malformedError });
    malformed.write('{not-json}\n');
    expect(malformedError).toHaveBeenCalledOnce();

    const oversized = new PassThrough();
    const oversizedError = vi.fn();
    attachSandboxWireReader(oversized, { onMessage: vi.fn(), onError: oversizedError });
    oversized.write(Buffer.alloc(SKILL_SANDBOX_MAX_FRAME_BYTES + 1, 0x61));
    expect(oversizedError).toHaveBeenCalledOnce();

    const oversizedTail = new PassThrough();
    const oversizedTailError = vi.fn();
    attachSandboxWireReader(oversizedTail, { onMessage: vi.fn(), onError: oversizedTailError });
    oversizedTail.write(Buffer.concat([
      Buffer.from('{}\n'), Buffer.alloc(SKILL_SANDBOX_MAX_FRAME_BYTES + 1, 0x61),
    ]));
    expect(oversizedTailError).toHaveBeenCalledOnce();
  });

  it('honors Writable backpressure while preserving message order', async () => {
    const chunks = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });
    const errors = [];
    const writer = createSandboxWireWriter(stream, { onError: error => errors.push(error) });
    writer.send({ n: 1 });
    writer.send({ n: 2 });
    writer.end();
    await new Promise(resolve => stream.once('finish', resolve));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"n":1}\n{"n":2}\n');
    expect(errors).toEqual([]);
  });

  it('makes one-shot writers fail closed on backpressure', () => {
    expect(() => writeSandboxWireMessage({ write: () => false }, { ok: true }))
      .toThrow(/backpressure/);
  });

  it('accepts only one safe filesystem path component', () => {
    expect(isSafeSandboxPathSegment('user_123')).toBe(true);
    expect(isSafeSandboxPathSegment('flight-booker')).toBe(true);
    expect(isSafeSandboxPathSegment('../stock')).toBe(false);
    expect(isSafeSandboxPathSegment('/absolute')).toBe(false);
    expect(isSafeSandboxPathSegment('..')).toBe(false);
  });
});
