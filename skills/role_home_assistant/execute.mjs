import { getHaConfig, haRequest } from '../../lib/ha-client.mjs';
import {
  callHaServiceAndConfirm,
  listHaStates,
  readHaState,
} from '../../lib/ha-service.mjs';
import {
  isHaWebSocketReady,
  sendHaWebSocketCommand,
} from '../../lib/ha-websocket.mjs';

const HA_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,63}$/;
const HA_ENTITY_ID_RE = /^[a-z][a-z0-9_]{0,63}\.[a-z0-9_]{1,255}$/;

function formatState(state) {
  if (!state || typeof state !== 'object') return '';
  const bright = state.attributes?.brightness;
  const temp = state.attributes?.temperature;
  let suffix = '';
  if (bright != null) suffix = ` (brightness ${Math.round(bright / 255 * 100)}%)`;
  else if (temp != null) suffix = ` (${temp}°)`;
  return `${state.state}${suffix}`;
}

export async function executeSkillTool(name, args) {
  if (args?.__validate) return '';

  const haCfg = getHaConfig();
  if (!haCfg) {
    return 'Home Assistant is not configured. An administrator needs to set the URL and access token in Settings → Providers → Home Assistant.';
  }

  if (name === 'ha_list_devices') {
    const data = await listHaStates(haCfg);
    if (data?.__err) return `Error: ${data.__err}`;
    if (!Array.isArray(data)) return 'Unexpected response from Home Assistant.';
    let entities = data;
    if (args.domain) {
      const dom = String(args.domain).toLowerCase();
      entities = entities.filter(e => e.entity_id.startsWith(`${dom}.`));
    }
    const lines = entities.map(e => {
      const label = e.attributes?.friendly_name || e.entity_id;
      return `${e.entity_id} | ${label} | ${e.state}`;
    });
    return `Found ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}:\n\nentity_id | friendly_name | state\n${lines.join('\n')}`;
  }

  if (name === 'ha_get_state') {
    if (!args.entity_id) return 'Error: entity_id is required.';
    const data = await readHaState(haCfg, args.entity_id);
    if (data?.__err) return `Error: ${data.__err}`;
    return JSON.stringify({
      entity_id: data.entity_id,
      state: data.state,
      attributes: data.attributes,
      last_changed: data.last_changed,
    }, null, 2);
  }

  if (name === 'ha_call_service') {
    if (!args.service || !args.entity_id) return 'Error: service and entity_id are required.';
    let domain, service;
    if (args.service.includes('.')) {
      const parts = args.service.split('.');
      if (parts.length !== 2) return 'Error: service must be a single HA service name or domain.service.';
      [domain, service] = parts;
    } else if (args.domain) {
      domain = args.domain;
      service = args.service;
    } else {
      domain = args.entity_id.split('.')[0];
      service = args.service;
    }
    if (!HA_IDENTIFIER_RE.test(String(domain || ''))
        || !HA_IDENTIFIER_RE.test(String(service || ''))
        || !HA_ENTITY_ID_RE.test(String(args.entity_id || ''))) {
      return 'Error: invalid Home Assistant domain, service, or entity_id.';
    }
    const result = await callHaServiceAndConfirm({
      haCfg,
      domain,
      service,
      entityId: args.entity_id,
      data: args.data && typeof args.data === 'object' ? args.data : {},
    });
    if (!result.accepted) return `Error: ${result.error}`;
    if (result.confirmed === true) {
      return `Done. ${args.entity_id} is now ${formatState(result.state)}.`;
    }
    if (result.pending) {
      const latest = formatState(result.state);
      return `Home Assistant accepted ${domain}.${service} for ${args.entity_id}, but confirmation is still pending`
        + `${result.expected ? ` (expected ${result.expected})` : ''}`
        + `${latest ? `. Latest reported state: ${latest}` : ''}.`;
    }
    return `Home Assistant accepted ${domain}.${service} for ${args.entity_id}.`;
  }

  if (name === 'ha_list_areas') {
    let areas;
    if (isHaWebSocketReady()) {
      try { areas = await sendHaWebSocketCommand('config/area_registry/list'); }
      catch { areas = null; }
    }
    if (!Array.isArray(areas)) {
      areas = await haRequest(haCfg, '/config/area_registry/list');
    }
    if (areas?.__err) return `Areas API unavailable (${areas.__err}). Try listing entities by domain instead.`;
    if (!Array.isArray(areas)) return 'Unexpected response from Home Assistant.';
    if (areas.length === 0) return 'No areas configured in Home Assistant.';
    const lines = areas.map(a => `${a.area_id} | ${a.name}`);
    return `Areas:\n\narea_id | name\n${lines.join('\n')}`;
  }

  if (name === 'ha_list_services') {
    const data = await haRequest(haCfg, '/services');
    if (data?.__err) return `Error: ${data.__err}`;
    if (!Array.isArray(data)) return 'Unexpected response from Home Assistant.';
    let services = data;
    if (args.domain) services = services.filter(s => s.domain === args.domain);
    const lines = services.flatMap(s =>
      Object.keys(s.services || {}).map(svc => `${s.domain}.${svc}`)
    );
    return `Services:\n${lines.join('\n')}`;
  }

  return null;
}

export default executeSkillTool;
