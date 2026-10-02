// Build the routine picker from HA's device registry, service selectors and
// entity capabilities. The saved action remains an ordinary HA service call.
import { getHaConfig } from './ha-client.mjs';
import { sendHaWebSocketCommand, listCachedHaStates, isHaWebSocketReady } from './ha-websocket.mjs';

const TTL_MS = 60_000;
let cached = null;
let inflight = null;
let generation = 0;
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const title = value => String(value).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const matchesOne = (wanted, value) => array(wanted).some(item => array(value).includes(item));

export function invalidateHaDeviceCatalog() {
  generation++;
  cached = null;
  inflight = null;
}

function matchesFilter(filter, state, registry) {
  if (!filter || typeof filter !== 'object') return true;
  if (filter.domain && !matchesOne(filter.domain, state.entity_id.split('.')[0])) return false;
  if (filter.integration && !matchesOne(filter.integration, registry.platform)) return false;
  if (filter.device_class && !matchesOne(filter.device_class, state.attributes?.device_class)) return false;
  if (filter.supported_features && !array(filter.supported_features).some(flag =>
    Number.isInteger(flag) && ((state.attributes?.supported_features || 0) & flag) === flag)) return false;
  return Object.entries(filter.attribute || {}).every(([key, values]) => matchesOne(values, state.attributes?.[key]));
}

function stateOptions(state, attribute) {
  const a = state.attributes || {};
  if (attribute) {
    const key = { effect: 'effect_list', source: 'source_list', sound_mode: 'sound_mode_list',
      fan_speed: 'fan_speed_list', operation_mode: 'operation_list', mode: 'available_modes' }[attribute];
    return a[key] || a[`${attribute}s`] || a[`${attribute}_list`] || [];
  }
  const domain = state.entity_id.split('.')[0];
  return a[{ climate: 'hvac_modes', select: 'options', input_select: 'options',
    water_heater: 'operation_list', humidifier: 'available_modes' }[domain]] || [];
}

function makeField(key, definition, state) {
  const selector = definition.selector || {};
  const a = state.attributes || {};
  const domain = state.entity_id.split('.')[0];
  const base = { key, label: definition.name || ({ hvac_mode: 'Operating mode', temperature: 'Target temperature' }[key]) || title(key), required: definition.required === true };
  const deviceValues = stateOptions(state, ['hvac_mode', 'option'].includes(key) ? undefined : key);
  if (selector.state || selector.select || selector.constant || deviceValues.length) {
    const values = deviceValues.length ? deviceValues : selector.state ? stateOptions(state, selector.state.attribute)
      : selector.constant ? [selector.constant.value] : selector.select.options;
    const options = array(values).filter(value => value != null).map(value =>
      typeof value === 'object' ? { value: value.value, label: value.label || title(value.value) }
        : { value, label: title(value) });
    const hidden = selector.state?.hide_states || [];
    const allowed = options.filter(option => !hidden.includes(option.value));
    if (!allowed.length || selector.state?.multiple || selector.select?.multiple) return null;
    return { ...base, kind: 'select', options: allowed };
  }
  if (selector.number || selector.color_temp || (['number', 'input_number'].includes(domain) && key === 'value')) {
    const config = selector.number || selector.color_temp || {};
    let { min, max, step, unit_of_measurement: unit } = config;
    if (domain === 'climate' && ['temperature', 'target_temp_low', 'target_temp_high'].includes(key)) {
      min = a.min_temp ?? min; max = a.max_temp ?? max; step = a.target_temp_step ?? step;
    } else if (['number', 'input_number'].includes(domain) && key === 'value') {
      min = a.min; max = a.max; step = a.step; unit = a.unit_of_measurement;
    } else if (key === 'humidity') {
      min = a.min_humidity ?? min; max = a.max_humidity ?? max;
    } else if (key === 'color_temp_kelvin') {
      min = a.min_color_temp_kelvin ?? min; max = a.max_color_temp_kelvin ?? max; unit = 'K';
    }
    return { ...base, kind: 'number', ...(Number.isFinite(min) ? { min } : {}),
      ...(Number.isFinite(max) ? { max } : {}), ...(Number.isFinite(step) && step > 0 ? { step } : {}),
      ...(unit ? { unit } : {}) };
  }
  if (selector.boolean) return { ...base, kind: 'boolean' };
  if (selector.color_rgb) return { ...base, kind: 'color' };
  if (selector.text && !selector.text.multiple) return { ...base, kind: 'text',
    ...(Number.isFinite(a.min) ? { minLength: a.min } : {}), ...(Number.isFinite(a.max) ? { maxLength: a.max } : {}) };
  // Complex selectors remain available through the advanced service editor.
  // Never offer a guessed value for a state or an unsupported required field.
  return null;
}

function flattenFields(fields) {
  return Object.entries(fields || {}).flatMap(([key, definition]) => definition.fields
    ? flattenFields(definition.fields) : [[key, definition]]);
}

