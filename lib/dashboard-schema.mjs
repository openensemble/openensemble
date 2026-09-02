import {
  isSensitiveDashboardKey,
  isSensitiveDashboardString,
} from './dashboard-widgets.mjs';

const ACCENTS = new Set(['lime', 'sky', 'violet', 'amber', 'rose', 'cyan']);
const CARD_VIEWS = new Set([
  'auto',
  'toggle',
  'slider',
  'dimmer',
  'thermostat',
  'contact',
  'dial',
  'fader',
  'segments',
  'camera',
  'compact',
  'status',
]);
const CARD_SIZES = new Set(['compact', 'standard', 'wide']);
const GROUP_CARD_VIEW = 'group';

const SAFE_LAYOUT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_DASHBOARD_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ENTITY_ID = /^[a-z][a-z0-9_]{0,63}\.[a-z0-9_]{1,190}$/;
const SAFE_REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_MDI_ICON = /^mdi:[a-z0-9][a-z0-9-]{0,79}$/;
const SAFE_WIDGET_ID = /^(?:builtin\.(?:calendar|email|nodes)|skill:[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;

export function isCameraEntityId(value) {
  return typeof value === 'string'
    && value.startsWith('camera.')
    && SAFE_ENTITY_ID.test(value);
}

export function isWeatherEntityId(value) {
  return typeof value === 'string'
    && value.startsWith('weather.')
    && SAFE_ENTITY_ID.test(value);
}

const MAX_LAYOUT_TITLE_LENGTH = 100;
const MAX_ITEM_TITLE_LENGTH = 80;
const MAX_SECTIONS = 24;
const MAX_CARDS_PER_SECTION = 120;
const MAX_CARDS_TOTAL = 512;
export const MAX_WIDGET_CARDS_TOTAL = 32;
const MAX_ENTITIES_PER_GROUP = 64;
const MAX_ENTITIES_TOTAL = 512;
const MAX_FOCUS_ENTRIES = 512;
const MAX_ATTRIBUTE_STRING_LENGTH = 2_048;
const MAX_ATTRIBUTE_ARRAY_LENGTH = 128;
const MAX_WEATHER_ENTITIES = 32;
const MAX_WEATHER_FORECAST_ENTRIES = 8;
const MAX_DASHBOARDS = 32;
const MAX_DASHBOARD_NAME_LENGTH = 100;
const MAX_DASHBOARD_OWNER_LENGTH = 100;
const MAX_DASHBOARD_DESCRIPTION_LENGTH = 500;
const MAX_DASHBOARD_CHROME_TEXT_LENGTH = 100;
const RFC3339_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_DASHBOARD_COLOR = /^#[0-9a-f]{6}$/;

const DASHBOARD_CHROME_KEYS = [
  'showSidebar',
  'showTopbar',
  'showBrand',
  'showFocusNav',
  'showSectionNav',
  'showSidebarStatus',
  'showHeroStatus',
  'heroStatusText',
  'greetingMode',
  'greetingText',
  'showTagline',
  'showClock',
  'showSummary',
  'showSectionHeaders',
];

const DASHBOARD_COLOR_KEYS = [
  'background',
  'surface',
  'card',
  'text',
  'mutedText',
  'accent',
  'greetingText',
  'taglineText',
];

const WEATHER_CONDITIONS = new Set([
  'clear-night',
  'cloudy',
  'exceptional',
  'fog',
  'hail',
  'lightning',
  'lightning-rainy',
  'partlycloudy',
  'pouring',
  'rainy',
  'snowy',
  'snowy-rainy',
  'sunny',
  'windy',
  'windy-variant',
]);

export function emptyDashboardFocus(defaultMode = 'overview') {
  return {
    defaultMode: ['overview', 'rooms', 'devices'].includes(defaultMode) ? defaultMode : 'overview',
    roomOrder: [],
    hiddenRooms: [],
    deviceOrder: [],
    hiddenDevices: [],
    cards: [],
  };
}

export function defaultDashboardChrome() {
  return {
    showSidebar: true,
    showTopbar: true,
    showBrand: true,
    showFocusNav: true,
    showSectionNav: true,
    showSidebarStatus: true,
    showHeroStatus: true,
    heroStatusText: '',
    greetingMode: 'auto',
    greetingText: '',
    showTagline: true,
    showClock: true,
    showSummary: true,
    showSectionHeaders: true,
  };
}

export function defaultDashboardColors() {
  return Object.fromEntries(DASHBOARD_COLOR_KEYS.map(key => [key, '']));
}

export function emptyDashboardLayout(title = '') {
  const safeTitle = typeof title === 'string'
    ? title.slice(0, MAX_LAYOUT_TITLE_LENGTH)
    : '';
  return {
    version: 6,
    title: safeTitle,
    sections: [],
    focus: emptyDashboardFocus(),
    chrome: defaultDashboardChrome(),
    colors: defaultDashboardColors(),
  };
}

function validateDashboardChrome(value) {
  if (!isRecord(value) || !hasExactKeys(value, DASHBOARD_CHROME_KEYS)) {
    return invalid(`Layout chrome must contain exactly ${DASHBOARD_CHROME_KEYS.join(', ')}.`);
  }
  for (const key of DASHBOARD_CHROME_KEYS.filter(key => key.startsWith('show'))) {
    if (typeof value[key] !== 'boolean') return invalid(`Layout chrome ${key} must be a boolean.`);
  }
  if (!['auto', 'custom', 'hidden'].includes(value.greetingMode)) {
    return invalid('Layout chrome greetingMode must be auto, custom, or hidden.');
  }
  for (const key of ['heroStatusText', 'greetingText']) {
    if (typeof value[key] !== 'string'
      || value[key].length > MAX_DASHBOARD_CHROME_TEXT_LENGTH) {
      return invalid(`Layout chrome ${key} must be a string of at most ${MAX_DASHBOARD_CHROME_TEXT_LENGTH} characters.`);
    }
  }
  return {
    ok: true,
    chrome: Object.fromEntries(DASHBOARD_CHROME_KEYS.map(key => [key, value[key]])),
  };
}

function validateDashboardColors(value) {
  if (!isRecord(value) || !hasExactKeys(value, DASHBOARD_COLOR_KEYS)) {
    return invalid(`Layout colors must contain exactly ${DASHBOARD_COLOR_KEYS.join(', ')}.`);
  }
  for (const key of DASHBOARD_COLOR_KEYS) {
    if (value[key] !== ''
      && (typeof value[key] !== 'string' || !SAFE_DASHBOARD_COLOR.test(value[key]))) {
      return invalid(`Layout colors ${key} must be empty or a lowercase six-digit hex color.`);
    }
  }
  return {
    ok: true,
    colors: Object.fromEntries(DASHBOARD_COLOR_KEYS.map(key => [key, value[key]])),
  };
}

// These fields are useful for rendering controls and status cards. Deliberately
// absent are credential-like fields, URLs/images, HA context, coordinates and
// device/config metadata. Values are separately limited to scalars and arrays
// of scalars, so an allowlisted key can never expose a nested object.
const PRESENTATION_ATTRIBUTES = new Set([
  'friendly_name',
  'icon',
  'device_class',
  'state_class',
  'entity_category',
  'unit_of_measurement',
  'temperature_unit',
  'supported_features',

  'brightness',
  'color_mode',
  'color_temp',
  'color_temp_kelvin',
  'min_color_temp_kelvin',
  'max_color_temp_kelvin',
  'rgb_color',
  'rgbw_color',
  'rgbww_color',
  'hs_color',
  'xy_color',
  'effect',
  'effect_list',
  'supported_color_modes',

  'percentage',
  'percentage_step',
  'preset_mode',
  'preset_modes',
  'oscillating',
  'direction',

  'temperature',
  'apparent_temperature',
  'cloud_coverage',
  'current_temperature',
  'dew_point',
  'target_temp_high',
  'target_temp_low',
  'min_temp',
  'max_temp',
  'target_temp_step',
  'hvac_action',
  'hvac_mode',
  'hvac_modes',
  'fan_mode',
  'fan_modes',
  'swing_mode',
  'swing_modes',
  'humidity',
  'current_humidity',
  'target_humidity',
  'min_humidity',
  'max_humidity',

  'ozone',
  'precipitation_unit',
  'pressure',
  'pressure_unit',
  'uv_index',
  'visibility',
  'visibility_unit',
  'wind_bearing',
  'wind_gust_speed',
  'wind_speed',
  'wind_speed_unit',

  'current_position',
  'current_tilt_position',

  'volume_level',
  'is_volume_muted',
  'media_title',
  'media_artist',
  'media_album_name',
  'media_duration',
  'media_position',
  'media_position_updated_at',
  'app_name',
  'source',
  'source_list',
  'sound_mode',
  'sound_mode_list',
  'repeat',
  'shuffle',

  'battery_level',
  'power',
  'current',
  'voltage',
  'energy',
  'duration',
  'remaining',
  'options',
  'min',
  'max',
  'step',
  'mode',
]);

const TURNABLE_DOMAINS = new Set([
  'light',
  'switch',
  'input_boolean',
  'fan',
  'climate',
  'media_player',
  'humidifier',
]);
const TOGGLE_DOMAINS = new Set(['light', 'switch', 'input_boolean', 'fan']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every(key => typeof key === 'string' && expected.includes(key));
}

function isTitle(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength;
}

function invalid(error) {
  return { ok: false, error };
}

function cloneWidgetConfig(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 160 || depth > 4) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return value.length <= 500 && !isSensitiveDashboardString(value) ? value : null;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) return null;
    const result = [];
    for (const item of value) {
      const cloned = cloneWidgetConfig(item, depth + 1, budget);
      if (cloned === null && item !== null) return null;
      result.push(cloned);
    }
    return result;
  }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > 32) return null;
  const result = {};
  for (const key of keys) {
    if (!key || key.length > 64
      || key === '__proto__' || key === 'prototype' || key === 'constructor'
      || isSensitiveDashboardKey(key)) return null;
    const cloned = cloneWidgetConfig(value[key], depth + 1, budget);
    if (cloned === null && value[key] !== null) return null;
    result[key] = cloned;
  }
  return result;
}

