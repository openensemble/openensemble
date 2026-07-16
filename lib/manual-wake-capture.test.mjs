import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isManualWakeCaptureEnabled } from './manual-wake-capture.mjs';

let captureRoot;

beforeEach(() => {
  captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-wake-capture-test-'));
});

afterEach(() => {
  fs.rmSync(captureRoot, { recursive: true, force: true });
});

describe('temporary manual wake-capture sentinels', () => {
  it('arms only the named device when a device-scoped sentinel exists', () => {
    fs.writeFileSync(path.join(captureRoot, 'ENABLE-kitchen'), '');

    expect(isManualWakeCaptureEnabled(captureRoot, 'kitchen')).toBe(true);
    expect(isManualWakeCaptureEnabled(captureRoot, 'bedroom')).toBe(false);
    expect(isManualWakeCaptureEnabled(captureRoot, 'kitchenette')).toBe(false);
  });

  it('preserves the legacy global sentinel as an all-device override', () => {
    fs.writeFileSync(path.join(captureRoot, 'ENABLE'), '');

    expect(isManualWakeCaptureEnabled(captureRoot, 'kitchen')).toBe(true);
    expect(isManualWakeCaptureEnabled(captureRoot, 'bedroom')).toBe(true);
  });
});