export function buildHaDeviceCatalog({ devices, entities, areas, states, services }) {
  const stateById = new Map(states.map(state => [state.entity_id, state]));
  const areaById = new Map(areas.map(area => [area.area_id, area.name]));
  const servicesList = Object.entries(services).flatMap(([domain, definitions]) =>
    Object.entries(definitions).map(([service, definition]) => ({ domain, service, definition })));
  const result = new Map(devices.filter(device => !device.disabled_by && device.entry_type !== 'service').map(device => [device.id, {
    id: device.id, name: device.name_by_user || device.name || device.model || 'Unnamed device',
    area: areaById.get(device.area_id) || '', manufacturer: device.manufacturer || '', model: device.model || '', controls: [],
  }]));
  for (const entity of entities) {
    const device = result.get(entity.device_id);
    const state = stateById.get(entity.entity_id);
    if (!device || entity.disabled_by || !state) continue;
    for (const { domain, service, definition } of servicesList) {
      const selector = definition.fields?.entity_id?.selector?.entity;
      const target = definition.target?.entity ?? selector?.filter ?? selector;
      // Untargeted services (including whole-system commands) do not belong
      // to a physical-device picker. A domain-wide empty target is valid.
      if (target == null && (!definition.target || domain !== entity.entity_id.split('.')[0])) continue;
      const filters = target == null ? [{}] : array(target);
      if (!filters.some(filter => (domain === entity.entity_id.split('.')[0] || filter.domain || filter.integration)
        && matchesFilter(filter, state, entity))) continue;
      const fields = [];
      let unsupported = false;
      for (const [key, def] of flattenFields(definition.fields)) {
        if (key === 'entity_id' || !matchesFilter(def.filter, state, entity)) continue;
        const field = makeField(key, def, state);
        if (field) fields.push(field);
        else if (def.required) unsupported = true;
      }
      // HA marks the HVAC mode as optional in its shared schema, although
      // setting a mode without choosing one would do nothing.
      if (domain === 'climate' && service === 'set_hvac_mode') {
        const field = fields.find(field => field.key === 'hvac_mode');
        if (!field) unsupported = true; else field.required = true;
      }
      if (unsupported) continue;
      const requiredAny = domain === 'climate' && service === 'set_temperature'
        ? fields.filter(field => ['temperature', 'target_temp_low', 'target_temp_high'].includes(field.key)).map(field => field.key) : [];
      device.controls.push({ id: `${entity.entity_id}|${domain}.${service}`, entity_id: entity.entity_id,
        entity_name: state.attributes?.friendly_name || title(entity.entity_id.split('.')[1]),
        domain, service, label: definition.name || (service === 'set_hvac_mode' ? 'Set operating mode' : title(service)), fields,
        ...(requiredAny.length ? { requiredAny } : {}) });
    }
  }
  for (const device of result.values()) device.controls.sort((a, b) =>
    a.entity_name.localeCompare(b.entity_name) || a.label.localeCompare(b.label));
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getHaDeviceCatalog() {
  if (!getHaConfig()) return { configured: false, devices: [] };
  if (!isHaWebSocketReady()) throw new Error('Home Assistant is reconnecting. Refresh the device list in a moment.');
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    if (!inflight) {
      const epoch = generation;
      const request = Promise.all(['config/device_registry/list', 'config/entity_registry/list',
        'config/area_registry/list', 'get_services'].map(type => sendHaWebSocketCommand(type)))
        .then(([devices, entities, areas, services]) => {
          if (epoch !== generation) throw new Error('Home Assistant configuration changed. Refresh the device list.');
          cached = { devices, entities, areas, services, at: Date.now() };
        }).finally(() => { if (inflight === request) inflight = null; });
      inflight = request;
    }
    await inflight;
  }
  return { configured: true, devices: buildHaDeviceCatalog({ ...cached, states: listCachedHaStates() }) };
}

export function validateHaDeviceAction(action, devices) {
  const device = devices.find(device => device.id === action.ha_device_id);
  const control = device?.controls.find(control => control.entity_id === action.data?.entity_id
    && control.domain === action.domain && control.service === action.service);
  if (!control) throw new RangeError('Choose an available control for the selected HA device.');
  const data = action.data || {};
  if (Object.keys(data).some(key => key !== 'entity_id' && !control.fields.some(field => field.key === key))) {
    throw new RangeError('This HA device action contains an unsupported setting.');
  }
  for (const field of control.fields) {
    const value = data[field.key];
    if (value === undefined || (value === '' && field.required)) {
      if (field.required) throw new RangeError(`Choose ${field.label} for ${device.name}.`);
      continue;
    }
    const invalid = field.kind === 'select' ? !field.options.some(option => option.value === value)
      : field.kind === 'number' ? typeof value !== 'number' || !Number.isFinite(value)
        || (field.min != null && value < field.min) || (field.max != null && value > field.max)
        || (field.step && Math.abs((value - (field.min || 0)) / field.step - Math.round((value - (field.min || 0)) / field.step)) > 1e-6)
      : field.kind === 'boolean' ? typeof value !== 'boolean'
      : field.kind === 'color' ? !Array.isArray(value) || value.length !== 3 || value.some(n => !Number.isInteger(n) || n < 0 || n > 255)
      : typeof value !== 'string' || (field.minLength != null && value.length < field.minLength)
        || (field.maxLength != null && value.length > field.maxLength);
    if (invalid) throw new RangeError(`${field.label} is not a supported value for ${device.name}.`);
  }
  if (control.requiredAny?.length && !control.requiredAny.some(key => typeof data[key] === 'number')) {
    throw new RangeError('Enter a target temperature.');
  }
  if ((data.target_temp_low != null) !== (data.target_temp_high != null)) throw new RangeError('Enter both ends of the target temperature range.');
  if (data.target_temp_low > data.target_temp_high) throw new RangeError('The lower target temperature must not exceed the upper target.');
}
