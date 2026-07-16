import fs from 'node:fs';
import path from 'node:path';

/**
 * Return whether temporary manual wake capture is armed for one device.
 *
 * `ENABLE-<deviceId>` targets only that device. The legacy `ENABLE` sentinel
 * remains a deliberate global override for capture-harvest sessions.
 */
export function isManualWakeCaptureEnabled(captureRoot, deviceId) {
  if (deviceId && fs.existsSync(path.join(captureRoot, `ENABLE-${deviceId}`))) return true;
  return fs.existsSync(path.join(captureRoot, 'ENABLE'));
}
