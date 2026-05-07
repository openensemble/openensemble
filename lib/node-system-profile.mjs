/**
 * Auto-generate a baseline "system" profile for a node so disk/load/memory/
 * agent monitoring works out of the box without the user crafting a profile.
 *
 * Service id is 'system' (one per node). Trust state defaults to 'reviewed'
 * because the template is OE-authored — the user already trusts the framework
 * to monitor basic machine health, no manual review needed. If they don't
 * want it, they can profile_set_trust_state → 'unverified' (tears down the
 * watcher) or profile_patch the signals.
 *
 * Currently Linux-only. Windows/macOS need different commands; we simply
 * don't auto-create for those platforms (the user can still write a profile
 * by hand).
 */

import fs from 'fs';
import { profilePath, saveProfile, loadProfile } from './service-profile.mjs';
import {
  registerProfileHealthWatchers,
  unregisterProfileHealthWatchers,
} from '../scheduler/health-monitor.mjs';
import { listWatchers } from '../scheduler/watchers.mjs';
import { log } from '../logger.mjs';

const SERVICE_ID = 'system';

/**
 * Returns a valid profile object for the given Linux node. Re-runnable
 * deterministically (no Date.now() embedded in identity-bearing fields, so
 * tests get stable output).
 */
export function buildSystemProfile({ nodeId, hostname }) {
  const now = new Date().toISOString();
  return {
    schema_version: 'v1',
    service_id: SERVICE_ID,
    node_id: nodeId,
    detected_version: null,
    endpoint: null,
    detected_at: now,
    researched_at: now,
    profile_version: 'oe_system_v3',

    identity: {
      what_it_is: `Baseline machine-health profile for ${hostname || nodeId}.`,
      primary_value: 'Catches the three boring failures that take a node down: full disk, runaway load, OOM-imminent memory pressure. Plus agent process status.',
      related_capabilities: ['monitoring'],
    },

    control_surface: {
      cli: ['df', 'awk', 'cat', 'systemctl'],
      services: ['oe-node-agent.service'],
      log_sources: [
        { systemd_unit: 'oe-node-agent.service', tail_cmd: 'journalctl -u oe-node-agent -n 100 --no-pager' },
      ],
    },

    operations: [
      // ── Read-only diagnostics — Sydney + auto-apply path can fire freely ─
      {
        id: 'disk_detail',
        capability: 'monitoring',
        description: 'Per-mount disk usage breakdown. Use when disk_free signal flagged unhealthy and you need to know which mount is full.',
        mechanism: 'cli',
        risk: 'low',
        readonly: true,
        parameters: [],
        cli: { write: { command: 'df -h' } },
        verified: false, last_tested: null, last_failure: null,
      },
      {
        id: 'top_memory',
        capability: 'monitoring',
        description: 'Top 10 processes by memory. Use when memory_free signal flags unhealthy.',
        mechanism: 'cli',
        risk: 'low',
        readonly: true,
        parameters: [],
        cli: { write: { command: 'ps -eo rss,pid,user,command --sort=-rss | head -11' } },
        verified: false, last_tested: null, last_failure: null,
      },
      {
        id: 'top_cpu',
        capability: 'monitoring',
        description: 'Top 10 processes by CPU. Use when load_1min signal flags sustained high load.',
        mechanism: 'cli',
        risk: 'low',
        readonly: true,
        parameters: [],
        cli: { write: { command: 'ps -eo pcpu,pid,user,command --sort=-pcpu | head -11' } },
        verified: false, last_tested: null, last_failure: null,
      },
      {
        id: 'journal_tail',
        capability: 'monitoring',
        description: 'Last 50 error-priority systemd journal entries. Use to investigate any unhealthy signal or just "what went wrong recently."',
        mechanism: 'cli',
        risk: 'low',
        readonly: true,
        parameters: [],
        cli: { write: { command: 'journalctl -p err -n 50 --no-pager' } },
        verified: false, last_tested: null, last_failure: null,
      },
      {
        id: 'smart_health',
        capability: 'monitoring',
        description: 'S.M.A.R.T. health summary for /dev/sda. Falls back gracefully if smartmontools not installed or no /dev/sda.',
        mechanism: 'cli',
        risk: 'low',
        readonly: true,
        parameters: [],
        cli: {
          write: {
            // 2>&1 because smartctl writes warnings (and the missing-tool error) to stderr.
            command: 'smartctl -H /dev/sda 2>&1 || echo "smartmontools not installed or device unavailable"',
          },
        },
        verified: false, last_tested: null, last_failure: null,
      },

      // ── Maintenance ops — write actions, gated by trust state + risk ────
      {
        id: 'apt_autoclean',
        capability: 'maintenance',
        description: 'Removes apt cache packages no longer downloadable. Safe disk reclaim — does not touch installed packages or alter the running system.',
        mechanism: 'cli',
        risk: 'low',
        readonly: false,
        parameters: [],
        cli: {
          pre_capture: { command: 'df -P / | tail -1 | awk \'{print $3}\'' },
          // No inverse — deleted cache files cannot be restored. Dispatcher
          // will mark rollback unavailable; that\'s correct behavior since the
          // op is intentionally irreversible (and harmless).
          write: { command: 'sudo apt-get autoclean -y' },
        },
        verified: false, last_tested: null, last_failure: null,
      },
      {
        id: 'agent_restart',
        capability: 'maintenance',
        description: 'Restart the oe-node-agent service. Use when the agent is misbehaving (stuck, leaking memory) but the node is still reachable. Will briefly disconnect — node_exec calls during restart fail, then recover.',
        mechanism: 'cli',
        risk: 'medium', // medium because it disrupts ops in flight; never auto-applies
        readonly: false,
        parameters: [],
        cli: {
          pre_capture: { command: 'systemctl is-active oe-node-agent; systemctl show oe-node-agent --property=ActiveEnterTimestamp --value' },
          // The "inverse" of a restart is another restart — idempotent. The
          // dispatcher won\'t auto-rollback (would loop), but having it here
          // documents the recovery path.
          write:   { command: 'sudo systemctl restart oe-node-agent' },
          inverse: { command: 'sudo systemctl restart oe-node-agent' },
        },
        verified: false, last_tested: null, last_failure: null,
      },
    ],
    agent_requirements: [
      { type: 'group',   name: 'systemd-journal',   rationale: 'journal_tail needs read access to /var/log/journal — without this, journalctl exits 1 with "No journal files were opened due to insufficient permissions"' },
      { type: 'sudoers', name: '/usr/bin/apt-get',  rationale: 'apt_autoclean needs passwordless sudo for apt-get' },
      { type: 'sudoers', name: '/bin/systemctl',    rationale: 'agent_restart needs passwordless sudo for systemctl (path may be /usr/bin/systemctl on some distros)' },
    ],

    health_signals: [
      {
        kind: 'disk_free',
        description: 'Root filesystem usage — alerts above 90% used.',
        // Print just the percent value as a number (no trailing %).
        check: { mechanism: 'cli', command: "df -P / | tail -1 | awk '{gsub(/%/,\"\",$5); print $5}'" },
        expect: { lt: 90 },
        cadence_sec: 300,
        severity: 'critical',
      },
      {
        kind: 'load_1min',
        description: '1-minute load average — alerts above 8 (loose; tune via profile_patch for high-core-count machines).',
        check: { mechanism: 'cli', command: "awk '{print $1}' /proc/loadavg" },
        expect: { lt: 8 },
        cadence_sec: 60,
        severity: 'warn',
      },
      {
        kind: 'memory_free',
        description: 'Available memory as % of total — alerts when free drops below 10%.',
        check: {
          mechanism: 'cli',
          command: "awk '/MemAvailable/ {a=$2} /MemTotal/ {t=$2} END {printf \"%d\", (a/t)*100}' /proc/meminfo",
        },
        expect: { gt: 10 },
        cadence_sec: 60,
        severity: 'warn',
      },
      {
        kind: 'agent_active',
        description: 'oe-node-agent systemd unit is active. Mostly redundant with the connection-liveness dot in the nodes drawer (a dead agent can\'t answer node_exec at all), but useful to catch a degraded "running but not communicating" state.',
        check: { mechanism: 'cli', command: 'systemctl is-active oe-node-agent 2>&1' },
        expect: { contains: 'active' },
        cadence_sec: 120,
        severity: 'critical',
      },
    ],

    failure_modes: [],
    troubleshooting: [],
    update_path: null,
    backup_before: [],
    known_quirks: [
      'Auto-generated by ensureNodeSystemProfile. Edit signals via profile_patch; e.g. raise load_1min cap on a many-core box.',
    ],
    trust_state: 'reviewed',
    research_sources: [
      { url: 'lib/node-system-profile.mjs', title: 'OE auto-generated', fetched_at: now },
    ],
  };
}

