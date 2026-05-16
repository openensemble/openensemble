import { getHaConfig, haRequest } from '../../lib/ha-client.mjs';

export async function executeSkillTool(name, args) {
  if (args?.__validate) return '';

  const haCfg = getHaConfig();
  if (!haCfg) {
    return 'Home Assistant is not configured. An administrator needs to set the URL and access token in Settings → Providers → Home Assistant.';
  }

  if (name === 'ha_list_devices') {
    const data = await haRequest(haCfg, '/states');
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
    const data = await haRequest(haCfg, `/states/${encodeURIComponent(args.entity_id)}`);
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
      [domain, service] = args.service.split('.');
    } else if (args.domain) {
      domain = args.domain;
      service = args.service;
    } else {
      domain = args.entity_id.split('.')[0];
      service = args.service;
    }
    const body = { entity_id: args.entity_id };
    if (args.data && typeof args.data === 'object') Object.assign(body, args.data);
    const data = await haRequest(haCfg, `/services/${domain}/${service}`, 'POST', body);
    if (data?.__err) return `Error: ${data.__err}`;
    // Read back state to confirm. Scenes/scripts/services that target a
    // non-stateful entity may not have a readable state — fall back to a
    // generic confirmation in that case.
    const state = await haRequest(haCfg, `/states/${encodeURIComponent(args.entity_id)}`);
    if (state?.__err) return `Called ${domain}.${service} on ${args.entity_id}.`;
    const bright = state.attributes?.brightness;
    const temp = state.attributes?.temperature;
    let suffix = '';
    if (bright != null) suffix = ` (brightness ${Math.round(bright / 255 * 100)}%)`;
    else if (temp != null) suffix = ` (${temp}°)`;
    return `Done. ${args.entity_id} is now ${state.state}${suffix}.`;
  }

  if (name === 'ha_list_areas') {
    const areas = await haRequest(haCfg, '/config/area_registry/list');
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
