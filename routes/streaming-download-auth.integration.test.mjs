import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { handle as handleDesktop } from './desktop.mjs';
import { handle as handleSharedDocs } from './shared-docs.mjs';
import { createMediaToken, getUserDir } from './_helpers.mjs';

const OWNER = 'user_streaming_download_owner';
const OTHER = 'user_streaming_download_other';
const VIDEO_NAME = 'generated clip 특별.mp4';
const VIDEO_BYTES = Buffer.from('generated-video-stream');
const DOC_ID = 'doc_streaming_video';
const DOC_NAME = 'uploaded video.mp4';
const DOC_BYTES = Buffer.from('uploaded-video-stream');

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  get body() {
    return Buffer.concat(this.chunks);
  }
}

async function request(handler, url) {
  const res = new CaptureResponse();
  await handler({ method: 'GET', url, headers: {} }, res);
  if (!res.writableFinished) await finished(res);
  return res;
}

beforeAll(() => {
  const ownerDir = getUserDir(OWNER);
  const videosDir = path.join(ownerDir, 'videos');
  const documentsDir = path.join(ownerDir, 'documents');
  fs.mkdirSync(videosDir, { recursive: true });
  fs.mkdirSync(documentsDir, { recursive: true });
  fs.writeFileSync(path.join(videosDir, VIDEO_NAME), VIDEO_BYTES);
  fs.writeFileSync(path.join(documentsDir, `${DOC_ID}.mp4`), DOC_BYTES);
  fs.writeFileSync(path.join(documentsDir, 'docs-index.json'), JSON.stringify([{
    id: DOC_ID,
    ext: '.mp4',
    filename: DOC_NAME,
    mimeType: 'video/mp4',
    uploadedBy: OWNER,
    sharedWith: [],
  }]));
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  fs.rmSync(getUserDir(OWNER), { recursive: true, force: true });
  fs.rmSync(getUserDir(OTHER), { recursive: true, force: true });
});

describe('streaming download authorization', () => {
  it('rejects generated and uploaded file streams without authentication', async () => {
    const generated = await request(
      handleDesktop,
      `/api/files/videos/${encodeURIComponent(VIDEO_NAME)}`,
    );
    const uploaded = await request(
      handleSharedDocs,
      `/api/shared-docs/${encodeURIComponent(DOC_ID)}/download`,
    );

    expect(generated.statusCode).toBe(401);
    expect(uploaded.statusCode).toBe(401);
  });

  it('streams only the token owner’s generated and uploaded files', async () => {
    const { token, expiresIn } = createMediaToken(OWNER);
    const query = `?token=${encodeURIComponent(token)}`;

    const generated = await request(
      handleDesktop,
      `/api/files/videos/${encodeURIComponent(VIDEO_NAME)}${query}`,
    );
    const uploaded = await request(
      handleSharedDocs,
      `/api/shared-docs/${encodeURIComponent(DOC_ID)}/download${query}`,
    );

    expect(expiresIn).toBe(10 * 60);
    expect(generated.statusCode).toBe(200);
    expect(generated.body).toEqual(VIDEO_BYTES);
    expect(generated.headers['Content-Disposition']).toContain(encodeURIComponent(VIDEO_NAME));
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.body).toEqual(DOC_BYTES);
    expect(uploaded.headers['Cache-Control']).toBe('no-store');

    const foreignToken = createMediaToken(OTHER).token;
    const foreign = await request(
      handleDesktop,
      `/api/files/videos/${encodeURIComponent(VIDEO_NAME)}?token=${encodeURIComponent(foreignToken)}`,
    );
    const foreignUploaded = await request(
      handleSharedDocs,
      `/api/shared-docs/${encodeURIComponent(DOC_ID)}/download?token=${encodeURIComponent(foreignToken)}`,
    );
    expect(foreign.statusCode).toBe(404);
    expect(foreignUploaded.statusCode).toBe(404);
  });

  it('accepts a media token within its short window and rejects it after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    const { token, expiresIn } = createMediaToken(OWNER);
    const url = `/api/files/videos/${encodeURIComponent(VIDEO_NAME)}?token=${encodeURIComponent(token)}`;

    const beforeExpiry = await request(handleDesktop, url);
    expect(beforeExpiry.statusCode).toBe(200);

    vi.setSystemTime(new Date(Date.now() + expiresIn * 1000 + 1));
    const afterExpiry = await request(handleDesktop, url);
    expect(afterExpiry.statusCode).toBe(401);
  });
});