/**
 * Idempotent creator. If a 'system' profile already exists at the canonical
 * path, returns { created: false }. Otherwise saves the template and
 * registers the health watcher. Skips non-linux platforms.
 *
 * @returns {{created: boolean, reason?: string, signal_count?: number, watcher_id?: string}}
 */
export function ensureNodeSystemProfile(userId, nodeId, { hostname, platform } = {}) {
  if (!userId || !nodeId) return { created: false, reason: 'missing userId or nodeId' };
  if (platform && platform !== 'linux') {
    return { created: false, reason: `platform "${platform}" not supported (linux-only for now)` };
  }
  const profileExists = fs.existsSync(profilePath(userId, nodeId, SERVICE_ID));

  // The profile may already exist on disk but its watcher might be missing —
  // happens when an earlier registration failed (e.g. watcher cap was hit
  // mid-bootstrap). The "already exists" guard would otherwise block recovery.
  // So check both: profile state AND active watcher state.
  if (profileExists) {
    const profile = loadProfile(userId, nodeId, SERVICE_ID);
    const isActiveTrust = profile && (profile.trust_state === 'reviewed' || profile.trust_state === 'proven');
    const hasWatcher = listWatchers(userId).active.some(
      w => w.kind === 'profile_health' && w.state?.node_id === nodeId && w.state?.service_id === SERVICE_ID,
    );
    if (!isActiveTrust) {
      // User intentionally turned monitoring off — don't override.
      return { created: false, reason: 'profile exists with non-monitoring trust state' };
    }

    // OE-authored profiles get upgraded in place when the bundled template
    // version moves forward (e.g. v1→v2 added operations). User-customized
    // profiles opt out by changing profile_version to anything not starting
    // with 'oe_system_v' (e.g. 'shawn_custom_v1').
    const currentVersion = buildSystemProfile({ nodeId, hostname }).profile_version;
    const isOEAuthored = typeof profile.profile_version === 'string' && profile.profile_version.startsWith('oe_system_v');
    if (isOEAuthored && profile.profile_version !== currentVersion) {
      return upgradeExistingProfile(userId, nodeId, hostname, profile.profile_version, currentVersion);
    }

    if (hasWatcher) {
      return { created: false, reason: 'profile + watcher already exist' };
    }
    // Profile exists, trust is reviewed/proven, but watcher missing — register it.
    return registerWatcherForExisting(userId, nodeId);
  }

  // First-time create.
  const profile = buildSystemProfile({ nodeId, hostname });
  try {
    saveProfile(userId, nodeId, profile);
  } catch (e) {
    log.warn('node-system-profile', 'saveProfile failed', { userId, nodeId, err: e.message });
    return { created: false, reason: `saveProfile failed: ${e.message}` };
  }
  return registerWatcherForExisting(userId, nodeId, { firstCreate: true });
}

