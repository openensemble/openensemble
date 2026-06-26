import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import { openIncident } from '../lib/incident.mjs';
import { profileHealthSignalDetails } from '../routes/misc.mjs';

const USER = 'user_watcher_incident_detail_test';
const NODE = 'node_alert_test';

function cleanup() {
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => cleanup());
afterAll(() => cleanup());

describe('profileHealthSignalDetails', () => {
  it('attaches open incident details to unhealthy profile health signals', () => {
    const inc = openIncident(USER, NODE, {
      service_id: 'system',
      profile_version: 'test',
      triggering_signal: {
        kind: 'disk_free',
        value: '90',
        expected: { lt: 90 },
        fired_at: new Date().toISOString(),
      },
    });

    const details = profileHealthSignalDetails(USER, {
      kind: 'profile_health',
      state: {
        node_id: NODE,
        service_id: 'system',
        signals: [{
          kind: 'disk_free',
          severity: 'critical',
          last_state: 'unhealthy',
          last_checked_at: Date.now(),
          current_incident_id: inc.id,
          check: { mechanism: 'cli', command: 'df -P /' },
          expect: { lt: 90 },
        }],
      },
    });

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      kind: 'disk_free',
      last_state: 'unhealthy',
      current_incident_id: inc.id,
      expect: { lt: 90 },
      incident: {
        id: inc.id,
        status: 'open',
        triggering_signal: {
          kind: 'disk_free',
          value: '90',
          expected: { lt: 90 },
        },
      },
    });
  });
});