function validateWidgetConfig(value, cardLabel) {
  if (!isRecord(value)) return invalid(`${cardLabel} config must be an object.`);
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { return invalid(`${cardLabel} config must be JSON-compatible.`); }
  if (Buffer.byteLength(serialized, 'utf8') > 8 * 1024) {
    return invalid(`${cardLabel} config must be at most 8 KiB.`);
  }
  const config = cloneWidgetConfig(value);
  if (config === null) {
    return invalid(`${cardLabel} config must be bounded JSON without credential-like fields.`);
  }
  return { ok: true, config };
}

export function isDashboardSlug(value) {
  return typeof value === 'string' && SAFE_DASHBOARD_SLUG.test(value);
}

/**
 * Validate and clone one persisted dashboard metadata entry.
 *
 * @param {unknown} value
 * @returns {{ok: true, dashboard: object} | {ok: false, error: string}}
 */
export function validateDashboardMetadata(value) {
  const keys = ['slug', 'name', 'owner', 'description', 'theme'];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    return invalid(`Dashboard metadata must contain exactly ${keys.join(', ')}.`);
  }
  if (!isDashboardSlug(value.slug)) {
    return invalid('Dashboard slug must be 1 to 64 lowercase letters, numbers, or hyphens, without a leading or trailing hyphen.');
  }
  if (typeof value.name !== 'string'
    || !value.name.trim()
    || value.name.length > MAX_DASHBOARD_NAME_LENGTH) {
    return invalid(`Dashboard name must be a nonempty string of at most ${MAX_DASHBOARD_NAME_LENGTH} characters.`);
  }
  if (typeof value.owner !== 'string' || value.owner.length > MAX_DASHBOARD_OWNER_LENGTH) {
    return invalid(`Dashboard owner must be a string of at most ${MAX_DASHBOARD_OWNER_LENGTH} characters.`);
  }
  if (typeof value.description !== 'string'
    || value.description.length > MAX_DASHBOARD_DESCRIPTION_LENGTH) {
    return invalid(`Dashboard description must be a string of at most ${MAX_DASHBOARD_DESCRIPTION_LENGTH} characters.`);
  }
  if (!['midnight', 'sand'].includes(value.theme)) {
    return invalid('Dashboard theme must be midnight or sand.');
  }
  return {
    ok: true,
    dashboard: {
      slug: value.slug,
      name: value.name,
      owner: value.owner,
      description: value.description,
      theme: value.theme,
    },
  };
}

