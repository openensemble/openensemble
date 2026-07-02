import { ensureNodeSystemProfile } from './node-system-profile.mjs';
import { loadProfile, saveProfile, setTrustState } from './service-profile.mjs';
import { getNodeProfilesSummary } from './node-profile-summary.mjs';
import {
  registerProfileHealthWatchers,
  unregisterProfileHealthWatchers,
} from '../scheduler/health-monitor.mjs';

export const ONBOARDING_SCOPES = new Set(['safe', 'no_restart', 'include_restart']);

const SERVICE_DEFS = {
  pihole: {
    label: 'Pi-hole',
    capabilities: ['dns', 'dhcp'],
    binaries: ['pihole'],
    paths: ['/etc/pihole'],
    units: ['pihole-FTL.service'],
    logs: [{ systemd_unit: 'pihole-FTL.service', tail_cmd: 'journalctl -u pihole-FTL -n 100 --no-pager' }],
  },
  home_assistant: {
    label: 'Home Assistant',
    capabilities: ['home_automation'],
    binaries: ['home-assistant', 'hass'],
    units: ['home-assistant.service', 'home-assistant@homeassistant.service', 'hassio-supervisor.service'],
    logs: [{ systemd_unit: 'home-assistant.service', tail_cmd: 'journalctl -u home-assistant -n 100 --no-pager' }],
  },
  nginx: {
    label: 'nginx',
    capabilities: ['web'],
    binaries: ['nginx'],
    paths: ['/etc/nginx'],
    units: ['nginx.service'],
    logs: [{ systemd_unit: 'nginx.service', tail_cmd: 'journalctl -u nginx -n 100 --no-pager' }],
  },
  caddy: {
    label: 'Caddy',
    capabilities: ['web'],
    binaries: ['caddy'],
    paths: ['/etc/caddy'],
    units: ['caddy.service'],
    logs: [{ systemd_unit: 'caddy.service', tail_cmd: 'journalctl -u caddy -n 100 --no-pager' }],
  },
  mariadb: {
    label: 'MariaDB/MySQL',
    capabilities: ['database'],
    binaries: ['mariadbd', 'mysqld'],
    paths: ['/var/lib/mysql', '/var/lib/mariadb'],
    units: ['mariadb.service', 'mysql.service'],
    logs: [{ systemd_unit: 'mariadb.service', tail_cmd: 'journalctl -u mariadb -n 100 --no-pager' }],
  },
  postgresql: {
    label: 'PostgreSQL',
    capabilities: ['database'],
    binaries: ['postgres'],
    paths: ['/var/lib/postgresql'],
    units: ['postgresql.service'],
    logs: [{ systemd_unit: 'postgresql.service', tail_cmd: 'journalctl -u postgresql -n 100 --no-pager' }],
  },
  redis: {
    label: 'Redis',
    capabilities: ['cache'],
    binaries: ['redis-server'],
    units: ['redis-server.service', 'redis.service'],
    logs: [{ systemd_unit: 'redis-server.service', tail_cmd: 'journalctl -u redis-server -n 100 --no-pager' }],
  },
  tailscale: {
    label: 'Tailscale',
    capabilities: ['networking', 'vpn'],
    binaries: ['tailscale'],
    paths: ['/etc/tailscale'],
    units: ['tailscaled.service'],
    logs: [{ systemd_unit: 'tailscaled.service', tail_cmd: 'journalctl -u tailscaled -n 100 --no-pager' }],
  },
  mosquitto: {
    label: 'Mosquitto',
    capabilities: ['mqtt'],
    binaries: ['mosquitto'],
    paths: ['/etc/mosquitto'],
    units: ['mosquitto.service'],
    logs: [{ systemd_unit: 'mosquitto.service', tail_cmd: 'journalctl -u mosquitto -n 100 --no-pager' }],
  },
  vaultwarden: {
    label: 'Vaultwarden',
    capabilities: ['password_vault'],
    binaries: ['vaultwarden', 'bw'],
    paths: ['/opt/vaultwarden'],
    units: ['vaultwarden.service'],
    logs: [{ systemd_unit: 'vaultwarden.service', tail_cmd: 'journalctl -u vaultwarden -n 100 --no-pager' }],
  },
  nfs: {
    label: 'NFS',
    capabilities: ['file_sharing'],
    binaries: ['rpc.nfsd', 'exportfs'],
    paths: ['/etc/exports', '/etc/exports.d', '/proc/fs/nfsd', '/var/lib/nfs'],
    units: ['nfs-server.service', 'nfs-kernel-server.service', 'nfsd.service'],
    logs: [{ systemd_unit: 'nfs-server.service', tail_cmd: 'journalctl -u nfs-server -n 100 --no-pager' }],
  },
  bind9: {
    label: 'BIND9',
    capabilities: ['dns'],
    binaries: ['named'],
    paths: ['/etc/bind'],
    units: ['bind9.service', 'named.service'],
    logs: [{ systemd_unit: 'bind9.service', tail_cmd: 'journalctl -u bind9 -n 100 --no-pager' }],
  },
  unbound: {
    label: 'Unbound',
    capabilities: ['dns'],
    binaries: ['unbound'],
    paths: ['/etc/unbound'],
    units: ['unbound.service'],
    logs: [{ systemd_unit: 'unbound.service', tail_cmd: 'journalctl -u unbound -n 100 --no-pager' }],
  },
  coredns: {
    label: 'CoreDNS',
    capabilities: ['dns'],
    binaries: ['coredns'],
    paths: ['/etc/coredns'],
    units: ['coredns.service'],
  },
  knot_resolver: {
    label: 'Knot Resolver',
    capabilities: ['dns'],
    binaries: ['kresd'],
    paths: ['/etc/knot-resolver'],
    units: ['kresd.service', 'knot-resolver.service'],
  },
  nsd: {
    label: 'NSD',
    capabilities: ['dns'],
    binaries: ['nsd'],
    paths: ['/etc/nsd'],
    units: ['nsd.service'],
  },
  dhcp_server: {
    label: 'DHCP server',
    capabilities: ['dhcp'],
    binaries: ['dhcpd', 'kea-dhcp4-server'],
    paths: ['/etc/dhcp'],
    units: ['isc-dhcp-server.service', 'kea-dhcp4-server.service', 'dhcpd.service'],
  },
  tftp_server: {
    label: 'TFTP server',
    capabilities: ['tftp', 'pxe'],
    binaries: ['tftpd-hpa', 'in.tftpd', 'atftpd'],
    paths: ['/var/lib/tftpboot', '/srv/tftp', '/srv/tftpboot'],
    units: ['tftpd-hpa.service', 'tftp.service', 'atftpd.service'],
  },
  dnsmasq: {
    label: 'dnsmasq',
    capabilities: ['dns', 'dhcp', 'tftp'],
    binaries: ['dnsmasq'],
    paths: ['/etc/dnsmasq.conf', '/etc/dnsmasq.d'],
    units: ['dnsmasq.service'],
    logs: [{ systemd_unit: 'dnsmasq.service', tail_cmd: 'journalctl -u dnsmasq -n 100 --no-pager' }],
  },
};

