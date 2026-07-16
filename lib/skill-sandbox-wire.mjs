// @ts-check
/**
 * Small NDJSON protocol shared by the OE process and the dedicated
 * custom-skill sandbox runner. The Unix socket is a transport only: ctx RPCs
 * are still authorized and serviced by OE, while process creation happens in
 * the runner container that has no config/master-key mount.
 */

export const SKILL_SANDBOX_PROTOCOL_VERSION = 1;
export const SKILL_SANDBOX_MAX_FRAME_BYTES = 16 * 1024 * 1024;

function encodeSandboxWireMessage(message) {
  const frame = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  if (frame.length > SKILL_SANDBOX_MAX_FRAME_BYTES) {
    throw new Error(`skill sandbox protocol frame exceeds ${SKILL_SANDBOX_MAX_FRAME_BYTES} bytes`);
  }
  return frame;
}

/** @param {NodeJS.WritableStream} stream @param {any} message */
export function writeSandboxWireMessage(stream, message) {
  const frame = encodeSandboxWireMessage(message);
  if (!stream.write(frame)) {
    // This low-level helper cannot pause its producer. Production callers use
    // createSandboxWireWriter below; a one-shot caller must fail closed rather
    // than silently growing a Writable's internal queue.
    throw new Error('skill sandbox protocol transport backpressure limit reached');
  }
}

/**
 * Ordered writer for a job connection. Node accepts the frame that first
 * returns false, then we wait for `drain` before flushing later frames. This is
 * ordinary transport backpressure, independent of how much legitimate work a
 * first-party skill performs during a job.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {{onError?:(error:Error)=>void}} [options]
 */
export function createSandboxWireWriter(stream, options = {}) {
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  /** @type {Buffer[]} */
  const queue = [];
  let backpressured = false;
  let ending = false;
  let failed = false;

  const fail = (error) => {
    if (failed) return;
    failed = true;
    queue.length = 0;
    stream.off('drain', onDrain);
    onError(error instanceof Error ? error : new Error(String(error)));
  };

  const finishIfReady = () => {
    if (!failed && ending && !backpressured && queue.length === 0) {
      try { stream.end(); }
      catch (error) { fail(error); }
    }
  };

  const flush = () => {
    if (failed || backpressured) return;
    while (queue.length) {
      const frame = queue.shift();
      if (!frame) break;
      try {
        if (!stream.write(frame)) {
          backpressured = true;
          return;
        }
      } catch (error) {
        fail(error);
        return;
      }
    }
    finishIfReady();
  };

  function onDrain() {
    if (failed) return;
    backpressured = false;
    flush();
  }
  stream.on('drain', onDrain);

  const send = (message) => {
    if (failed) throw new Error('skill sandbox protocol writer is closed');
    if (ending) throw new Error('skill sandbox protocol writer is ending');
    const frame = encodeSandboxWireMessage(message);
    if (backpressured || queue.length) {
      queue.push(frame);
      return;
    }
    try {
      if (!stream.write(frame)) backpressured = true;
    } catch (error) {
      fail(error);
      throw error;
    }
  };

  const end = () => {
    if (failed || ending) return;
    ending = true;
    finishIfReady();
  };

  const detach = () => {
    failed = true;
    queue.length = 0;
    stream.off('drain', onDrain);
  };

  return { send, end, detach };
}

/**
 * Attach a newline decoder. A malformed or oversized frame is fatal;
 * callers should destroy the socket in `onError` rather than attempting to
 * resynchronize a protocol stream.
 *
 * @param {NodeJS.ReadableStream} stream
 * @param {{onMessage:(message:any)=>void, onError:(error:Error)=>void}} handlers
 * @returns {()=>void}
 */
export function attachSandboxWireReader(stream, {
  onMessage, onError,
}) {
  let buffered = Buffer.alloc(0);
  let failed = false;

  const fail = (error) => {
    if (failed) return;
    failed = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  };

  const onData = (chunk) => {
    if (failed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffered = buffered.length ? Buffer.concat([buffered, incoming]) : incoming;
    if (buffered.length > SKILL_SANDBOX_MAX_FRAME_BYTES && buffered.indexOf(0x0a) < 0) {
      fail(new Error(`skill sandbox protocol frame exceeds ${SKILL_SANDBOX_MAX_FRAME_BYTES} bytes`));
      return;
    }

    let newline;
    while (!failed && (newline = buffered.indexOf(0x0a)) >= 0) {
      const frame = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (!frame.length) continue;
      if (frame.length > SKILL_SANDBOX_MAX_FRAME_BYTES) {
        fail(new Error(`skill sandbox protocol frame exceeds ${SKILL_SANDBOX_MAX_FRAME_BYTES} bytes`));
        return;
      }
      let message;
      try { message = JSON.parse(frame.toString('utf8')); }
      catch { fail(new Error('skill sandbox protocol received malformed JSON')); return; }
      try { onMessage(message); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    }
    if (!failed && buffered.length > SKILL_SANDBOX_MAX_FRAME_BYTES) {
      fail(new Error(`skill sandbox protocol frame exceeds ${SKILL_SANDBOX_MAX_FRAME_BYTES} bytes`));
    }
  };

  stream.on('data', onData);
  return () => stream.off('data', onData);
}

/** A path component accepted by the runner before any filesystem lookup. */
export function isSafeSandboxPathSegment(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    && value !== '.' && value !== '..';
}