/**
 * Validate and clone the complete persisted dashboard metadata registry.
 *
 * @param {unknown} value
 * @returns {{ok: true, registry: object} | {ok: false, error: string}}
 */
export function validateDashboardRegistry(value) {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'dashboards'])) {
    return invalid('Dashboard registry must contain exactly version and dashboards.');
  }
  if (value.version !== 1) return invalid('Dashboard registry version must be 1.');
  if (!Array.isArray(value.dashboards)
    || value.dashboards.length < 1
    || value.dashboards.length > MAX_DASHBOARDS) {
    return invalid(`Dashboard registry must contain between 1 and ${MAX_DASHBOARDS} dashboards.`);
  }

  const dashboards = [];
  const slugs = new Set();
  for (let index = 0; index < value.dashboards.length; index += 1) {
    const checked = validateDashboardMetadata(value.dashboards[index]);
    if (!checked.ok) return invalid(`Dashboard ${index + 1}: ${checked.error}`);
    if (slugs.has(checked.dashboard.slug)) {
      return invalid(`Duplicate dashboard slug: ${checked.dashboard.slug}.`);
    }
    slugs.add(checked.dashboard.slug);
    dashboards.push(checked.dashboard);
  }
  if (!slugs.has('home')) return invalid('Dashboard registry must include the permanent home dashboard.');
  return { ok: true, registry: { version: 1, dashboards } };
}

/**
 * Validate and clone the complete persisted dashboard format.
 *
 * @param {unknown} value
 * @returns {{ok: true, layout: object} | {ok: false, error: string}}
 */