function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildServiceProbeScript() {
  const binaries = [...new Set(Object.values(SERVICE_DEFS).flatMap(d => d.binaries || []))].sort();
  const paths = [...new Set(Object.values(SERVICE_DEFS).flatMap(d => d.paths || []))].sort();
  return [
    'echo "::binaries::"',
    `for b in ${binaries.map(shq).join(' ')}; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done`,
    'echo "::paths::"',
    `for p in ${paths.map(shq).join(' ')}; do test -e "$p" && echo "$p"; done`,
    'echo "::services::"',
    "systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}' | head -80",
    'echo "::flags::"',
    "grep -lq '^[[:space:]]*dhcp-range=' /etc/dnsmasq.conf /etc/dnsmasq.d/*.conf 2>/dev/null && echo dnsmasq_dhcp_enabled || true",
    "grep -lq '^[[:space:]]*tftp-root=' /etc/dnsmasq.conf /etc/dnsmasq.d/*.conf 2>/dev/null && echo dnsmasq_tftp_enabled || true",
  ].join(' && ');
}

export function parseServiceProbeOutput(output) {
  const sections = { binaries: [], paths: [], services: [], flags: [] };
  let current = null;
  for (const line of String(output || '').split('\n').map(s => s.trim()).filter(Boolean)) {
    const m = line.match(/^::(binaries|paths|services|flags)::$/);
    if (m) {
      current = m[1];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return sections;
}

function sectionHas(sections, key, value) {
  return (sections[key] || []).some(v => v === value || v.includes(value));
}

function addDetected(out, kind, evidence) {
  if (!SERVICE_DEFS[kind]) return;
  if (out.some(d => d.kind === kind)) return;
  out.push({ kind, label: SERVICE_DEFS[kind].label, evidence });
}

export function detectKnownServicesFromProbe(output) {
  const sections = typeof output === 'string' ? parseServiceProbeOutput(output) : output;
  const detected = [];
  const hasFlag = (flag) => sections.flags.includes(flag);
  const serviceActive = (def) => (def.units || []).some(u => sections.services.includes(u));
  const present = (kind) => {
    const def = SERVICE_DEFS[kind];
    return serviceActive(def)
      || (def.binaries || []).some(b => sectionHas(sections, 'binaries', b))
      || (def.paths || []).some(p => sectionHas(sections, 'paths', p));
  };

  for (const kind of Object.keys(SERVICE_DEFS)) {
    if (kind === 'dhcp_server' || kind === 'tftp_server' || kind === 'dnsmasq') continue;
    if (present(kind)) addDetected(detected, kind, ['known binary, service, or config path present']);
  }

  const dnsmasqPresent = present('dnsmasq');
  if (dnsmasqPresent) {
    if (hasFlag('dnsmasq_dhcp_enabled') && !detected.some(d => d.kind === 'pihole')) {
      addDetected(detected, 'dhcp_server', ['dnsmasq DHCP range configured']);
    }
    if (hasFlag('dnsmasq_tftp_enabled')) {
      addDetected(detected, 'tftp_server', ['dnsmasq TFTP root configured']);
    }
    if (!hasFlag('dnsmasq_dhcp_enabled') && !hasFlag('dnsmasq_tftp_enabled') && !detected.some(d => d.kind === 'pihole')) {
      addDetected(detected, 'dnsmasq', ['dnsmasq present']);
    }
  }
  if (present('dhcp_server')) addDetected(detected, 'dhcp_server', ['DHCP service present']);
  if (present('tftp_server')) addDetected(detected, 'tftp_server', ['TFTP service present']);
  return detected;
}

function activeUnitCommand(units) {
  const list = (units || []).map(shq).join(' ');
  return `for u in ${list}; do state=$(systemctl is-active "$u" 2>/dev/null || true); if [ "$state" = "active" ]; then echo "active:$u"; exit 0; fi; done; echo inactive`;
}

function statusCommand(units) {
  const list = (units || []).map(shq).join(' ');
  return `for u in ${list}; do systemctl status "$u" --no-pager 2>&1 && exit 0; done; echo "No known unit active"`;
}

export function buildMonitoringServiceProfile({ nodeId, hostname, kind }) {
  const def = SERVICE_DEFS[kind];
  if (!def) throw new Error(`unknown service kind "${kind}"`);
  const now = new Date().toISOString();
  const activeCmd = activeUnitCommand(def.units);
  return {
    schema_version: 'v1',
    service_id: kind,
    node_id: nodeId,
    detected_version: null,
    endpoint: null,
    detected_at: now,
    researched_at: now,
    profile_version: `oe_monitor_${kind}_v1`,
    identity: {
      what_it_is: `${def.label} detected on ${hostname || nodeId}.`,
      primary_value: `Keeps ${def.label} visible in node System Health with a read-only service liveness check.`,
      related_capabilities: def.capabilities || [],
    },
    control_surface: {
      cli: def.binaries || [],
      services: def.units || [],
      log_sources: def.logs || [],
    },
    operations: [
      {
        id: 'service_status',
        capability: 'monitoring',
        description: `Read recent systemd status for ${def.label}.`,
        mechanism: 'cli',
        risk: 'low',
        readonly: true,
        parameters: [],
        cli: { write: { command: statusCommand(def.units) } },
        verified: false,
        last_tested: null,
        last_failure: null,
      },
    ],
    health_signals: [
      {
        kind: 'service_up',
        description: `${def.label} has an active systemd unit.`,
        check: { mechanism: 'cli', command: activeCmd },
        expect: { contains: 'active:' },
        cadence_sec: 60,
        severity: 'critical',
      },
    ],
    diagnostic_recipes: {
      service_up: [
        { mechanism: 'cli', command: statusCommand(def.units), interpretation: `Inspect ${def.label} unit status.` },
      ],
    },
    failure_modes: [],
    troubleshooting: [],
    update_path: null,
    backup_before: [],
    known_quirks: [
      'Auto-generated monitoring-only profile. Add a researched service profile later for safe operations and fixes.',
    ],
    agent_requirements: [],
    trust_state: 'reviewed',
    trust_state_changed_at: now,
    trust_state_changed_by: 'node-onboarding',
    research_sources: [
      { url: 'lib/node-onboarding.mjs', title: 'OE auto-generated monitoring profile', fetched_at: now },
    ],
  };
}

function registerProfileWatcher(userId, nodeId, serviceId) {
  const profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) return null;
  unregisterProfileHealthWatchers(userId, nodeId, serviceId);
  if (!(profile.health_signals || []).length) return null;
  return registerProfileHealthWatchers(userId, nodeId, serviceId, {
    agentId: `${userId}_coordinator`,
  });
}

function approveProfileForMonitoring(userId, nodeId, serviceId) {
  let profile = loadProfile(userId, nodeId, serviceId);
  if (!profile) throw new Error(`profile ${serviceId} missing`);
  if (profile.trust_state === 'unverified') {
    profile = setTrustState(userId, nodeId, serviceId, 'reviewed', 'node-onboarding');
  }
  const watcher = registerProfileWatcher(userId, nodeId, serviceId);
  return { profile, watcher };
}

export async function runNodeOnboarding({ userId, node, scope = 'safe', execFn }) {
  const normalizedScope = ONBOARDING_SCOPES.has(scope) ? scope : 'safe';
  const nodeId = node?.nodeId;
  const result = {
    status: 'partial',
    scope: normalizedScope,
    checkedAt: new Date().toISOString(),
    host: null,
    services: { detected: [], onboarded: [], skipped: [] },
    skipped: [],
    warnings: [],
  };
  if (!userId || !nodeId) throw new Error('userId and node.nodeId are required');

  const ensured = ensureNodeSystemProfile(userId, nodeId, { hostname: node.hostname, platform: node.platform });
  if (node.platform && node.platform !== 'linux') {
    result.skipped.push({ kind: 'host', reason: ensured.reason || 'host health is linux-only for now' });
  } else {
    try {
      const { watcher } = approveProfileForMonitoring(userId, nodeId, 'system');
      result.host = { service_id: 'system', onboarded: true, watcher_id: watcher?.watcher_id || null };
    } catch (e) {
      result.host = { service_id: 'system', onboarded: false, error: e.message };
      result.skipped.push({ kind: 'system', reason: e.message });
    }
  }

  if (!execFn) {
    result.skipped.push({ kind: 'service_detection', reason: 'node exec unavailable' });
  } else {
    try {
      const probe = await execFn(buildServiceProbeScript());
      const output = probe?.stdout || '';
      const detected = detectKnownServicesFromProbe(output);
      result.services.detected = detected;
      for (const svc of detected) {
        try {
          if (!loadProfile(userId, nodeId, svc.kind)) {
            saveProfile(userId, nodeId, buildMonitoringServiceProfile({
              nodeId,
              hostname: node.hostname,
              kind: svc.kind,
            }));
          }
          const { watcher } = approveProfileForMonitoring(userId, nodeId, svc.kind);
          result.services.onboarded.push({
            kind: svc.kind,
            label: svc.label,
            watcher_id: watcher?.watcher_id || null,
          });
        } catch (e) {
          result.services.skipped.push({ kind: svc.kind, label: svc.label, reason: e.message });
        }
      }
    } catch (e) {
      result.skipped.push({ kind: 'service_detection', reason: e.message });
    }
  }

  const missing = [];
  if (!result.host?.onboarded) missing.push('host');
  const onboardedKinds = new Set(result.services.onboarded.map(s => s.kind));
  for (const svc of result.services.detected) {
    if (!onboardedKinds.has(svc.kind)) missing.push(svc.kind);
  }
  if (!missing.length && !result.skipped.length && !result.services.skipped.length) {
    result.status = 'full';
  } else {
    result.status = 'partial';
  }
  result.summary = result.status === 'full'
    ? `Fully onboarded ${1 + result.services.onboarded.length} profile${result.services.onboarded.length ? 's' : ''}.`
    : `Partially onboarded; ${missing.length + result.skipped.length + result.services.skipped.length} item(s) need attention.`;
  result.profiles = getNodeProfilesSummary(userId, nodeId, node.hostname);
  return result;
}

export function summarizeNodeSystemHealth({ node, profiles = [], onboarding = null, autoFixEnabled = false } = {}) {
  const summaries = Array.isArray(profiles) ? profiles : [];
  const services = summaries.filter(p => p.service_id !== 'system');
  const totalChecks = summaries.reduce((n, p) => n + (p.signals_total || 0), 0);
  const activeChecks = summaries.reduce((n, p) => n + (p.watcher_active ? (p.signals_total || 0) : 0), 0);
  const failingChecks = summaries.reduce((n, p) => n + (p.signals_unhealthy || 0), 0);
  const pendingChecks = summaries.reduce((n, p) => n + (p.signals_unknown || 0), 0);
  const inactiveProfiles = summaries.filter(p => p.signals_total > 0 && !p.watcher_active).length;
  const draftProfiles = summaries.filter(p => p.trust_state === 'unverified').length;
  const activeProfiles = summaries.filter(p => p.trust_state !== 'unverified' && p.watcher_active).length;
  let onboardingStatus = onboarding?.status || (activeProfiles ? 'partial' : 'not_started');
  if (onboardingStatus === 'full' && (draftProfiles > 0 || inactiveProfiles > 0 || totalChecks === 0)) {
    onboardingStatus = activeProfiles ? 'partial' : 'not_started';
  }

  let status = 'healthy';
  if (node?.health === 'disconnected' || node?.health === 'stale' || failingChecks > 0) {
    status = 'failed';
  } else if (
    onboardingStatus !== 'full' ||
    inactiveProfiles > 0 ||
    draftProfiles > 0 ||
    pendingChecks > 0 ||
    totalChecks === 0
  ) {
    status = 'degraded';
  }

  const label = status === 'healthy' ? 'Healthy' : status === 'failed' ? 'Failed' : 'Degraded';
  const autoFixAvailable = onboardingStatus === 'full' && totalChecks > 0;
  const detailParts = [];
  detailParts.push(`${activeChecks}/${totalChecks || 0} checks active`);
  detailParts.push(`${services.length} managed service${services.length === 1 ? '' : 's'}`);
  if (pendingChecks) detailParts.push(`${pendingChecks} pending`);
  if (failingChecks) detailParts.push(`${failingChecks} failing`);
  if (draftProfiles || inactiveProfiles) detailParts.push(`${draftProfiles + inactiveProfiles} not active`);

  return {
    status,
    label,
    totalChecks,
    activeChecks,
    failingChecks,
    pendingChecks,
    managedServices: services.length,
    onboardingStatus,
    onboardedLabel: onboardingStatus === 'full'
      ? 'Fully onboarded'
      : onboardingStatus === 'partial'
        ? 'Partially onboarded'
        : 'Not onboarded',
    autoFixEnabled: !!autoFixEnabled,
    autoFixAvailable,
    detail: detailParts.join(' · '),
    skipped: [
      ...(onboarding?.skipped || []),
      ...(onboarding?.services?.skipped || []),
    ],
  };
}
