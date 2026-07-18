import fs from 'node:fs';
import path from 'node:path';

/**
 * Return whether temporary manual wake capture is armed for one device.
 *
 * `ENABLE-<deviceId>` targets only that device. A global `ENABLE` sentinel is
 * intentionally ignored so a forgotten training flag cannot intercept every
 * voice device in the installation.
 */
export function isManualWakeCaptureEnabled(captureRoot, deviceId) {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) return false;
  return fs.existsSync(path.join(captureRoot, `ENABLE-${deviceId}`));
}