export function validateLayout(value) {
  if (!isRecord(value)) {
    return invalid('Layout must contain exactly version, title, and sections.');
  }
  if (value.version === 1) {
    if (!hasExactKeys(value, ['version', 'title', 'sections'])) {
      return invalid('Layout must contain exactly version, title, and sections.');
    }
  } else if (value.version === 2 || value.version === 3 || value.version === 4) {
    if (!hasExactKeys(value, ['version', 'title', 'sections', 'focus'])) {
      return invalid(`Layout version ${value.version} must contain exactly version, title, sections, and focus.`);
    }
  } else if (value.version === 5) {
    if (!hasExactKeys(value, ['version', 'title', 'sections', 'focus', 'chrome'])) {
      return invalid('Layout version 5 must contain exactly version, title, sections, focus, and chrome.');
    }
  } else if (value.version === 6) {
    if (!hasExactKeys(value, ['version', 'title', 'sections', 'focus', 'chrome', 'colors'])) {
      return invalid('Layout version 6 must contain exactly version, title, sections, focus, chrome, and colors.');
    }
  } else {
    return invalid('Layout version must be 1, 2, 3, 4, 5, or 6.');
  }
  if (!isTitle(value.title, MAX_LAYOUT_TITLE_LENGTH)) {
    return invalid(`Layout title must be a string of at most ${MAX_LAYOUT_TITLE_LENGTH} characters.`);
  }
  if (!Array.isArray(value.sections) || value.sections.length > MAX_SECTIONS) {
    return invalid(`Layout sections must be an array with at most ${MAX_SECTIONS} entries.`);
  }

  const sectionIds = new Set();
  const cardIds = new Set();
  const entityIds = new Set();
  const sections = [];
  let cardCount = 0;
  let widgetCardCount = 0;
  let entityCount = 0;

  for (let sectionIndex = 0; sectionIndex < value.sections.length; sectionIndex += 1) {
    const section = value.sections[sectionIndex];
    const sectionLabel = `Section ${sectionIndex + 1}`;
    if (!isRecord(section)
      || !hasExactKeys(section, ['id', 'title', 'accent', 'collapsed', 'cards'])) {
      return invalid(`${sectionLabel} must contain exactly id, title, accent, collapsed, and cards.`);
    }
    if (typeof section.id !== 'string' || !SAFE_LAYOUT_ID.test(section.id)) {
      return invalid(`${sectionLabel} has an invalid id.`);
    }
    if (sectionIds.has(section.id)) return invalid(`Duplicate section id: ${section.id}.`);
    sectionIds.add(section.id);
    if (!isTitle(section.title, MAX_ITEM_TITLE_LENGTH)) {
      return invalid(`${sectionLabel} title must be a string of at most ${MAX_ITEM_TITLE_LENGTH} characters.`);
    }
    if (!ACCENTS.has(section.accent)) return invalid(`${sectionLabel} has an invalid accent.`);
    if (typeof section.collapsed !== 'boolean') {
      return invalid(`${sectionLabel} collapsed must be a boolean.`);
    }
    if (!Array.isArray(section.cards) || section.cards.length > MAX_CARDS_PER_SECTION) {
      return invalid(`${sectionLabel} cards must be an array with at most ${MAX_CARDS_PER_SECTION} entries.`);
    }

    cardCount += section.cards.length;
    if (cardCount > MAX_CARDS_TOTAL) {
      return invalid(`Layout must contain at most ${MAX_CARDS_TOTAL} cards.`);
    }

    const cards = [];
    for (let cardIndex = 0; cardIndex < section.cards.length; cardIndex += 1) {
      const card = section.cards[cardIndex];
      const cardLabel = `${sectionLabel}, card ${cardIndex + 1}`;
      if (!isRecord(card)) return invalid(`${cardLabel} must be an object.`);
      if (typeof card.id !== 'string' || !SAFE_LAYOUT_ID.test(card.id)) {
        return invalid(`${cardLabel} has an invalid id.`);
      }
      if (cardIds.has(card.id)) return invalid(`Duplicate card id: ${card.id}.`);
      cardIds.add(card.id);
      if (!isTitle(card.title, MAX_ITEM_TITLE_LENGTH)) {
        return invalid(`${cardLabel} title must be a string of at most ${MAX_ITEM_TITLE_LENGTH} characters.`);
      }
      if (!CARD_SIZES.has(card.size)) return invalid(`${cardLabel} has an invalid size.`);
      if (!ACCENTS.has(card.accent)) return invalid(`${cardLabel} has an invalid accent.`);

      if (value.version >= 4 && card.kind === 'widget') {
        widgetCardCount += 1;
        if (widgetCardCount > MAX_WIDGET_CARDS_TOTAL) {
          return invalid(`Layout must contain at most ${MAX_WIDGET_CARDS_TOTAL} widget cards.`);
        }
        if (!hasExactKeys(card, ['id', 'kind', 'widgetId', 'title', 'size', 'accent', 'config'])) {
          return invalid(`${cardLabel} widget must contain exactly id, kind, widgetId, title, size, accent, and config.`);
        }
        if (typeof card.widgetId !== 'string' || !SAFE_WIDGET_ID.test(card.widgetId)) {
          return invalid(`${cardLabel} has an invalid widgetId.`);
        }
        const checkedConfig = validateWidgetConfig(card.config, cardLabel);
        if (!checkedConfig.ok) return checkedConfig;
        cards.push({
          id: card.id,
          kind: 'widget',
          widgetId: card.widgetId,
          title: card.title,
          size: card.size,
          accent: card.accent,
          config: checkedConfig.config,
        });
        continue;
      }

      if (value.version >= 4 && !['ha-entity', 'ha-group'].includes(card.kind)) {
        return invalid(`${cardLabel} kind must be ha-entity, ha-group, or widget.`);
      }

      const isGroup = value.version >= 4
        ? card.kind === 'ha-group'
        : (Object.prototype.hasOwnProperty.call(card, 'entityIds') || card.view === GROUP_CARD_VIEW);
      if (isGroup) {
        if (![3, 4, 5, 6].includes(value.version)) {
          return invalid(`${cardLabel} grouped cards require layout version 3, 4, 5, or 6.`);
        }
        const groupKeys = value.version >= 4
          ? ['id', 'kind', 'entityIds', 'title', 'view', 'size', 'accent']
          : ['id', 'entityIds', 'title', 'view', 'size', 'accent'];
        if (!hasExactKeys(card, groupKeys)) {
          return invalid(`${cardLabel} grouped card must contain exactly ${groupKeys.join(', ')}.`);
        }
        if (card.view !== GROUP_CARD_VIEW) {
          return invalid(`${cardLabel} grouped card view must be group.`);
        }
        if (!Array.isArray(card.entityIds)
          || card.entityIds.length < 2
          || card.entityIds.length > MAX_ENTITIES_PER_GROUP) {
          return invalid(`${cardLabel} entityIds must contain between 2 and ${MAX_ENTITIES_PER_GROUP} entries.`);
        }
        const groupedEntityIds = [];
        for (let entityIndex = 0; entityIndex < card.entityIds.length; entityIndex += 1) {
          const entityId = card.entityIds[entityIndex];
          if (typeof entityId !== 'string' || !SAFE_ENTITY_ID.test(entityId)) {
            return invalid(`${cardLabel}, item ${entityIndex + 1} has an invalid entityId.`);
          }
          if (entityIds.has(entityId)) return invalid(`Duplicate entityId: ${entityId}.`);
          entityIds.add(entityId);
          groupedEntityIds.push(entityId);
          entityCount += 1;
        }
        cards.push({
          id: card.id,
          ...(value.version >= 4 ? { kind: 'ha-group' } : {}),
          entityIds: groupedEntityIds,
          title: card.title,
          view: GROUP_CARD_VIEW,
          size: card.size,
          accent: card.accent,
        });
      } else {
        const entityKeys = value.version >= 4
          ? ['id', 'kind', 'entityId', 'title', 'view', 'size', 'accent']
          : ['id', 'entityId', 'title', 'view', 'size', 'accent'];
        if (!hasExactKeys(card, entityKeys)) {
          return invalid(`${cardLabel} must contain exactly ${entityKeys.join(', ')}.`);
        }
        if (typeof card.entityId !== 'string' || !SAFE_ENTITY_ID.test(card.entityId)) {
          return invalid(`${cardLabel} has an invalid entityId.`);
        }
        if (entityIds.has(card.entityId)) return invalid(`Duplicate entityId: ${card.entityId}.`);
        entityIds.add(card.entityId);
        entityCount += 1;
        if (!CARD_VIEWS.has(card.view)) return invalid(`${cardLabel} has an invalid view.`);
        cards.push({
          id: card.id,
          ...(value.version >= 4 ? { kind: 'ha-entity' } : {}),
          entityId: card.entityId,
          title: card.title,
          view: card.view,
          size: card.size,
          accent: card.accent,
        });
      }
      if (entityCount > MAX_ENTITIES_TOTAL) {
        return invalid(`Layout must contain at most ${MAX_ENTITIES_TOTAL} entities across its cards.`);
      }
    }

    sections.push({
      id: section.id,
      title: section.title,
      accent: section.accent,
      collapsed: section.collapsed,
      cards,
    });
  }

  const layout = { version: value.version, title: value.title, sections };
  if (value.version >= 2) {
    const checkedFocus = validateFocus(value.focus);
    if (!checkedFocus.ok) return checkedFocus;
    layout.focus = checkedFocus.focus;
  }
  if (value.version >= 5) {
    const checkedChrome = validateDashboardChrome(value.chrome);
    if (!checkedChrome.ok) return checkedChrome;
    layout.chrome = checkedChrome.chrome;
  }
  if (value.version === 6) {
    const checkedColors = validateDashboardColors(value.colors);
    if (!checkedColors.ok) return checkedColors;
    layout.colors = checkedColors.colors;
  }
  return { ok: true, layout };
}

