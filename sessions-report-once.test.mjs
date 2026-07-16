import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { USERS_DIR } from './lib/paths.mjs';
import { appendSessionReportOnce, loadSession } from './sessions.mjs';

const userId = `user_reportonce${Date.now()}`;
const agentId = `${userId}_jarvis`;

afterAll(() => {
  fs.rmSync(path.join(USERS_DIR, userId), { recursive: true, force: true });
});

describe('atomic session report append', () => {
  it('converges concurrent completion retries on one durable report id', async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      appendSessionReportOnce(agentId, {
        role: 'assistant',
        reportId: 'worker-task:primary-completion',
        content: `attempt ${index}`,
        ts: Date.now() + index,
      })));
    expect(attempts.filter(value => value === 'appended')).toHaveLength(1);
    expect(attempts.filter(value => value === 'existing')).toHaveLength(11);
    const rows = await loadSession(agentId, 100);
    expect(rows.filter(row => row.reportId === 'worker-task:primary-completion')).toHaveLength(1);
  });
});
