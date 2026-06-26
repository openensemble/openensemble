import { describe, expect, it, afterEach } from 'vitest';
import {
  setHealthMonitorCtxResolver,
  _evalSignalForTest as evalSignal,
} from '../scheduler/health-monitor.mjs';

const USER = 'user_health_observation';
const NODE = 'node_health_observation';

afterEach(() => setHealthMonitorCtxResolver(null));

function withExecFn(execFn, fn) {
  setHealthMonitorCtxResolver(() => ({ execFn }));
  return fn();
}

describe('health monitor observed signal state', () => {
  it('persists observed CLI output on healthy checks with no explicit expectation', async () => {
    const execFn = async () => ({ stdout: 'active', stderr: '', exitCode: 0 });
    await withExecFn(execFn, async () => {
      const { newSignal } = await evalSignal(
        { node_id: NODE, service_id: 'apache2', endpoint: '' },
        {
          kind: 'exec',
          check: { mechanism: 'cli', command: 'systemctl is-active apache2' },
          expect: null,
          last_state: 'healthy',
          last_checked_at: null,
          current_incident_id: null,
        },
        { userId: USER },
        12345,
      );
      expect(newSignal).toMatchObject({
        last_state: 'healthy',
        last_checked_at: 12345,
        last_output: 'active',
        last_error: null,
        last_exit_code: 0,
      });
    });
  });

  it('treats missing CLI expectation as command success instead of always healthy', async () => {
    const execFn = async () => ({ stdout: 'inactive', stderr: '', exitCode: 3 });
    await withExecFn(execFn, async () => {
      const { newSignal } = await evalSignal(
        { node_id: NODE, service_id: 'apache2', endpoint: '' },
        {
          kind: 'exec',
          check: { mechanism: 'cli', command: 'systemctl is-active apache2' },
          expect: null,
          last_state: 'unhealthy',
          last_checked_at: null,
          current_incident_id: null,
        },
        { userId: USER },
        12346,
      );
      expect(newSignal).toMatchObject({
        last_state: 'unhealthy',
        last_checked_at: 12346,
        last_output: 'inactive',
        last_error: null,
        last_exit_code: 3,
      });
    });
  });

  it('notifies after troubleshooting decides what action is needed', async () => {
    const execFn = async () => ({ stdout: 'inactive', stderr: '', exitCode: 3 });
    const notifications = [];
    await withExecFn(execFn, async () => {
      const { newSignal } = await evalSignal(
        { node_id: NODE, service_id: 'missing_service', endpoint: '' },
        {
          kind: 'service_up',
          check: { mechanism: 'cli', command: 'systemctl is-active missing_service' },
          expect: 'active',
          last_state: 'healthy',
          last_checked_at: null,
          current_incident_id: null,
        },
        { userId: USER, notify: (content, opts) => notifications.push({ content, opts }) },
        12347,
      );
      expect(newSignal.last_state).toBe('unhealthy');
      expect(notifications.map(n => n.opts.event)).toEqual([
        'profile_health_unhealthy',
        'profile_health_action',
      ]);
      expect(notifications[1].content).toMatch(/cannot diagnose/i);
      expect(notifications[1].opts.data).toMatchObject({
        node_id: NODE,
        service_id: 'missing_service',
        signal_kind: 'service_up',
        incident_id: null,
      });
    });
  });
});