function validateFocusIdList(value, label) {
  if (!Array.isArray(value) || value.length > MAX_FOCUS_ENTRIES) {
    return invalid(`${label} must be an array with at most ${MAX_FOCUS_ENTRIES} entries.`);
  }
  const seen = new Set();
  const result = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !SAFE_REGISTRY_ID.test(candidate)) {
      return invalid(`${label} contains an invalid id.`);
    }
    if (seen.has(candidate)) return invalid(`${label} contains a duplicate id: ${candidate}.`);
    seen.add(candidate);
    result.push(candidate);
  }
  return { ok: true, values: result };
}

function validateFocus(value) {
  const keys = [
    'defaultMode',
    'roomOrder',
    'hiddenRooms',
    'deviceOrder',
    'hiddenDevices',
    'cards',
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    return invalid(`Layout focus must contain exactly ${keys.join(', ')}.`);
  }
  if (!['overview', 'rooms', 'devices'].includes(value.defaultMode)) {
    return invalid('Layout focus defaultMode must be overview, rooms, or devices.');
  }

  const lists = {};
  for (const key of ['roomOrder', 'hiddenRooms', 'deviceOrder', 'hiddenDevices']) {
    const checked = validateFocusIdList(value[key], `Layout focus ${key}`);
    if (!checked.ok) return checked;
    lists[key] = checked.values;
  }

  if (!Array.isArray(value.cards) || value.cards.length > MAX_FOCUS_ENTRIES) {
    return invalid(`Layout focus cards must be an array with at most ${MAX_FOCUS_ENTRIES} entries.`);
  }
  const cardEntities = new Set();
  const cards = [];
  for (let index = 0; index < value.cards.length; index += 1) {
    const card = value.cards[index];
    const label = `Layout focus card ${index + 1}`;
    if (!isRecord(card)
      || !hasExactKeys(card, ['entityId', 'title', 'view', 'size', 'accent'])) {
      return invalid(`${label} must contain exactly entityId, title, view, size, and accent.`);
    }
    if (typeof card.entityId !== 'string' || !SAFE_ENTITY_ID.test(card.entityId)) {
      return invalid(`${label} has an invalid entityId.`);
    }
    if (cardEntities.has(card.entityId)) {
      return invalid(`Duplicate focus card entityId: ${card.entityId}.`);
    }
    cardEntities.add(card.entityId);
    if (!isTitle(card.title, MAX_ITEM_TITLE_LENGTH)) {
      return invalid(`${label} title must be a string of at most ${MAX_ITEM_TITLE_LENGTH} characters.`);
    }
    if (!CARD_VIEWS.has(card.view)) return invalid(`${label} has an invalid view.`);
    if (!CARD_SIZES.has(card.size)) return invalid(`${label} has an invalid size.`);
    if (!ACCENTS.has(card.accent)) return invalid(`${label} has an invalid accent.`);
    cards.push({
      entityId: card.entityId,
      title: card.title,
      view: card.view,
      size: card.size,
      accent: card.accent,
    });
  }

  return {
    ok: true,
    focus: {
      defaultMode: value.defaultMode,
      roomOrder: lists.roomOrder,
      hiddenRooms: lists.hiddenRooms,
      deviceOrder: lists.deviceOrder,
      hiddenDevices: lists.hiddenDevices,
      cards,
    },
  };
}