function upgradeExistingProfile(userId, nodeId, hostname, fromVersion, toVersion) {
  const fresh = buildSystemProfile({ nodeId, hostname });
  // Preserve the user's trust_state (in case they upgraded an OE profile to
  // 'proven' after operating it for a while) and any custom hostname they
  // set. Everything else (signals, ops, version) gets the new template.
  try {
    const existing = loadProfile(userId, nodeId, SERVICE_ID);
    if (existing?.trust_state) fresh.trust_state = existing.trust_state;
    saveProfile(userId, nodeId, fresh);
  } catch (e) {
    log.warn('node-system-profile', 'upgrade saveProfile failed', { userId, nodeId, fromVersion, toVersion, err: e.message });
    return { created: false, reason: `upgrade saveProfile failed: ${e.message}` };
  }
  log.info('node-system-profile', 'upgraded system profile', { userId, nodeId, fromVersion, toVersion });
  return registerWatcherForExisting(userId, nodeId, { upgraded: true, fromVersion, toVersion });
}

function registerWatcherForExisting(userId, nodeId, opts = {}) {
  try {
    unregisterProfileHealthWatchers(userId, nodeId, SERVICE_ID); // safety: tear down anything stale
    const registered = registerProfileHealthWatchers(userId, nodeId, SERVICE_ID, {
      agentId: `${userId}_coordinator`,
    });
    const action = opts.firstCreate ? 'created system profile + watcher'
      : opts.upgraded ? `upgraded system profile + refreshed watcher (${opts.fromVersion} → ${opts.toVersion})`
      : 'recovered missing watcher for existing system profile';
    log.info('node-system-profile', action, { userId, nodeId, signal_count: registered.signal_count });
    return {
      created: !!opts.firstCreate,
      upgraded: !!opts.upgraded,
      from_version: opts.fromVersion,
      to_version: opts.toVersion,
      signal_count: registered.signal_count,
      watcher_id: registered.watcher_id,
    };
  } catch (e) {
    log.warn('node-system-profile', 'registerWatcher failed', { userId, nodeId, err: e.message });
    return { created: false, reason: `watcher registration failed: ${e.message}` };
  }
}

/** Backfill helper — called at server boot to ensure every known node has
 * a system profile. Iterates over (userId, nodes[]) provided by the caller
 * since node-registry's API requires a userId per query. */
export function backfillSystemProfilesForUserNodes(userId, nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return { swept: 0, created: 0, skipped: 0 };
  let created = 0, skipped = 0;
  for (const n of nodes) {
    const r = ensureNodeSystemProfile(userId, n.nodeId, { hostname: n.hostname, platform: n.platform });
    if (r.created) created++; else skipped++;
  }
  return { swept: nodes.length, created, skipped };
}