function safeScalar(value) {
  if (typeof value === 'string') {
    return value.length <= MAX_ATTRIBUTE_STRING_LENGTH ? value : undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function safeAttributeValue(value) {
  if (!Array.isArray(value)) return safeScalar(value);
  if (value.length > MAX_ATTRIBUTE_ARRAY_LENGTH) return undefined;
  const result = [];
  for (const item of value) {
    const safe = safeScalar(item);
    if (safe === undefined) return undefined;
    result.push(safe);
  }
  return result;
}

function boundedForecastNumber(value, minimum, maximum) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    ? value
    : undefined;
}

function firstBoundedForecastNumber(raw, keys, minimum, maximum) {
  for (const key of keys) {
    const value = boundedForecastNumber(raw[key], minimum, maximum);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeWeatherForecastEntry(raw) {
  if (!isRecord(raw)
    || typeof raw.datetime !== 'string'
    || !raw.datetime
    || raw.datetime.length > 100
    || !RFC3339_DATETIME_RE.test(raw.datetime)
    || !Number.isFinite(Date.parse(raw.datetime))) return null;

  const entry = { datetime: raw.datetime };
  if (typeof raw.condition === 'string' && WEATHER_CONDITIONS.has(raw.condition)) {
    entry.condition = raw.condition;
  }
  const numericFields = [
    ['temperature', ['temperature', 'high'], -150, 200],
    ['temperatureLow', ['templow', 'temperature_low', 'low'], -150, 200],
    ['apparentTemperature', ['apparent_temperature'], -150, 200],
    ['dewPoint', ['dew_point'], -150, 200],
    ['precipitation', ['precipitation'], 0, 100_000],
    ['precipitationProbability', ['precipitation_probability'], 0, 100],
    ['humidity', ['humidity'], 0, 100],
    ['pressure', ['pressure'], 0, 2_000],
    ['windSpeed', ['wind_speed'], 0, 1_000],
    ['windGustSpeed', ['wind_gust_speed'], 0, 1_000],
    ['uvIndex', ['uv_index'], 0, 100],
    ['cloudCoverage', ['cloud_coverage'], 0, 100],
  ];
  for (const [outputKey, inputKeys, minimum, maximum] of numericFields) {
    const value = firstBoundedForecastNumber(raw, inputKeys, minimum, maximum);
    if (value !== undefined) entry[outputKey] = value;
  }
  const windBearing = boundedForecastNumber(raw.wind_bearing, 0, 360);
  if (windBearing !== undefined) entry.windBearing = windBearing;
  else if (typeof raw.wind_bearing === 'string'
    && /^(?:N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)$/i.test(raw.wind_bearing)) {
    entry.windBearing = raw.wind_bearing.toUpperCase();
  }
  if (typeof raw.is_daytime === 'boolean') entry.isDaytime = raw.is_daytime;
  return entry;
}

/**
 * Reduce a Home Assistant `weather.get_forecasts` service response to the
 * small, bounded shape the tablet UI needs. Only explicitly requested weather
 * entity IDs are considered, so unexpected response keys can never leak.
 */
export function normalizeWeatherForecasts(raw, entityIds) {
  if (!isRecord(raw) || !Array.isArray(entityIds)) return [];
  const allowed = [...new Set(entityIds)]
    .filter(isWeatherEntityId)
    .slice(0, MAX_WEATHER_ENTITIES);
  return allowed.map((entityId) => {
    const source = isRecord(raw[entityId]) && Array.isArray(raw[entityId].forecast)
      ? raw[entityId].forecast
      : [];
    const forecast = [];
    for (const candidate of source) {
      const entry = normalizeWeatherForecastEntry(candidate);
      if (entry) forecast.push(entry);
      if (forecast.length >= MAX_WEATHER_FORECAST_ENTRIES) break;
    }
    return { entityId, forecast };
  });
}

function presentationAttributes(raw) {
  if (!isRecord(raw)) return {};
  const attributes = {};
  for (const key of PRESENTATION_ATTRIBUTES) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = safeAttributeValue(raw[key]);
    if (value !== undefined) attributes[key] = value;
  }
  return attributes;
}

function fallbackEntityName(entityId) {
  const objectId = entityId.slice(entityId.indexOf('.') + 1);
  return objectId
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function safeName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_LAYOUT_TITLE_LENGTH
    ? value
    : null;
}

/**
 * Convert either a Home Assistant state object or an already-normalized demo
 * record to the small public entity representation.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeEntity(raw) {
  if (!isRecord(raw)) return null;
  const entityId = typeof raw.entity_id === 'string'
    ? raw.entity_id
    : (typeof raw.entityId === 'string' ? raw.entityId : '');
  if (!SAFE_ENTITY_ID.test(entityId)) return null;

  const attributes = presentationAttributes(raw.attributes);
  const stateCandidate = raw.state;
  const state = ['string', 'number', 'boolean'].includes(typeof stateCandidate)
    ? String(stateCandidate)
    : 'unknown';
  if (state.length > 255) return null;

  const directName = safeName(raw.name);
  const attributeName = safeName(attributes.friendly_name);
  const changedCandidate = typeof raw.last_changed === 'string'
    ? raw.last_changed
    : (typeof raw.lastChanged === 'string' ? raw.lastChanged : null);
  const lastChanged = changedCandidate && changedCandidate.length <= 100
    ? changedCandidate
    : null;
  const explicitlyAvailable = typeof raw.available === 'boolean' ? raw.available : true;
  const unavailableState = ['unknown', 'unavailable'].includes(state.toLowerCase());

  return {
    entityId,
    domain: entityId.slice(0, entityId.indexOf('.')),
    name: directName || attributeName || fallbackEntityName(entityId),
    state,
    available: explicitlyAvailable && !unavailableState,
    lastChanged,
    attributes,
  };
}

/**
 * Normalize a state list, dropping malformed entries and duplicate entity IDs.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeEntities(raw) {
  if (!Array.isArray(raw)) return [];
  const entities = [];
  const seen = new Set();
  for (const candidate of raw) {
    const entity = normalizeEntity(candidate);
    if (!entity || seen.has(entity.entityId)) continue;
    seen.add(entity.entityId);
    entities.push(entity);
  }
  return entities;
}

function boundedCatalogString(value, maxLength = 100) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function registryId(value) {
  return typeof value === 'string' && SAFE_REGISTRY_ID.test(value) ? value : null;
}

/**
 * Convert Home Assistant's area, device and entity registries into the small
 * public catalog used for room/device filtering. Entity-level area assignments
 * take precedence over the device's area, matching Home Assistant's behavior.
 *
 * @param {unknown} raw
 * @returns {{areas: object[], devices: object[], entityAssignments: object[]}}
 */
export function normalizeCatalog(raw) {
  const rawAreas = isRecord(raw) && Array.isArray(raw.areas) ? raw.areas : [];
  const rawDevices = isRecord(raw) && Array.isArray(raw.devices) ? raw.devices : [];
  const rawEntities = isRecord(raw) && Array.isArray(raw.entities) ? raw.entities : [];

  const areas = [];
  const areaIds = new Set();
  for (const candidate of rawAreas) {
    if (!isRecord(candidate)) continue;
    const areaId = registryId(candidate.area_id ?? candidate.areaId);
    const name = boundedCatalogString(candidate.name);
    if (!areaId || !name || areaIds.has(areaId)) continue;
    areaIds.add(areaId);
    const iconCandidate = boundedCatalogString(candidate.icon, 84);
    areas.push({
      areaId,
      name,
      icon: iconCandidate && SAFE_MDI_ICON.test(iconCandidate) ? iconCandidate : null,
    });
  }
  areas.sort((a, b) => a.name.localeCompare(b.name) || a.areaId.localeCompare(b.areaId));

  const devices = [];
  const devicesById = new Map();
  for (const candidate of rawDevices) {
    if (!isRecord(candidate)) continue;
    const deviceId = registryId(candidate.id ?? candidate.device_id ?? candidate.deviceId);
    if (!deviceId || devicesById.has(deviceId)) continue;
    const name = boundedCatalogString(candidate.name_by_user)
      || boundedCatalogString(candidate.name)
      || boundedCatalogString(candidate.model)
      || 'Device';
    const directAreaId = registryId(candidate.area_id ?? candidate.areaId);
    const device = {
      deviceId,
      name,
      manufacturer: boundedCatalogString(candidate.manufacturer),
      model: boundedCatalogString(candidate.model),
      areaId: directAreaId && areaIds.has(directAreaId) ? directAreaId : null,
    };
    devicesById.set(deviceId, device);
    devices.push(device);
  }
  devices.sort((a, b) => a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId));

  const entityAssignments = [];
  const seenEntities = new Set();
  for (const candidate of rawEntities) {
    if (!isRecord(candidate)) continue;
    const entityId = typeof candidate.entity_id === 'string'
      ? candidate.entity_id
      : candidate.entityId;
    if (!SAFE_ENTITY_ID.test(entityId) || seenEntities.has(entityId)) continue;
    seenEntities.add(entityId);

    const candidateDeviceId = registryId(candidate.device_id ?? candidate.deviceId);
    const deviceId = candidateDeviceId && devicesById.has(candidateDeviceId)
      ? candidateDeviceId
      : null;
    const directAreaId = registryId(candidate.area_id ?? candidate.areaId);
    const areaId = directAreaId && areaIds.has(directAreaId)
      ? directAreaId
      : (deviceId ? devicesById.get(deviceId).areaId : null);
    entityAssignments.push({ entityId, deviceId, areaId });
  }
  entityAssignments.sort((a, b) => a.entityId.localeCompare(b.entityId));

  return { areas, devices, entityAssignments };
}

function mapped(entityId, action, domain, service, data = {}) {
  return { ok: true, entityId, action, domain, service, data };
}

function numericValue(body, minimum, maximum) {
  if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
    return { ok: false, error: 'This action requires value.' };
  }
  if (typeof body.value !== 'number' || !Number.isFinite(body.value)
    || body.value < minimum || body.value > maximum) {
    return { ok: false, error: `Value must be a finite number from ${minimum} to ${maximum}.` };
  }
  return { ok: true, value: body.value };
}

/**
 * Validate the public control command and map it to a fixed HA service call.
 * The target entity never enters data; the HA client adds it independently.
 *
 * @param {unknown} body
 * @returns {object}
 */
export function resolveControl(body) {
  if (!isRecord(body)) return invalid('Control body must be an object.');
  const keys = Reflect.ownKeys(body);
  if (keys.some(key => typeof key !== 'string'
      || !['entityId', 'action', 'value'].includes(key))
    || !Object.prototype.hasOwnProperty.call(body, 'entityId')
    || !Object.prototype.hasOwnProperty.call(body, 'action')) {
    return invalid('Control body may contain only entityId, action, and optional value.');
  }
  if (typeof body.entityId !== 'string' || !SAFE_ENTITY_ID.test(body.entityId)) {
    return invalid('Control entityId is invalid.');
  }
  if (typeof body.action !== 'string') return invalid('Control action is invalid.');

  const entityId = body.entityId;
  const action = body.action;
  const domain = entityId.slice(0, entityId.indexOf('.'));
  const hasValue = Object.prototype.hasOwnProperty.call(body, 'value');

  if (action === 'set_brightness') {
    if (domain !== 'light') return invalid('set_brightness is only valid for lights.');
    const checked = numericValue(body, 0, 100);
    return checked.ok
      ? mapped(entityId, action, 'light', 'turn_on', { brightness_pct: checked.value })
      : checked;
  }
  if (action === 'set_percentage') {
    if (domain !== 'fan') return invalid('set_percentage is only valid for fans.');
    const checked = numericValue(body, 0, 100);
    return checked.ok
      ? mapped(entityId, action, 'fan', 'set_percentage', { percentage: checked.value })
      : checked;
  }
  if (action === 'set_temperature') {
    if (domain !== 'climate') return invalid('set_temperature is only valid for climate entities.');
    const checked = numericValue(body, -50, 150);
    return checked.ok
      ? mapped(entityId, action, 'climate', 'set_temperature', { temperature: checked.value })
      : checked;
  }
  if (action === 'set_position') {
    if (domain !== 'cover') return invalid('set_position is only valid for covers.');
    const checked = numericValue(body, 0, 100);
    return checked.ok
      ? mapped(entityId, action, 'cover', 'set_cover_position', { position: checked.value })
      : checked;
  }
  if (action === 'set_volume') {
    if (domain !== 'media_player') return invalid('set_volume is only valid for media players.');
    const checked = numericValue(body, 0, 100);
    return checked.ok
      ? mapped(entityId, action, 'media_player', 'volume_set', { volume_level: checked.value / 100 })
      : checked;
  }
  if (action === 'set_humidity') {
    if (domain !== 'humidifier') return invalid('set_humidity is only valid for humidifiers.');
    const checked = numericValue(body, 0, 100);
    return checked.ok
      ? mapped(entityId, action, 'humidifier', 'set_humidity', { humidity: checked.value })
      : checked;
  }
  if (action === 'set_value') {
    if (!['number', 'input_number'].includes(domain)) {
      return invalid('set_value is only valid for number and input_number entities.');
    }
    // The entity's own min/max attributes remain authoritative upstream. This
    // outer bound prevents extreme or non-finite values reaching HA while still
    // covering practical Home Assistant number helpers and device controls.
    const checked = numericValue(body, -1_000_000, 1_000_000);
    return checked.ok
      ? mapped(entityId, action, domain, 'set_value', { value: checked.value })
      : checked;
  }

  if (hasValue) return invalid('This action does not accept value.');

  if (action === 'turn_on') {
    if (domain === 'scene') return mapped(entityId, action, 'scene', 'turn_on');
    if (domain === 'script') return mapped(entityId, action, 'script', 'turn_on');
    if (domain === 'automation') return mapped(entityId, action, 'automation', 'trigger');
    if (domain === 'vacuum') return mapped(entityId, action, 'vacuum', 'start');
    if (TURNABLE_DOMAINS.has(domain)) return mapped(entityId, action, 'homeassistant', 'turn_on');
    return invalid(`turn_on is not supported for ${domain}.`);
  }
  if (action === 'turn_off') {
    if (domain === 'vacuum') return mapped(entityId, action, 'vacuum', 'return_to_base');
    if (TURNABLE_DOMAINS.has(domain)) return mapped(entityId, action, 'homeassistant', 'turn_off');
    return invalid(`turn_off is not supported for ${domain}.`);
  }
  if (action === 'toggle') {
    if (domain === 'media_player') {
      return mapped(entityId, action, 'media_player', 'media_play_pause');
    }
    if (TOGGLE_DOMAINS.has(domain)) return mapped(entityId, action, 'homeassistant', 'toggle');
    return invalid(`toggle is not supported for ${domain}.`);
  }
  if (action === 'lock' && domain === 'lock') return mapped(entityId, action, 'lock', 'lock');
  if (action === 'unlock' && domain === 'lock') return mapped(entityId, action, 'lock', 'unlock');
  if (action === 'open' && domain === 'cover') return mapped(entityId, action, 'cover', 'open_cover');
  if (action === 'close' && domain === 'cover') return mapped(entityId, action, 'cover', 'close_cover');
  if (action === 'stop' && domain === 'cover') return mapped(entityId, action, 'cover', 'stop_cover');

  return invalid(`Action ${action} is not supported for ${domain}.`);
}
