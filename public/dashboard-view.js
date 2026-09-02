const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
// The editor is a view embedded by OE's authenticated Dashboard drawer. A
// copied top-level URL with ?oe_editor=1 must remain a display, not become a
// second management surface outside OE.
const OE_EDITOR_MODE = new URLSearchParams(location.search).get('oe_editor') === '1'
  && window.self !== window.top;
const OE_FULLSCREEN_KEY = 'oe_dashboard_fullscreen';
const OE_EDITOR_ACTIONS = new Set([
  'open-dashboard-settings', 'picker-source', 'picker-domain', 'picker-mode',
  'picker-entity', 'picker-widget', 'add-selected', 'add-widget',
  'add-group-item', 'move-group-item', 'remove-group-item',
  'card-view-choice', 'accent', 'save-card', 'save-group-card', 'save-widget-card',
  'save-focus-card', 'reset-focus-card', 'pin-focus', 'move-focus',
  'toggle-focus-hidden', 'save-section', 'remove-card', 'remove-section',
  'save-dashboard', 'reset-focus', 'reset-layout', 'move-card', 'move-section',
  'edit-card', 'edit-focus-card', 'edit-section', 'create-empty-section',
  'reset-dashboard-color', 'reset-dashboard-colors',
]);

document.body.classList.remove('oe-mode-pending');
document.body.classList.add(OE_EDITOR_MODE ? 'oe-editor-mode' : 'oe-display-mode');
const accents = ['lime', 'sky', 'violet', 'amber', 'rose', 'cyan'];
const views = ['auto', 'toggle', 'slider', 'dimmer', 'thermostat', 'dial', 'fader', 'segments', 'contact', 'camera', 'compact', 'status'];
const sizes = ['compact', 'standard', 'wide'];
const DASHBOARD_LAYOUT_VERSION = 6;
const MAX_SECTIONS = 24;
const MAX_CARDS_PER_SECTION = 120;
const MAX_CARDS_TOTAL = 512;
const MAX_WIDGET_CARDS = 32;
const MAX_ENTITIES_PER_GROUP = 64;
const MAX_ENTITIES_TOTAL = 512;
const MAX_FOCUS_ENTRIES = 512;
const MAX_DASHBOARD_NAME_LENGTH = 100;
const MAX_DASHBOARD_OWNER_LENGTH = 100;
const MAX_DASHBOARD_DESCRIPTION_LENGTH = 500;
const MAX_DASHBOARD_GREETING_LENGTH = 100;
const CAMERA_VIEWER_REFRESH_MS = 1500;
const CAMERA_VIEWER_RETRY_MS = 3000;
const CAMERA_WEBRTC_TIMEOUT_MS = 60000;
const CAMERA_WEBRTC_DISCONNECT_RESTART_MS = 15000;
const CAMERA_WEBRTC_ICE_RESTART_TIMEOUT_MS = 20000;
const CAMERA_WEBRTC_MAX_ICE_RESTARTS = 2;
const WIDGET_CATALOG_PATH = '/api/dashboard-widgets/catalog';
const WIDGET_POLL_TICK_MS = 30_000;
const WIDGET_DEFAULT_REFRESH_SECONDS = 120;
const WIDGET_MIN_REFRESH_SECONDS = 30;
const WIDGET_MAX_REFRESH_SECONDS = 3600;
const WIDGET_REFRESH_CONCURRENCY = 6;
const DASHBOARD_SWIPE_MIN_DISTANCE = 72;
const DASHBOARD_SWIPE_MAX_DURATION_MS = 900;
const DASHBOARD_SWIPE_DOMINANCE = 1.4;
const DASHBOARD_SWIPE_EDGE_GUTTER = 24;
const SAFE_WIDGET_ID = /^(?:builtin\.(?:calendar|email)|skill:[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;
const SECRET_WIDGET_CONFIG_KEY = /(?:secret|token|password|passwd|credential|cookie|authorization|api[_-]?key|private[_-]?key)/i;
const UNASSIGNED_ID = 'unassigned';
const focusModes = ['overview', 'rooms', 'devices'];
const actionable = new Set(['light', 'switch', 'input_boolean', 'fan', 'cover', 'lock', 'climate', 'media_player', 'scene', 'script', 'automation', 'vacuum', 'humidifier']);
const greetingModes = new Set(['auto', 'custom', 'hidden']);
const DEFAULT_DASHBOARD_CHROME = Object.freeze({
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
});
const DASHBOARD_COLOR_KEYS = Object.freeze([
  'background',
  'surface',
  'card',
  'text',
  'mutedText',
  'accent',
  'greetingText',
  'taglineText',
]);
const DEFAULT_DASHBOARD_COLORS = Object.freeze(Object.fromEntries(
  DASHBOARD_COLOR_KEYS.map(key => [key, '']),
));
const DASHBOARD_THEME_COLORS = Object.freeze({
  midnight: Object.freeze({
    background: '#0d100f',
    surface: '#141817',
    card: '#151917',
    text: '#f4f6ef',
    mutedText: '#929b96',
    accent: '#c8f36a',
    greetingText: '#f4f6ef',
    taglineText: '#929b96',
  }),
  sand: Object.freeze({
    background: '#f0efe8',
    surface: '#faf9f3',
    card: '#f9f8f1',
    text: '#17201b',
    mutedText: '#6d7670',
    accent: '#6c8e22',
    greetingText: '#17201b',
    taglineText: '#6d7670',
  }),
});
const DASHBOARD_COLOR_LABELS = Object.freeze({
  background: ['Dashboard background', 'The canvas behind every section.'],
  surface: ['Navigation & panels', 'Sidebar, toolbar, and raised surfaces.'],
  card: ['Cards & widgets', 'The background used by dashboard cards.'],
  text: ['Primary text', 'Headings, values, and card names.'],
  mutedText: ['Secondary text', 'Labels, states, and supporting details.'],
  accent: ['Accent', 'Branding, highlights, and primary actions.'],
  greetingText: ['Greeting text', 'The large welcome message only.'],
  taglineText: ['Tagline text', 'The line immediately below the greeting.'],
});
const DASHBOARD_COLOR_STYLE_PROPERTIES = Object.freeze([
  '--bg', '--surface', '--surface-2', '--surface-3', '--glass', '--line',
  '--line-strong', '--text', '--muted', '--subtle', '--primary',
  '--primary-ink', '--greeting-text', '--tagline-text',
]);

const app = {
  entities: new Map(),
  entitiesLoaded: false,
  entitiesUnavailable: false,
  catalog: { areas: [], devices: [], entityAssignments: [] },
  catalogLoaded: false,
  assignments: new Map(),
  dashboards: [],
  defaultDashboardSlug: 'home',
  dashboardSlug: 'home',
  dashboard: null,
  dashboardRoute: null,
  dashboardMutation: false,
  dashboardMutationPromise: null,
  layout: null,
  layoutEtag: null,
  status: { mode: 'demo', configured: false, connected: true, canView: false, canControl: false },
  editing: false,
  activeSection: 'all',
  focusMode: 'overview',
  focusId: null,
  focusQuery: '',
  focusShowAll: false,
  busy: new Set(),
  histories: new Map(),
  panel: null,
  pickerQuery: '',
  pickerSource: 'devices',
  pickerDomain: 'all',
  pickerScope: 'all',
  pickerMode: 'separate',
  pickerGroupTitle: '',
  pickerSectionId: null,
  pickerSelection: new Set(),
  pickerWidgetId: null,
  saveTimer: null,
  saveInFlight: false,
  savePromise: null,
  saveError: null,
  saveQueued: false,
  saveConflict: false,
  layoutDirty: false,
  provisionalLayout: false,
  navigationPending: false,
  pollTimer: null,
  widgetPollTimer: null,
  dragCardId: null,
  weather: new Map(),
  weatherFetchedAt: 0,
  widgetCatalog: [],
  widgetCatalogLoaded: false,
  widgetCatalogError: null,
  widgetCatalogPromise: null,
  widgetData: new Map(),
  cameraViewerTimer: null,
  cameraViewerEntity: null,
  cameraViewerMode: null,
  cameraViewerFallbackReason: null,
  cameraViewerWebRtc: null,
  expandedCard: null,
  expandedSourceCardId: null,
  theme: 'midnight',
  fullscreen: !OE_EDITOR_MODE && (
    new URLSearchParams(location.search).get('fullscreen') === '1'
    || localStorage.getItem(OE_FULLSCREEN_KEY) === '1'
  ),
};

function ico(name, className = '') {
  return `<svg${className ? ` class="${className}"` : ''} aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function uid(prefix) {
  return `${prefix}-${crypto.randomUUID?.().slice(0, 8) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanDashboardChrome(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const chrome = {};
  for (const [key, fallback] of Object.entries(DEFAULT_DASHBOARD_CHROME)) {
    if (key === 'heroStatusText' || key === 'greetingMode' || key === 'greetingText') continue;
    chrome[key] = typeof source[key] === 'boolean' ? source[key] : fallback;
  }
  chrome.heroStatusText = typeof source.heroStatusText === 'string'
    ? source.heroStatusText.slice(0, MAX_DASHBOARD_GREETING_LENGTH)
    : DEFAULT_DASHBOARD_CHROME.heroStatusText;
  chrome.greetingMode = greetingModes.has(source.greetingMode)
    ? source.greetingMode
    : DEFAULT_DASHBOARD_CHROME.greetingMode;
  chrome.greetingText = typeof source.greetingText === 'string'
    ? source.greetingText.slice(0, MAX_DASHBOARD_GREETING_LENGTH)
    : DEFAULT_DASHBOARD_CHROME.greetingText;
  return {
    showSidebar: chrome.showSidebar,
    showTopbar: chrome.showTopbar,
    showBrand: chrome.showBrand,
    showFocusNav: chrome.showFocusNav,
    showSectionNav: chrome.showSectionNav,
    showSidebarStatus: chrome.showSidebarStatus,
    showHeroStatus: chrome.showHeroStatus,
    heroStatusText: chrome.heroStatusText,
    greetingMode: chrome.greetingMode,
    greetingText: chrome.greetingText,
    showTagline: chrome.showTagline,
    showClock: chrome.showClock,
    showSummary: chrome.showSummary,
    showSectionHeaders: chrome.showSectionHeaders,
  };
}

function dashboardChrome() {
  return app.layout?.chrome || DEFAULT_DASHBOARD_CHROME;
}

function normalizeDashboardColor(value) {
  const color = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^#[0-9a-f]{6}$/.test(color) ? color : '';
}

function cleanDashboardColors(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return Object.fromEntries(DASHBOARD_COLOR_KEYS.map(key => [
    key,
    normalizeDashboardColor(source[key]),
  ]));
}

function dashboardThemeColors(theme = app.theme) {
  return DASHBOARD_THEME_COLORS[dashboardTheme(theme)];
}

function effectiveDashboardColors(raw = app.layout?.colors, theme = app.theme) {
  const colors = cleanDashboardColors(raw);
  const defaults = dashboardThemeColors(theme);
  const effective = Object.fromEntries(DASHBOARD_COLOR_KEYS.map(key => [
    key,
    colors[key] || defaults[key],
  ]));
  if (!colors.greetingText && colors.text) effective.greetingText = colors.text;
  if (!colors.taglineText && colors.mutedText) effective.taglineText = colors.mutedText;
  return effective;
}

function colorLuminance(value) {
  const color = normalizeDashboardColor(value);
  if (!color) return 0;
  const channels = color.slice(1).match(/.{2}/g).map(part => parseInt(part, 16) / 255)
    .map(channel => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const light = Math.max(colorLuminance(foreground), colorLuminance(background));
  const dark = Math.min(colorLuminance(foreground), colorLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function contrastInk(background) {
  return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background)
    ? '#000000'
    : '#ffffff';
}

function dashboardColorRoots() {
  return [
    $('#dashboardThemeRoot'),
    $('#floatingMenuButton'),
    $('#fullscreenExit'),
    $('#deviceDialog'),
    $('#toastRegion'),
  ].filter(Boolean);
}

function applyDashboardColors(raw = app.layout?.colors, theme = app.theme) {
  const colors = cleanDashboardColors(raw);
  const effective = effectiveDashboardColors(colors, theme);
  const protectEditor = typeof OE_EDITOR_MODE !== 'undefined' && OE_EDITOR_MODE;
  const applied = protectEditor ? DEFAULT_DASHBOARD_COLORS : colors;
  const appliedEffective = protectEditor
    ? effectiveDashboardColors(DEFAULT_DASHBOARD_COLORS, theme)
    : effective;
  const hasSurfaceLayerOverride = Boolean(applied.surface || applied.text);
  const hasLineOverride = Boolean(applied.text);
  const hasSubtleOverride = Boolean(applied.background || applied.mutedText);
  const direct = {
    background: '--bg',
    surface: '--surface',
    card: '--glass',
    text: '--text',
    mutedText: '--muted',
    accent: '--primary',
    greetingText: '--greeting-text',
    taglineText: '--tagline-text',
  };
  for (const root of dashboardColorRoots()) {
    for (const property of DASHBOARD_COLOR_STYLE_PROPERTIES) root.style.removeProperty(property);
    root.style.removeProperty('color-scheme');
    for (const key of DASHBOARD_COLOR_KEYS) {
      if (applied[key]) root.style.setProperty(direct[key], applied[key]);
    }
    if (applied.greetingText || applied.text) {
      root.style.setProperty('--greeting-text', appliedEffective.greetingText);
    }
    if (applied.taglineText || applied.mutedText) {
      root.style.setProperty('--tagline-text', appliedEffective.taglineText);
    }
    if (hasSurfaceLayerOverride) {
      root.style.setProperty('--surface-2', 'color-mix(in srgb, var(--surface) 91%, var(--text))');
      root.style.setProperty('--surface-3', 'color-mix(in srgb, var(--surface) 82%, var(--text))');
    }
    if (hasLineOverride) {
      root.style.setProperty('--line', 'color-mix(in srgb, var(--text) 8.5%, transparent)');
      root.style.setProperty('--line-strong', 'color-mix(in srgb, var(--text) 15%, transparent)');
    }
    if (hasSubtleOverride) {
      root.style.setProperty('--subtle', 'color-mix(in srgb, var(--muted) 70%, var(--bg))');
    }
    root.style.setProperty('--primary-ink', contrastInk(appliedEffective.accent));
    root.style.setProperty('color-scheme', colorLuminance(appliedEffective.background) > 0.42 ? 'light' : 'dark');
  }
  const meta = $('#dashboardThemeColor');
  if (meta) meta.setAttribute('content', appliedEffective.background);
  return effective;
}

function cleanWidgetValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 500);
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 32).flatMap(item => {
      const cleaned = cleanWidgetValue(item, depth + 1);
      return cleaned === undefined ? [] : [cleaned];
    });
  }
  if (!isPlainObject(value)) return undefined;
  const cleaned = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (!key || key.length > 64 || ['__proto__', 'prototype', 'constructor'].includes(key) || SECRET_WIDGET_CONFIG_KEY.test(key)) continue;
    const next = cleanWidgetValue(item, depth + 1);
    if (next !== undefined) cleaned[key] = next;
  }
  return cleaned;
}

function cleanWidgetConfig(value) {
  const cleaned = cleanWidgetValue(value);
  return isPlainObject(cleaned) ? cleaned : {};
}

function safeWidgetId(value) {
  const id = String(value || '').trim();
  return SAFE_WIDGET_ID.test(id) ? id : '';
}

const widgetIcons = new Set([
  'activity', 'calendar', 'clock', 'cloud', 'cloud-sun', 'gauge', 'grid', 'house',
  'light', 'mail', 'package', 'shield', 'sparkles', 'thermometer', 'wifi',
]);

function normalizeWidgetDescriptor(raw) {
  if (!isPlainObject(raw)) return null;
  const widgetId = safeWidgetId(raw.widgetId || raw.id);
  if (!widgetId) return null;
  const icon = String(raw.icon || '').toLowerCase();
  return {
    widgetId,
    title: String(raw.title || raw.name || widgetId).slice(0, 80),
    description: String(raw.description || '').slice(0, 240),
    icon: widgetIcons.has(icon) ? icon : widgetId.toLowerCase().includes('calendar') ? 'calendar' : widgetId.toLowerCase().includes('email') || widgetId.toLowerCase().includes('mail') ? 'mail' : 'package',
    size: sizes.includes(raw.size || raw.defaultSize) ? (raw.size || raw.defaultSize) : 'standard',
    accent: accents.includes(raw.accent || raw.defaultAccent) ? (raw.accent || raw.defaultAccent) : 'violet',
    refreshSeconds: Math.max(WIDGET_MIN_REFRESH_SECONDS, Math.min(WIDGET_MAX_REFRESH_SECONDS, Number(raw.refreshSeconds) || WIDGET_DEFAULT_REFRESH_SECONDS)),
    available: raw.available !== false,
    reason: String(raw.reason || '').slice(0, 240),
    config: cleanWidgetConfig(raw.config || raw.defaults),
    options: cleanWidgetValue(raw.options),
    type: String(raw.type || raw.kind || '').toLowerCase().slice(0, 40),
  };
}

function widgetDescriptor(widgetId) {
  return app.widgetCatalog.find(item => item.widgetId === widgetId) || null;
}

function widgetType(card) {
  if (card?.widgetId === 'builtin.calendar') return 'calendar';
  if (card?.widgetId === 'builtin.email') return 'email';
  return 'skill';
}

function normalizeEntity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entityId = raw.entityId || raw.entity_id;
  if (!entityId || !entityId.includes('.')) return null;
  const domain = raw.domain || entityId.split('.')[0];
  const attrs = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : {};
  const name = raw.name || attrs.friendly_name || entityId.split('.').slice(1).join(' ').replaceAll('_', ' ');
  const entity = {
    ...raw, entityId, domain, name, attributes: attrs,
    state: String(raw.state ?? 'unknown'),
    available: raw.available !== false && !['unknown', 'unavailable'].includes(String(raw.state ?? '').toLowerCase()),
    lastChanged: raw.lastChanged || raw.last_changed || new Date().toISOString(),
  };
  const numeric = Number(entity.state);
  if (Number.isFinite(numeric)) {
    const history = app.histories.get(entityId) || [];
    if (!history.length || history.at(-1) !== numeric) history.push(numeric);
    while (history.length > 18) history.shift();
    app.histories.set(entityId, history);
  }
  return entity;
}

function setEntities(list) {
  const next = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const entity = normalizeEntity(raw);
    if (entity) next.set(entity.entityId, entity);
  }
  app.entities = next;
}

function setCatalog(raw) {
  const areas = Array.isArray(raw?.areas) ? raw.areas.filter(area => area?.areaId && area?.name) : [];
  const devices = Array.isArray(raw?.devices) ? raw.devices.filter(device => device?.deviceId && device?.name) : [];
  const entityAssignments = Array.isArray(raw?.entityAssignments) ? raw.entityAssignments.filter(item => item?.entityId) : [];
  app.catalog = { areas, devices, entityAssignments };
  app.assignments = new Map(entityAssignments.map(item => [item.entityId, item]));
}

function setWeatherData(raw) {
  if (!Array.isArray(raw?.forecasts)) return;
  app.weather = new Map(raw.forecasts
    .filter(item => item?.entityId && Array.isArray(item.forecast))
    .map(item => [item.entityId, item]));
  app.weatherFetchedAt = Date.now();
}

function emptyFocus(defaultMode = 'overview') {
  return {
    defaultMode: focusModes.includes(defaultMode) ? defaultMode : 'overview',
    roomOrder: [],
    hiddenRooms: [],
    deviceOrder: [],
    hiddenDevices: [],
    cards: [],
  };
}

function safeDashboardSlug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function dashboardRouteFromLocation(pathname = location.pathname) {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const match = normalized.match(/^\/dashboards\/([^/]+)$/);
  if (!match) return { slug: null, valid: false };
  let decoded;
  try { decoded = decodeURIComponent(match[1]); } catch { return { slug: null, valid: false }; }
  const slug = safeDashboardSlug(decoded);
  return { slug: slug && slug === decoded ? slug : decoded, valid: Boolean(slug && slug === decoded) };
}

function dashboardPath(slug) {
  return `/dashboards/${encodeURIComponent(slug)}`;
}

function dashboardLayoutApiPath(slug) {
  return `/api/dashboards/${encodeURIComponent(slug)}/layout`;
}

function dashboardMetadataApiPath(slug) {
  return `/api/dashboards/${encodeURIComponent(slug)}`;
}

function dashboardAddress(slug) {
  const dashboard = app.dashboards.find(item => item.slug === slug);
  return new URL(dashboard?.url || dashboardPath(slug), location.origin).toString();
}

function dashboardNavigationPath(dashboardOrSlug, { settings = false, preserveHash = true } = {}) {
  const dashboard = typeof dashboardOrSlug === 'string'
    ? app.dashboards.find(item => item.slug === dashboardOrSlug)
    : dashboardOrSlug;
  const slug = typeof dashboardOrSlug === 'string' ? dashboardOrSlug : dashboard?.slug;
  const url = new URL(dashboardPath(slug), location.origin);
  if (new URLSearchParams(location.search).get('fullscreen') === '1') {
    url.searchParams.set('fullscreen', '1');
  }
  if (settings) url.searchParams.set('settings', '1');
  if (preserveHash) url.hash = location.hash;
  return `${url.pathname}${url.search}${url.hash}`;
}

function dashboardCycleEntries() {
  return app.dashboards.filter(dashboard => {
    const slug = safeDashboardSlug(dashboard?.slug);
    return Boolean(slug && slug === dashboard.slug);
  });
}

function dashboardCycleTarget(direction) {
  const dashboards = dashboardCycleEntries();
  if (dashboards.length < 2) return null;
  const currentIndex = dashboards.findIndex(dashboard => dashboard.slug === app.dashboardSlug);
  const offset = direction === 'previous' ? -1 : direction === 'next' ? 1 : 0;
  if (currentIndex < 0 || !offset) return null;
  return dashboards[(currentIndex + offset + dashboards.length) % dashboards.length];
}

function cycleDashboard(direction) {
  if (OE_EDITOR_MODE || app.navigationPending) return false;
  const target = dashboardCycleTarget(direction);
  if (!target) return false;
  app.navigationPending = true;
  try {
    location.assign(dashboardNavigationPath(target, { preserveHash: false }));
  } catch {
    app.navigationPending = false;
    return false;
  }
  return true;
}

function dashboardSwipeDirection(deltaX, deltaY, durationMs) {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || !Number.isFinite(durationMs)) return null;
  if (durationMs < 0 || durationMs > DASHBOARD_SWIPE_MAX_DURATION_MS) return null;
  const horizontalDistance = Math.abs(deltaX);
  if (horizontalDistance < DASHBOARD_SWIPE_MIN_DISTANCE) return null;
  if (horizontalDistance < Math.abs(deltaY) * DASHBOARD_SWIPE_DOMINANCE) return null;
  return deltaX > 0 ? 'previous' : 'next';
}

const DASHBOARD_SWIPE_INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'label', 'iframe', 'video', 'audio', 'canvas',
  '[contenteditable="true"]', '[draggable="true"]', '[data-action]', '[data-dashboard-swipe-ignore]',
  '[role="button"]', '[role="slider"]', '.card-controls',
].join(',');

function dashboardSwipeTargetIsInteractive(target) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  if (!element?.closest) return true;
  if (element.closest(DASHBOARD_SWIPE_INTERACTIVE_SELECTOR)) return true;
  if (typeof getComputedStyle !== 'function') return false;
  for (let current = element; current && !current.classList?.contains('main'); current = current.parentElement) {
    const style = getComputedStyle(current);
    if (/(?:auto|scroll)/.test(style.overflowX)
        && Number(current.scrollWidth) > Number(current.clientWidth)) return true;
  }
  return false;
}

function dashboardSwipeContextAvailable() {
  if (OE_EDITOR_MODE || app.navigationPending || !app.dashboard || !app.layout) return false;
  if (dashboardCycleEntries().length < 2 || app.panel || $('#panel')?.classList.contains('open')) return false;
  if (!$('#cameraViewer')?.hidden || $('#deviceDialog')?.open || $('#sidebar')?.classList.contains('open')) return false;
  return true;
}

function dashboardSwipeCanStart(target, clientX) {
  if (!dashboardSwipeContextAvailable() || dashboardSwipeTargetIsInteractive(target)) return false;
  const viewportWidth = Number(globalThis.innerWidth) || document.documentElement?.clientWidth || 0;
  if (viewportWidth > 0
      && (clientX < DASHBOARD_SWIPE_EDGE_GUTTER
        || clientX > viewportWidth - DASHBOARD_SWIPE_EDGE_GUTTER)) return false;
  return true;
}

function dashboardTouch(touches, identifier) {
  return Array.from(touches || []).find(touch => touch.identifier === identifier) || null;
}

function dashboardEventTime(event) {
  const eventTime = Number(event?.timeStamp);
  return Number.isFinite(eventTime) ? eventTime : performance.now();
}

let dashboardSwipeGesture = null;
let dashboardSwipeSuppressClickUntil = 0;

function startDashboardSwipe(event) {
  dashboardSwipeGesture = null;
  if (event.touches?.length !== 1) return;
  const touch = event.touches[0];
  if (!dashboardSwipeCanStart(event.target, touch.clientX)) return;
  dashboardSwipeGesture = {
    identifier: touch.identifier,
    startX: touch.clientX,
    startY: touch.clientY,
    lastX: touch.clientX,
    lastY: touch.clientY,
    startedAt: dashboardEventTime(event),
    axis: null,
  };
}

function moveDashboardSwipe(event) {
  const gesture = dashboardSwipeGesture;
  if (!gesture) return;
  if (event.touches?.length !== 1) {
    dashboardSwipeGesture = null;
    return;
  }
  const touch = dashboardTouch(event.touches, gesture.identifier);
  if (!touch) {
    dashboardSwipeGesture = null;
    return;
  }
  gesture.lastX = touch.clientX;
  gesture.lastY = touch.clientY;
  const deltaX = gesture.lastX - gesture.startX;
  const deltaY = gesture.lastY - gesture.startY;
  if (!gesture.axis && Math.hypot(deltaX, deltaY) >= 12) {
    if (Math.abs(deltaX) >= Math.abs(deltaY) * DASHBOARD_SWIPE_DOMINANCE) gesture.axis = 'horizontal';
    else if (Math.abs(deltaY) >= Math.abs(deltaX) * DASHBOARD_SWIPE_DOMINANCE) {
      dashboardSwipeGesture = null;
      return;
    }
  }
  if (gesture.axis === 'horizontal') event.preventDefault();
}

function finishDashboardSwipe(event) {
  const gesture = dashboardSwipeGesture;
  dashboardSwipeGesture = null;
  if (!gesture || event.touches?.length) return;
  const touch = dashboardTouch(event.changedTouches, gesture.identifier);
  if (!touch || !dashboardSwipeContextAvailable()) return;
  const endedAt = dashboardEventTime(event);
  const direction = dashboardSwipeDirection(
    touch.clientX - gesture.startX,
    touch.clientY - gesture.startY,
    endedAt - gesture.startedAt,
  );
  if (!direction) return;
  event.preventDefault();
  dashboardSwipeSuppressClickUntil = Date.now() + 500;
  cycleDashboard(direction);
}

function cancelDashboardSwipe() {
  dashboardSwipeGesture = null;
}

function dashboardTheme(value) {
  return value === 'sand' ? 'sand' : 'midnight';
}

function dashboardThemeLabel(value) {
  return dashboardTheme(value) === 'sand' ? 'Warm daylight' : 'Midnight';
}

function normalizeDashboardSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const slug = String(raw.slug || '');
  if (!slug || safeDashboardSlug(slug) !== slug) return null;
  return {
    slug,
    name: String(raw.name || slug).slice(0, MAX_DASHBOARD_NAME_LENGTH),
    owner: String(raw.owner ?? '').slice(0, MAX_DASHBOARD_OWNER_LENGTH),
    description: String(raw.description || '').slice(0, MAX_DASHBOARD_DESCRIPTION_LENGTH),
    theme: dashboardTheme(raw.theme),
    url: typeof raw.url === 'string' && raw.url.startsWith('/') ? raw.url : dashboardPath(slug),
    isDefault: raw.isDefault === true,
    sectionCount: Math.max(0, Number(raw.sectionCount) || 0),
    cardCount: Math.max(0, Number(raw.cardCount) || 0),
  };
}

function setDashboardCatalog(raw) {
  app.dashboards = (Array.isArray(raw?.dashboards) ? raw.dashboards : [])
    .map(normalizeDashboardSummary)
    .filter(Boolean);
  const requestedDefault = safeDashboardSlug(raw?.defaultSlug);
  app.defaultDashboardSlug = app.dashboards.some(item => item.slug === requestedDefault)
    ? requestedDefault
    : app.dashboards.find(item => item.isDefault)?.slug || 'home';
}

function cloneLayout(layout) {
  return typeof structuredClone === 'function'
    ? structuredClone(layout)
    : JSON.parse(JSON.stringify(layout));
}

function blankDashboardLayout() {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    title: 'Everything is in its place.',
    sections: [{ id: uid('space'), title: 'My dashboard', accent: 'lime', collapsed: false, cards: [] }],
    focus: emptyFocus(),
    chrome: cleanDashboardChrome(),
    colors: cleanDashboardColors(),
  };
}

function focusFromHash() {
  const [mode, rawId] = location.hash.replace(/^#\/?/, '').split('/');
  if (!focusModes.includes(mode)) return null;
  let id = null;
  try { id = rawId ? decodeURIComponent(rawId) : null; } catch {}
  return { mode, id };
}

function syncFocusHash() {
  const suffix = app.focusId ? `/${encodeURIComponent(app.focusId)}` : '';
  history.replaceState(null, '', `${location.pathname}${location.search}#${app.focusMode}${suffix}`);
}

function defaultAccent(domain) {
  return ({ light: 'amber', switch: 'lime', input_boolean: 'lime', fan: 'cyan', cover: 'sky', lock: 'violet', climate: 'rose', media_player: 'violet', scene: 'violet', script: 'violet', automation: 'violet', sensor: 'cyan', binary_sensor: 'rose', vacuum: 'sky', humidifier: 'cyan', number: 'sky', input_number: 'sky', weather: 'sky', camera: 'violet' })[domain] || 'lime';
}

function defaultSize(domain) {
  if (['climate', 'cover', 'media_player', 'camera'].includes(domain)) return 'wide';
  if (['sensor', 'binary_sensor', 'scene', 'script', 'automation'].includes(domain)) return 'compact';
  return 'standard';
}

function rangeSpecFor(entity) {
  if (!entity) return null;
  const attrs = entity.attributes || {};
  const domain = entity.domain;
  let spec = null;
  if (domain === 'light' && supportsLightBrightness(entity)) {
    spec = { value: entity.state === 'on' ? Number(attrs.brightness ?? 255) / 255 * 100 : 0, min: 0, max: 100, step: 1, unit: '%', label: 'Brightness', command: 'set_brightness', icon: 'sun' };
  } else if (domain === 'fan' && (attrs.percentage != null || attrs.percentage_step != null)) {
    spec = { value: entity.state === 'on' ? Number(attrs.percentage ?? 100) : 0, min: 0, max: 100, step: Number(attrs.percentage_step ?? 5), unit: '%', label: 'Fan speed', command: 'set_percentage', icon: 'wind' };
  } else if (domain === 'climate' && attrs.temperature != null) {
    spec = { value: Number(attrs.temperature), current: Number(attrs.current_temperature), min: Number(attrs.min_temp ?? 50), max: Number(attrs.max_temp ?? 90), step: Number(attrs.target_temp_step ?? .5), unit: attrs.temperature_unit || '°', label: 'Temperature', command: 'set_temperature', icon: 'thermometer' };
  } else if (domain === 'cover' && attrs.current_position != null) {
    spec = { value: Number(attrs.current_position), min: 0, max: 100, step: 5, unit: '%', label: 'Open', command: 'set_position', icon: 'blinds' };
  } else if (domain === 'media_player' && attrs.volume_level != null) {
    spec = { value: Number(attrs.volume_level) * 100, min: 0, max: 100, step: 1, unit: '%', label: 'Volume', command: 'set_volume', icon: 'volume' };
  } else if (domain === 'humidifier' && (attrs.humidity != null || attrs.target_humidity != null)) {
    spec = { value: Number(attrs.humidity ?? attrs.target_humidity), current: Number(attrs.current_humidity), min: Number(attrs.min_humidity ?? 0), max: Number(attrs.max_humidity ?? 100), step: 1, unit: '%', label: 'Target humidity', command: 'set_humidity', icon: 'droplet' };
  } else if (['number', 'input_number'].includes(domain) && Number.isFinite(Number(entity.state))) {
    spec = { value: Number(entity.state), min: Number(attrs.min ?? 0), max: Number(attrs.max ?? 100), step: Number(attrs.step ?? 1), unit: attrs.unit_of_measurement || '', label: 'Value', command: 'set_value', icon: 'gauge' };
  }
  if (!spec) return null;
  const commandBounds = {
    set_brightness: [0, 100],
    set_percentage: [0, 100],
    set_temperature: [-50, 150],
    set_position: [0, 100],
    set_volume: [0, 100],
    set_humidity: [0, 100],
    set_value: [-1_000_000, 1_000_000],
  }[spec.command];
  if (commandBounds) {
    spec.min = Math.max(commandBounds[0], spec.min);
    spec.max = Math.min(commandBounds[1], spec.max);
  }
  if (!Number.isFinite(spec.min) || !Number.isFinite(spec.max) || spec.max <= spec.min) return null;
  if (!Number.isFinite(spec.value)) spec.value = spec.min;
  spec.value = Math.max(spec.min, Math.min(spec.max, spec.value));
  if (!Number.isFinite(spec.step) || spec.step <= 0 || spec.step > spec.max - spec.min) spec.step = 1;
  spec.precision = spec.step < 1 ? Math.min(2, String(spec.step).split('.')[1]?.length || 1) : 0;
  spec.percent = (spec.value - spec.min) / (spec.max - spec.min) * 100;
  return spec;
}

function sliderViewOptions(entity, label = 'Classic slider') {
  if (!rangeSpecFor(entity)) return [];
  return [
    ['slider', label],
    ['dial', 'Radial slider'],
    ['fader', 'Vertical fader'],
    ['segments', 'Stepped slider'],
  ];
}

function defaultView(entity) {
  const domain = typeof entity === 'string' ? entity : entity.domain;
  const deviceClass = typeof entity === 'string' ? '' : entity.attributes?.device_class;
  if (domain === 'binary_sensor' && ['door', 'window', 'opening', 'garage_door'].includes(deviceClass)) return 'contact';
  if (domain === 'light') return typeof entity !== 'string' && supportsLightBrightness(entity) ? 'dimmer' : 'toggle';
  if (domain === 'climate') return 'thermostat';
  if (['number', 'input_number'].includes(domain)) return 'slider';
  if (domain === 'humidifier' && typeof entity !== 'string' && rangeSpecFor(entity)) return 'slider';
  if (['fan', 'cover', 'media_player'].includes(domain)) return 'slider';
  if (domain === 'camera') return 'camera';
  if (['sensor', 'binary_sensor', 'weather', 'person'].includes(domain)) return 'status';
  if (['switch', 'input_boolean', 'lock'].includes(domain)) return 'toggle';
  return 'auto';
}

function cardFor(entity) {
  return { id: uid('card'), kind: 'ha-entity', entityId: entity.entityId, title: '', view: defaultView(entity), size: defaultSize(entity.domain), accent: defaultAccent(entity.domain) };
}

function isWidgetCard(card) {
  return card?.kind === 'widget' && typeof card.widgetId === 'string';
}

function isGroupCard(card) {
  return card?.kind === 'ha-group' && card?.view === 'group' && Array.isArray(card.entityIds);
}

function cardEntityIds(card) {
  if (isWidgetCard(card)) return [];
  if (isGroupCard(card)) return card.entityIds;
  return typeof card?.entityId === 'string' ? [card.entityId] : [];
}

function titleCase(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function groupTitleFor(entityIds) {
  const entities = entityIds.map(entityId => app.entities.get(entityId)).filter(Boolean);
  const domains = new Set(entities.map(entity => entity.domain));
  if (domains.size !== 1) return 'Device group';
  const domain = [...domains][0];
  return ({
    light: 'Lights',
    sensor: 'Sensors',
    binary_sensor: 'Sensors',
    switch: 'Switches',
    input_boolean: 'Helpers',
    fan: 'Fans',
    cover: 'Covers',
    lock: 'Locks',
    climate: 'Climate',
    media_player: 'Media players',
    camera: 'Cameras',
    scene: 'Scenes',
    script: 'Scripts',
    automation: 'Automations',
    vacuum: 'Vacuums',
    humidifier: 'Humidifiers',
    number: 'Controls',
    input_number: 'Controls',
  })[domain] || `${titleCase(domain)} group`;
}

function groupCardFor(entityIds, title = '') {
  const first = app.entities.get(entityIds[0]);
  return {
    id: uid('card'),
    kind: 'ha-group',
    entityIds: [...entityIds],
    title: title.trim().slice(0, 80) || groupTitleFor(entityIds),
    view: 'group',
    size: 'wide',
    accent: defaultAccent(first?.domain || 'light'),
  };
}

function widgetCardFor(descriptor) {
  const type = widgetType({ widgetId: descriptor.widgetId });
  const fallback = type === 'calendar'
    ? { days: 7, maxItems: 10, calendarIds: [], showLocation: false }
    : type === 'email'
      ? { accountId: '', maxItems: 8, showSnippet: false }
      : {};
  const config = cleanWidgetConfig({ ...fallback, ...descriptor.config });
  if (type === 'email' && !config.accountId && Array.isArray(descriptor?.options?.accounts)) {
    config.accountId = String(descriptor.options.accounts.find(account => account?.id)?.id || '').slice(0, 160);
  }
  return {
    id: uid('card'),
    kind: 'widget',
    widgetId: descriptor.widgetId,
    title: '',
    size: sizes.includes(descriptor.size) ? descriptor.size : type === 'skill' ? 'standard' : 'wide',
    accent: accents.includes(descriptor.accent) ? descriptor.accent : type === 'calendar' ? 'sky' : type === 'email' ? 'violet' : 'lime',
    config,
  };
}

function viewOptionsFor(entity) {
  const common = [['auto', 'Automatic'], ['compact', 'Compact'], ['status', 'Status only']];
  if (!entity) return common;
  if (entity.domain === 'light') return rangeSpecFor(entity) ? [['auto', 'Automatic'], ['dimmer', 'Dimmer + slider'], ...sliderViewOptions(entity, 'Brightness slider'), ['toggle', 'Large toggle'], ['compact', 'Compact'], ['status', 'Status only']] : [['auto', 'Automatic'], ['toggle', 'Large toggle'], ['compact', 'Compact'], ['status', 'Status only']];
  if (entity.domain === 'climate') return [['auto', 'Automatic'], ['thermostat', 'Temperature slider'], ['slider', 'Thermostat dial'], ...sliderViewOptions(entity).filter(([view]) => view !== 'slider'), ['toggle', 'Power toggle'], ['compact', 'Compact'], ['status', 'Status only']];
  if (entity.domain === 'binary_sensor' && ['door', 'window', 'opening', 'garage_door'].includes(entity.attributes.device_class)) return [['auto', 'Automatic'], ['contact', 'Door contact'], ['status', 'Status only'], ['compact', 'Compact']];
  if (['fan', 'cover', 'media_player'].includes(entity.domain)) return [['auto', 'Automatic'], ...sliderViewOptions(entity), ['toggle', 'Large toggle'], ['compact', 'Compact'], ['status', 'Status only']];
  if (['number', 'input_number'].includes(entity.domain)) return [['auto', 'Automatic'], ...sliderViewOptions(entity), ['compact', 'Compact'], ['status', 'Status only']];
  if (entity.domain === 'humidifier') return [['auto', 'Automatic'], ...sliderViewOptions(entity), ['toggle', 'Large toggle'], ['compact', 'Compact'], ['status', 'Status only']];
  if (entity.domain === 'camera') return [['auto', 'Automatic'], ['camera', 'Camera preview'], ['compact', 'Compact'], ['status', 'Status only']];
  if (['switch', 'input_boolean', 'lock', 'vacuum'].includes(entity.domain)) return [['auto', 'Automatic'], ['toggle', 'Large toggle'], ['compact', 'Compact'], ['status', 'Status only']];
  return common;
}

function buildDefaultLayout() {
  const candidates = [...app.entities.values()]
    .filter(entity => entity.attributes?.entity_category !== 'diagnostic');
  const available = candidates.filter(entity => entity.available);
  const entities = (available.length ? available : candidates)
    .sort((a, b) => a.name.localeCompare(b.name));
  const used = new Set();
  const take = (domains, limit) => {
    const cards = [];
    while (cards.length < limit) {
      let addedThisRound = false;
      for (const domain of domains) {
        const entity = entities.find(item => item.domain === domain && !used.has(item.entityId));
        if (!entity) continue;
        used.add(entity.entityId);
        cards.push(cardFor(entity));
        addedThisRound = true;
        if (cards.length >= limit) break;
      }
      if (!addedThisRound) break;
    }
    return cards;
  };
  const sections = [
    { id: uid('space'), title: 'Everyday', accent: 'lime', collapsed: false, cards: take(['light', 'switch', 'input_boolean', 'fan', 'climate', 'cover', 'media_player', 'vacuum', 'humidifier', 'number', 'input_number'], 12) },
    { id: uid('space'), title: 'Security & access', accent: 'violet', collapsed: false, cards: take(['lock', 'binary_sensor'], 7) },
    { id: uid('space'), title: 'At a glance', accent: 'cyan', collapsed: false, cards: take(['sensor', 'weather', 'person'], 7) },
    { id: uid('space'), title: 'Scenes', accent: 'amber', collapsed: false, cards: take(['scene', 'script', 'automation'], 7) },
  ].filter(section => section.cards.length);
  if (!sections.length) sections.push({ id: uid('space'), title: 'My devices', accent: 'lime', collapsed: false, cards: [] });
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    title: 'Everything is in its place.',
    sections,
    focus: emptyFocus(),
    chrome: cleanDashboardChrome(),
    colors: cleanDashboardColors(),
  };
}

function cleanLayout(layout) {
  if (!layout || !Array.isArray(layout.sections)) return buildDefaultLayout();
  const seenEntities = new Set();
  const seenCards = new Set();
  const seenSections = new Set();
  let totalCards = 0;
  let totalEntities = 0;
  let totalWidgets = 0;
  const sections = layout.sections.slice(0, MAX_SECTIONS).map(raw => {
    let id = String(raw.id || uid('space')).slice(0, 80);
    if (seenSections.has(id)) id = uid('space');
    seenSections.add(id);
    const cards = (Array.isArray(raw.cards) ? raw.cards : []).slice(0, MAX_CARDS_PER_SECTION).flatMap(card => {
      if (totalCards >= MAX_CARDS_TOTAL) return [];
      const widgetCandidate = card?.kind === 'widget';
      if (widgetCandidate) {
        if (totalWidgets >= MAX_WIDGET_CARDS) return [];
        const widgetId = safeWidgetId(card?.widgetId);
        if (!widgetId) return [];
        let cardId = String(card.id || uid('card')).slice(0, 80);
        if (seenCards.has(cardId)) cardId = uid('card');
        seenCards.add(cardId);
        totalCards++;
        totalWidgets++;
        return [{
          id: cardId,
          kind: 'widget',
          widgetId,
          title: String(card.title || '').slice(0, 80),
          size: sizes.includes(card.size) ? card.size : 'standard',
          accent: accents.includes(card.accent) ? card.accent : 'violet',
          config: cleanWidgetConfig(card.config),
        }];
      }
      const groupCandidate = card?.kind === 'ha-group' || Array.isArray(card?.entityIds) || card?.view === 'group';
      if (groupCandidate) {
        const entityIds = [];
        const localEntities = new Set();
        for (const rawEntityId of (Array.isArray(card?.entityIds) ? card.entityIds : []).slice(0, MAX_ENTITIES_PER_GROUP)) {
          const entityId = String(rawEntityId || '');
          if (!entityId.includes('.')
            || seenEntities.has(entityId)
            || localEntities.has(entityId)
            || totalEntities + entityIds.length >= MAX_ENTITIES_TOTAL) continue;
          localEntities.add(entityId);
          entityIds.push(entityId);
        }
        if (entityIds.length < 2) return [];
        let cardId = String(card.id || uid('card')).slice(0, 80);
        if (seenCards.has(cardId)) cardId = uid('card');
        seenCards.add(cardId);
        entityIds.forEach(entityId => seenEntities.add(entityId));
        totalEntities += entityIds.length;
        totalCards++;
        return [{
          id: cardId,
          kind: 'ha-group',
          entityIds,
          title: String(card.title || '').slice(0, 80),
          view: 'group',
          size: sizes.includes(card.size) ? card.size : 'wide',
          accent: accents.includes(card.accent) ? card.accent : defaultAccent(entityIds[0].split('.')[0]),
        }];
      }
      if (totalEntities >= MAX_ENTITIES_TOTAL) return [];
      const entityId = String(card?.entityId || card?.entity_id || '');
      if (!entityId.includes('.') || seenEntities.has(entityId)) return [];
      let cardId = String(card.id || uid('card')).slice(0, 80);
      if (seenCards.has(cardId)) cardId = uid('card');
      seenCards.add(cardId);
      seenEntities.add(entityId);
      totalEntities++;
      totalCards++;
      return [{ id: cardId, kind: 'ha-entity', entityId, title: String(card.title || '').slice(0, 80), view: views.includes(card.view) ? card.view : 'auto', size: sizes.includes(card.size) ? card.size : 'standard', accent: accents.includes(card.accent) ? card.accent : defaultAccent(entityId.split('.')[0]) }];
    });
    return { id, title: String(raw.title || 'Room').slice(0, 80), accent: accents.includes(raw.accent) ? raw.accent : 'lime', collapsed: !!raw.collapsed, cards };
  });
  const rawFocus = Number(layout.version) >= 2 && layout.focus && typeof layout.focus === 'object'
    ? layout.focus
    : emptyFocus();
  const safeRegistryId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  const cleanIds = value => [...new Set((Array.isArray(value) ? value : []).filter(safeRegistryId))].slice(0, MAX_FOCUS_ENTRIES);
  const focusEntities = new Set();
  const focusCards = (Array.isArray(rawFocus.cards) ? rawFocus.cards : []).slice(0, MAX_FOCUS_ENTRIES).flatMap(raw => {
    const entityId = String(raw?.entityId || '');
    if (!entityId.includes('.') || focusEntities.has(entityId)) return [];
    focusEntities.add(entityId);
    return [{
      entityId,
      title: String(raw.title || '').slice(0, 80),
      view: views.includes(raw.view) ? raw.view : 'auto',
      size: sizes.includes(raw.size) ? raw.size : defaultSize(entityId.split('.')[0]),
      accent: accents.includes(raw.accent) ? raw.accent : defaultAccent(entityId.split('.')[0]),
    }];
  });
  const focus = {
    defaultMode: focusModes.includes(rawFocus.defaultMode) ? rawFocus.defaultMode : 'overview',
    roomOrder: cleanIds(rawFocus.roomOrder),
    hiddenRooms: cleanIds(rawFocus.hiddenRooms),
    deviceOrder: cleanIds(rawFocus.deviceOrder),
    hiddenDevices: cleanIds(rawFocus.hiddenDevices),
    cards: focusCards,
  };
  const chrome = cleanDashboardChrome(Number(layout.version) >= 5 ? layout.chrome : null);
  const colors = cleanDashboardColors(Number(layout.version) >= 6 ? layout.colors : null);
  if (Number(layout.version) < 5) {
    chrome.showSummary = sections.some(section => section.cards.some(card => !isWidgetCard(card)));
  }
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    title: String(layout.title ?? 'Everything is in its place.').slice(0, 100),
    sections,
    focus,
    chrome,
    colors,
  };
}

async function api(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  const etag = response.headers.get('etag');
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.etag = etag;
    error.data = data;
    if (response.status === 401) redirectToOeLogin();
    throw error;
  }
  if (etag && data && typeof data === 'object') data._etag = etag;
  return data;
}

function setWidgetCatalog(raw) {
  const seen = new Set();
  app.widgetCatalog = (Array.isArray(raw?.widgets) ? raw.widgets : []).flatMap(item => {
    const descriptor = normalizeWidgetDescriptor(item);
    if (!descriptor || seen.has(descriptor.widgetId)) return [];
    seen.add(descriptor.widgetId);
    return [descriptor];
  });
  app.widgetCatalogLoaded = true;
  app.widgetCatalogError = null;
}

async function loadWidgetCatalog({ force = false } = {}) {
  if (app.widgetCatalogLoaded && !force) return app.widgetCatalog;
  if (app.widgetCatalogPromise) return app.widgetCatalogPromise;
  app.widgetCatalogPromise = (async () => {
    try {
      const data = await api(WIDGET_CATALOG_PATH, { cache: 'no-store' });
      setWidgetCatalog(data);
    } catch (error) {
      app.widgetCatalogLoaded = true;
      app.widgetCatalogError = error.message || 'Widgets are unavailable.';
    } finally {
      app.widgetCatalogPromise = null;
    }
    if (app.layout) renderSections();
    if (app.panel?.type === 'picker' && app.pickerSource === 'widgets') renderPickerPanel();
    return app.widgetCatalog;
  })();
  return app.widgetCatalogPromise;
}

function widgetRefreshSeconds(card) {
  const descriptor = widgetDescriptor(card.widgetId);
  return Math.max(
    WIDGET_MIN_REFRESH_SECONDS,
    Math.min(WIDGET_MAX_REFRESH_SECONDS, Number(descriptor?.refreshSeconds) || WIDGET_DEFAULT_REFRESH_SECONDS),
  );
}

function widgetRuntimePath(cardId, dashboardSlug = app.dashboardSlug) {
  return `/api/dashboard-runtime/widgets/${encodeURIComponent(cardId)}?dashboardSlug=${encodeURIComponent(dashboardSlug)}`;
}

function widgetState(card) {
  return app.widgetData.get(card.id) || {
    status: 'idle',
    data: null,
    error: null,
    stale: false,
    fetchedAt: null,
    nextAt: 0,
    inFlight: null,
    widgetId: card.widgetId,
  };
}

function setWidgetState(cardId, patch) {
  const current = app.widgetData.get(cardId) || {};
  const next = { ...current, ...patch };
  app.widgetData.set(cardId, next);
  return next;
}

function dashboardHasCard(cardId, widgetId = null) {
  return Boolean(app.layout?.sections?.some(section => section.cards.some(card =>
    card.id === cardId && (!widgetId || (isWidgetCard(card) && card.widgetId === widgetId)))));
}

async function refreshWidgetCard(card, { force = false } = {}) {
  if (!isWidgetCard(card) || (!force && document.hidden)) return null;
  const current = widgetState(card);
  if (current.inFlight) return current.inFlight;
  if (!force && current.nextAt > Date.now()) return current;
  const descriptor = widgetDescriptor(card.widgetId);
  if (descriptor?.available === false) {
    const next = setWidgetState(card.id, {
      status: 'unavailable',
      widgetId: card.widgetId,
      error: descriptor.reason || 'This widget is not available for this profile.',
      nextAt: Date.now() + widgetRefreshSeconds(card) * 1000,
    });
    if (app.layout) renderSections();
    return next;
  }

  const dashboardSlug = app.dashboardSlug;
  const hadData = current.status === 'ready' || current.data !== null;
  setWidgetState(card.id, {
    ...current,
    status: hadData ? 'ready' : 'loading',
    error: null,
    widgetId: card.widgetId,
  });
  if (!hadData && app.layout) renderSections();

  const request = (async () => {
    try {
      const payload = await api(widgetRuntimePath(card.id, dashboardSlug), { cache: 'no-store' });
      if (payload?.error && !Object.prototype.hasOwnProperty.call(payload, 'data')) {
        throw new Error(String(payload.error));
      }
      if (dashboardSlug !== app.dashboardSlug || !dashboardHasCard(card.id, card.widgetId)) return null;
      const fetchedAt = typeof payload?.fetchedAt === 'string' || Number.isFinite(Number(payload?.fetchedAt))
        ? payload.fetchedAt
        : new Date().toISOString();
      const next = setWidgetState(card.id, {
        status: 'ready',
        data: Object.prototype.hasOwnProperty.call(payload || {}, 'data') ? payload.data : null,
        error: payload?.error ? String(payload.error).slice(0, 500) : null,
        stale: payload?.stale === true,
        fetchedAt,
        nextAt: Date.now() + widgetRefreshSeconds(card) * 1000,
        widgetId: card.widgetId,
        inFlight: null,
      });
      renderSections();
      return next;
    } catch (error) {
      if (dashboardSlug !== app.dashboardSlug || !dashboardHasCard(card.id, card.widgetId)) return null;
      const previous = widgetState(card);
      const next = setWidgetState(card.id, {
        status: previous.data !== null ? 'ready' : [403, 404, 424].includes(error.status) ? 'unavailable' : 'error',
        error: String(error.message || 'Widget could not be refreshed.').slice(0, 500),
        stale: previous.data !== null,
        nextAt: Date.now() + Math.min(60, widgetRefreshSeconds(card)) * 1000,
        widgetId: card.widgetId,
        inFlight: null,
      });
      renderSections();
      return next;
    }
  })();
  setWidgetState(card.id, { inFlight: request });
  return request;
}

async function refreshWidgets({ force = false } = {}) {
  if (!app.layout || (!force && document.hidden)) return [];
  const cards = app.layout.sections.flatMap(section => section.cards).filter(isWidgetCard);
  const ids = new Set(cards.map(card => card.id));
  for (const cardId of app.widgetData.keys()) {
    if (!ids.has(cardId)) app.widgetData.delete(cardId);
  }
  const pending = [...cards];
  const results = [];
  const worker = async () => {
    while (pending.length) {
      const card = pending.shift();
      results.push(await refreshWidgetCard(card, { force }));
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(WIDGET_REFRESH_CONCURRENCY, pending.length) },
    () => worker(),
  ));
  return results;
}

function startWidgetPolling() {
  clearInterval(app.widgetPollTimer);
  app.widgetPollTimer = setInterval(() => {
    if (!document.hidden) void refreshWidgets();
  }, WIDGET_POLL_TICK_MS);
}

async function refreshWidgetAfterSave(cardId) {
  const saved = await saveLayout();
  if (!saved) return;
  const found = findCardById(cardId);
  if (found && isWidgetCard(found.card)) await refreshWidgetCard(found.card, { force: true });
}

let oeAuthRedirecting = false;

function redirectToOeLogin() {
  if (oeAuthRedirecting) return;
  oeAuthRedirecting = true;
  const next = `${location.pathname}${location.search}${location.hash}`;
  const editorSlug = app.dashboardRoute?.valid && app.dashboardRoute.slug
    ? app.dashboardRoute.slug
    : app.dashboardSlug;
  const loginUrl = OE_EDITOR_MODE
    ? `/?dashboard-editor=${encodeURIComponent(editorSlug)}`
    : `/?next=${encodeURIComponent(next)}`;
  try {
    if (window.top && window.top !== window) window.top.location.assign(loginUrl);
    else location.assign(loginUrl);
  } catch {
    location.assign(loginUrl);
  }
}

async function loadApp() {
  clearInterval(app.pollTimer);
  clearInterval(app.widgetPollTimer);
  $('#sections').innerHTML = `<div class="loading-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
  try {
    app.dashboardRoute = dashboardRouteFromLocation();
    const dashboardData = await api('/api/dashboards');
    setDashboardCatalog(dashboardData);
    const requestedSlug = app.dashboardRoute.slug || 'home';
    const selectedDashboard = app.dashboards.find(item => item.slug === requestedSlug);
    if (!app.dashboardRoute.valid || !selectedDashboard) {
      renderDashboardNotFound(requestedSlug);
      return;
    }
    app.dashboardSlug = selectedDashboard.slug;
    app.dashboard = selectedDashboard;
    app.theme = selectedDashboard.theme;
    app.layout = null;
    applyTheme();
    renderDashboardIdentity();
    app.status = {
      mode: 'home-assistant', configured: false, connected: false,
      canView: false, canControl: false,
    };
    app.entitiesLoaded = false;
    app.entitiesUnavailable = false;
    app.catalogLoaded = false;
    app.widgetCatalogLoaded = false;
    app.widgetCatalogError = null;
    app.widgetData.clear();
    setEntities([]);
    setCatalog(null);

    const layoutRequest = api(dashboardLayoutApiPath(app.dashboardSlug));
    const widgetCatalogRequest = loadWidgetCatalog();
    const statusRequest = api('/api/dashboard-runtime/status').then(status => {
      app.status = app.entitiesUnavailable ? { ...status, connected: false } : status;
      if (app.layout) renderStatus();
      return status;
    }).catch(error => {
      app.status = {
        ...app.status,
        connected: false,
        error: error.message || 'Status is unavailable.',
      };
      if (app.layout) renderStatus();
      return null;
    });
    const entityRequest = api('/api/dashboard-runtime/entities').then(data => {
      app.entitiesLoaded = true;
      app.entitiesUnavailable = false;
      setEntities(data.entities);
      if (app.layout) {
        renderStatus();
        renderSummary();
        renderSections();
      }
      return data;
    }).catch(error => {
      app.entitiesUnavailable = true;
      app.status = {
        ...app.status,
        connected: false,
        error: error.message || app.status.error || 'Entities are unavailable.',
      };
      if (app.layout) {
        renderStatus();
        renderSummary();
        renderSections();
      }
      return null;
    });
    const catalogRequest = api('/api/dashboard-runtime/catalog').then(data => {
      app.catalogLoaded = true;
      setCatalog(data);
      if (app.layout) {
        const deepLink = focusFromHash();
        if (deepLink?.id && deepLink.mode === app.focusMode && !app.focusId
          && focusItems(deepLink.mode, true).some(item => item.id === deepLink.id)) {
          app.focusId = deepLink.id;
        }
        renderNav();
        renderSections();
      }
      return data;
    }).catch(() => null);
    const weatherRequest = api('/api/dashboard-runtime/weather').then(data => {
      setWeatherData(data);
      if (app.layout) renderSections();
      return data;
    }).catch(() => null);

    const layoutData = await layoutRequest;
    if (!layoutData.layout && !app.entitiesLoaded) await entityRequest;
    app.layoutEtag = layoutData._etag || null;
    app.layout = layoutData.layout ? cleanLayout(layoutData.layout) : buildDefaultLayout();
    app.layoutDirty = false;
    app.provisionalLayout = !layoutData.layout && app.entities.size === 0;
    app.focusMode = app.layout.focus.defaultMode;
    const deepLink = focusFromHash();
    if (deepLink) {
      app.focusMode = deepLink.mode;
      if (deepLink.mode !== 'overview' && focusItems(deepLink.mode, true).some(item => item.id === deepLink.id)) app.focusId = deepLink.id;
    }
    renderAll();
    if (OE_EDITOR_MODE && !layoutData.layout && app.entities.size) scheduleSave(500);
    app.pollTimer = setInterval(refreshEntities, 7000);
    startWidgetPolling();
    void refreshWidgets({ force: true });
    openRequestedDashboardPanel();
    void Promise.all([statusRequest, catalogRequest, weatherRequest, widgetCatalogRequest]);
  } catch (error) {
    if (error.status === 401) return;
    $('#hero').hidden = true;
    $('#summaryGrid').hidden = true;
    $('#dashboardAccessibleTitle').hidden = false;
    $('#dashboardAccessibleTitle').textContent = 'Dashboard unavailable';
    $('#sections').innerHTML = `<div class="empty-state"><div class="empty-mark">${ico('house')}</div><h2>The house didn't answer.</h2><p>${escapeHtml(error.message)}. Your dashboard layout is safe; check the server and try again.</p><button class="button primary" data-action="reload">${ico('refresh')}Try again</button></div>`;
    document.body.classList.remove('dashboard-layout-pending');
    toast(error.message, 'refresh');
  }
}

async function refreshDashboard(showFeedback = false) {
  const button = $('#refreshButton');
  if (button) button.disabled = true;
  try {
    await Promise.all([
      refreshEntities(false),
      loadWidgetCatalog({ force: true }),
    ]);
    await refreshWidgets({ force: true });
    if (showFeedback) {
      const failed = [...app.widgetData.values()].some(state => ['error', 'unavailable'].includes(state.status));
      toast(failed ? 'Dashboard refreshed · some widgets are unavailable' : 'Dashboard is up to date', failed ? 'refresh' : 'check');
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshEntities(showFeedback = false) {
  try {
    const status = await api('/api/dashboard-runtime/status');
    app.status = status;
    if (status.canView !== true) {
      app.entitiesLoaded = false;
      app.entitiesUnavailable = true;
      app.catalogLoaded = false;
      setEntities([]);
      setCatalog(null);
      app.weather.clear();
      renderStatus();
      renderNav();
      renderSummary();
      renderSections();
      if (showFeedback) toast(status.error || 'Home Assistant access is unavailable', 'lock');
      return;
    }
    const weatherRequest = Date.now() - app.weatherFetchedAt > 5 * 60_000
      ? api('/api/dashboard-runtime/weather').catch(() => null)
      : Promise.resolve(null);
    const catalogRequest = !app.catalogLoaded
      ? api('/api/dashboard-runtime/catalog').catch(() => null)
      : Promise.resolve(null);
    const [data, weatherData, catalogData] = await Promise.all([
      api('/api/dashboard-runtime/entities'),
      weatherRequest,
      catalogRequest,
    ]);
    app.entitiesLoaded = true;
    app.entitiesUnavailable = false;
    setEntities(data.entities);
    setWeatherData(weatherData);
    if (catalogData) {
      app.catalogLoaded = true;
      setCatalog(catalogData);
    }
    if (app.provisionalLayout && !app.layoutDirty && app.entities.size) {
      app.layout = buildDefaultLayout();
      app.provisionalLayout = false;
      app.focusMode = app.layout.focus.defaultMode;
      if (OE_EDITOR_MODE) scheduleSave(500);
    }
    renderStatus();
    renderNav();
    renderSummary();
    renderSections();
    if (showFeedback) toast('Your home is up to date', 'check');
  } catch (error) {
    app.entitiesUnavailable = true;
    const denied = error.status === 403;
    app.status = {
      ...app.status,
      connected: false,
      ...(denied ? { canView: false, canControl: false } : {}),
      error: error.message,
    };
    if (denied) {
      app.entitiesLoaded = false;
      app.catalogLoaded = false;
      setEntities([]);
      setCatalog(null);
      app.weather.clear();
    }
    renderStatus();
    if (denied) {
      renderNav();
      renderSummary();
      renderSections();
    }
    if (showFeedback) toast(error.message, 'refresh');
  }
}

function applyTheme() {
  document.body.dataset.theme = app.theme === 'sand' ? 'sand' : 'midnight';
  $('#themeButton use').setAttribute('href', app.theme === 'sand' ? '#i-moon' : '#i-sun');
  applyDashboardColors();
}

function applyFullscreenMode() {
  document.body.classList.toggle('fullscreen-mode', app.fullscreen);
  $('#fullscreenButton').setAttribute('aria-pressed', String(app.fullscreen));
  $('#fullscreenExit').setAttribute('aria-hidden', String(!app.fullscreen));
}

function clearFullscreenQuery() {
  const url = new URL(location.href);
  if (!url.searchParams.has('fullscreen')) return;
  url.searchParams.delete('fullscreen');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

async function setFullscreenMode(enabled, requestBrowser = true) {
  if (OE_EDITOR_MODE) return;
  app.fullscreen = !!enabled;
  localStorage.setItem(OE_FULLSCREEN_KEY, app.fullscreen ? '1' : '0');
  if (!app.fullscreen) clearFullscreenQuery();
  applyFullscreenMode();
  closeMobileMenu();
  if (app.fullscreen && requestBrowser && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
  } else if (!app.fullscreen && document.fullscreenElement && document.exitFullscreen) {
    try { await document.exitFullscreen(); } catch {}
  }
}

function applyDashboardChrome() {
  if (!app.layout) return;
  const chrome = dashboardChrome();
  const sidebarVisible = OE_EDITOR_MODE || chrome.showSidebar;
  const topbarVisible = OE_EDITOR_MODE || chrome.showTopbar;
  const greetingVisible = chrome.greetingMode !== 'hidden'
    && (chrome.greetingMode !== 'custom' || Boolean(chrome.greetingText.trim()));
  const taglineVisible = chrome.showTagline && Boolean(app.layout.title);
  const copyVisible = chrome.showHeroStatus || greetingVisible || taglineVisible;
  const heroVisible = copyVisible || chrome.showClock;
  const floatingMenuVisible = !topbarVisible && sidebarVisible;

  $('#sidebar').hidden = !sidebarVisible;
  $('#topbar').hidden = !topbarVisible;
  $('#dashboardBrand').hidden = !chrome.showBrand;
  $('#focusNavGroup').hidden = !chrome.showFocusNav;
  $('#sectionNavGroup').hidden = !chrome.showSectionNav;
  $('.side-nav').hidden = !chrome.showFocusNav && !chrome.showSectionNav;
  $('#sidebarStatus').hidden = !chrome.showSidebarStatus;
  $('#sidebarFoot').hidden = !chrome.showSidebarStatus && !OE_EDITOR_MODE;
  $('#menuButton').hidden = !sidebarVisible;
  $('#floatingMenuButton').hidden = !floatingMenuVisible;

  $('#heroStatus').hidden = !chrome.showHeroStatus;
  $('#heroStatus').classList.toggle('custom-text', Boolean(chrome.heroStatusText.trim()));
  $('#greeting').hidden = !greetingVisible;
  $('#dashboardTagline').hidden = !taglineVisible;
  $('#heroCopy').hidden = !copyVisible;
  $('#heroClock').hidden = !chrome.showClock;
  $('#hero').hidden = !heroVisible;
  $('#hero').classList.toggle('hero-time-only', chrome.showClock && !copyVisible);
  $('#dashboardAccessibleTitle').hidden = greetingVisible;

  document.body.classList.toggle('dashboard-sidebar-hidden', !sidebarVisible);
  document.body.classList.toggle('dashboard-topbar-hidden', !topbarVisible);
  if (!sidebarVisible) closeMobileMenu();
}

function updateClock() {
  const now = new Date();
  const hour = now.getHours();
  const chrome = dashboardChrome();
  $('#greeting').textContent = chrome.greetingMode === 'custom'
    ? chrome.greetingText
    : `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}.`;
  $('#heroTime').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#heroDate').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function renderAll() {
  applyDashboardColors();
  updateClock();
  $('#dashboardTagline').textContent = app.layout.title;
  renderDashboardIdentity();
  applyDashboardChrome();
  renderStatus();
  renderNav();
  renderSummary();
  renderSections();
  $('#editTools').hidden = !OE_EDITOR_MODE || !app.editing;
  $('#addSectionButton').hidden = app.focusMode !== 'overview';
  $('#customizeButton').classList.toggle('editing', app.editing);
  $('#customizeButton span').textContent = app.editing ? 'Done' : 'Customize';
  $('#customizeButton use').setAttribute('href', app.editing ? '#i-check' : '#i-sliders');
  document.body.classList.remove('dashboard-layout-pending');
}

function renderDashboardIdentity() {
  const name = app.dashboard?.name || 'Home';
  const owner = app.dashboard?.owner || 'Household';
  const layoutReady = Boolean(app.layout);
  $('#currentDashboardName').textContent = name;
  $('#currentDashboardOwner').textContent = owner;
  $('#dashboardBreadcrumbName').textContent = name;
  $('#dashboardAccessibleTitle').textContent = `${name} dashboard`;
  $('#summaryGrid').setAttribute('aria-label', `${name} summary`);
  $('#dashboardSwitcher').disabled = false;
  $('#refreshButton').disabled = false;
  $('#customizeButton').disabled = !OE_EDITOR_MODE || !layoutReady;
  $('#addDeviceButton').disabled = !OE_EDITOR_MODE || !layoutReady;
  const dashboards = dashboardCycleEntries();
  const cycleIndex = dashboards.findIndex(dashboard => dashboard.slug === app.dashboardSlug);
  const cycle = $('#dashboardCycle');
  const cycleVisible = !OE_EDITOR_MODE && cycleIndex >= 0 && dashboards.length > 1;
  cycle.hidden = !cycleVisible;
  if (cycleVisible) {
    const previous = dashboards[(cycleIndex - 1 + dashboards.length) % dashboards.length];
    const next = dashboards[(cycleIndex + 1) % dashboards.length];
    const position = `${name} · ${cycleIndex + 1} / ${dashboards.length}`;
    if ($('#dashboardCyclePosition').textContent !== position) $('#dashboardCyclePosition').textContent = position;
    const previousButton = $('[data-action="cycle-dashboard"][data-direction="previous"]', cycle);
    const nextButton = $('[data-action="cycle-dashboard"][data-direction="next"]', cycle);
    previousButton.setAttribute('aria-label', `Previous dashboard: ${previous.name}`);
    previousButton.title = `Previous dashboard: ${previous.name}`;
    nextButton.setAttribute('aria-label', `Next dashboard: ${next.name}`);
    nextButton.title = `Next dashboard: ${next.name}`;
  }
  document.title = `${name} · OpenEnsemble`;
}

function setHeroStatusLabel(automaticLabel) {
  $('#connectionLabel').textContent = dashboardChrome().heroStatusText.trim() || automaticLabel;
}

function renderDashboardNotFound(slug) {
  app.dashboard = null;
  app.dashboardSlug = slug || 'home';
  $('#currentDashboardName').textContent = 'Dashboard not found';
  $('#currentDashboardOwner').textContent = 'Return to OpenEnsemble';
  $('#dashboardBreadcrumbName').textContent = 'Not found';
  $('#activeSpaceLabel').textContent = 'Dashboard';
  $('#dashboardSwitcher').disabled = false;
  $('#refreshButton').disabled = true;
  $('#customizeButton').disabled = true;
  $('#addDeviceButton').disabled = true;
  $('#dashboardCycle').hidden = true;
  $('#focusModes').innerHTML = '';
  $('#contextNavLabel').textContent = 'Dashboard unavailable';
  $('#sideSections').innerHTML = '';
  $('#summaryGrid').innerHTML = '';
  $('#summaryGrid').hidden = true;
  $('#editTools').hidden = true;
  $('#dashboardTagline').textContent = 'That dashboard may have been renamed or removed.';
  $('#connectionLabel').textContent = 'Dashboard unavailable';
  $('#hero').hidden = true;
  $('#dashboardAccessibleTitle').hidden = false;
  $('#dashboardAccessibleTitle').textContent = 'Dashboard not found';
  $('#sections').className = 'sections';
  $('#sections').innerHTML = `<div class="empty-state dashboard-not-found"><div class="empty-mark">${ico('grid')}</div><h2>Dashboard not found</h2><p>There is no dashboard at <strong>${escapeHtml(slug ? dashboardPath(slug) : location.pathname)}</strong>.</p><div class="empty-actions"><a class="button primary" href="/" target="_top">${ico('house')}Return to OpenEnsemble</a></div></div>`;
  document.title = 'Dashboard not found · OpenEnsemble';
  document.body.classList.remove('dashboard-layout-pending');
}

function clearDashboardQueryParameter(name) {
  const url = new URL(location.href);
  if (!url.searchParams.has(name)) return;
  url.searchParams.delete(name);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function openRequestedDashboardPanel() {
  const settings = new URLSearchParams(location.search).get('settings') === '1';
  if (settings) clearDashboardQueryParameter('settings');
  if (OE_EDITOR_MODE && settings) requestAnimationFrame(openDashboardEditor);
}

function renderStatus() {
  const status = $('#sidebarStatus');
  const usesHomeAssistant = !app.layout || allCards().some(card => !isWidgetCard(card));
  if (!usesHomeAssistant) {
    document.body.classList.remove('ha-view-denied', 'ha-controls-disabled');
    status.className = 'ha-status online';
    $('strong', status).textContent = 'Dashboard ready';
    $('small', status).textContent = 'OpenEnsemble widgets';
    setHeroStatusLabel('Live from OpenEnsemble');
    $('.live-dot').style.background = 'var(--lime)';
    return;
  }
  const demo = app.status.mode === 'demo';
  const online = app.status.connected !== false;
  const canView = app.status.canView === true;
  const canControl = app.status.canControl === true;
  document.body.classList.toggle('ha-view-denied', !canView);
  document.body.classList.toggle('ha-controls-disabled', !canControl);
  status.className = `ha-status ${online && canView ? 'online' : 'offline'}`;
  $('strong', status).textContent = !canView
    ? 'Access unavailable'
    : demo ? (online ? 'Demo home' : 'Demo unavailable') : online ? 'Connected' : 'Offline';
  $('small', status).textContent = !canView
    ? 'OE profile permissions'
    : demo ? (online ? 'Ready to explore' : 'Home data unavailable') : (canControl ? 'Home Assistant' : 'Home Assistant · view only');
  setHeroStatusLabel(!canView
    ? 'Home Assistant access unavailable'
    : demo ? (online ? 'Interactive demo' : 'Home data unavailable')
      : online ? (canControl ? 'Live from Home Assistant' : 'View-only Home Assistant') : 'Reconnecting');
  $('.live-dot').style.background = online && canView ? 'var(--lime)' : 'var(--rose)';
}

function allCards() { return app.layout.sections.flatMap(section => section.cards); }
function allEntityIds() { return allCards().flatMap(cardEntityIds); }

function findCardById(cardId) {
  for (let sectionIndex = 0; sectionIndex < app.layout.sections.length; sectionIndex++) {
    const section = app.layout.sections[sectionIndex];
    const cardIndex = section.cards.findIndex(card => card.id === cardId);
    if (cardIndex >= 0) return { section, sectionIndex, card: section.cards[cardIndex], cardIndex };
  }
  return null;
}

function findEntityPlacement(entityId) {
  for (let sectionIndex = 0; sectionIndex < app.layout.sections.length; sectionIndex++) {
    const section = app.layout.sections[sectionIndex];
    const cardIndex = section.cards.findIndex(card => cardEntityIds(card).includes(entityId));
    if (cardIndex >= 0) return { section, sectionIndex, card: section.cards[cardIndex], cardIndex };
  }
  return null;
}

function assignmentFor(entityId) {
  return app.assignments.get(entityId) || { entityId, deviceId: null, areaId: null };
}

function areaName(areaId) {
  return app.catalog.areas.find(area => area.areaId === areaId)?.name || (areaId === UNASSIGNED_ID ? 'Unassigned' : 'Unknown room');
}

function entitiesForFocus(mode, id, includeDiagnostics = true) {
  if (!id) return [];
  return [...app.entities.values()].filter(entity => {
    if (!includeDiagnostics && entity.attributes.entity_category === 'diagnostic') return false;
    const assignment = assignmentFor(entity.entityId);
    if (mode === 'rooms') return id === UNASSIGNED_ID ? !assignment.areaId : assignment.areaId === id;
    return id === UNASSIGNED_ID ? !assignment.deviceId : assignment.deviceId === id;
  });
}

function focusConfig(mode) {
  return mode === 'rooms'
    ? { orderKey: 'roomOrder', hiddenKey: 'hiddenRooms', singular: 'room' }
    : { orderKey: 'deviceOrder', hiddenKey: 'hiddenDevices', singular: 'device' };
}

function focusItems(mode, includeHidden = app.editing) {
  const { orderKey, hiddenKey } = focusConfig(mode);
  const hidden = new Set(app.layout.focus[hiddenKey]);
  let items;
  if (mode === 'rooms') {
    items = app.catalog.areas.map(area => ({ id: area.areaId, name: area.name, icon: 'rooms', meta: 'Room' }));
  } else {
    items = app.catalog.devices
      .map(device => ({
        id: device.deviceId,
        name: device.name,
        icon: 'devices',
        meta: [device.manufacturer, device.model].filter(Boolean).join(' · ') || areaName(device.areaId),
      }))
      .filter(item => entitiesForFocus(mode, item.id).length);
  }
  const unassignedCount = entitiesForFocus(mode, UNASSIGNED_ID).length;
  if (unassignedCount) items.push({ id: UNASSIGNED_ID, name: 'Unassigned', icon: 'folder-plus', meta: mode === 'rooms' ? 'No room assigned' : 'No physical device' });
  const order = new Map(app.layout.focus[orderKey].map((id, index) => [id, index]));
  items.sort((a, b) => {
    const aIndex = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bIndex = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    return aIndex - bIndex || a.name.localeCompare(b.name);
  });
  return items
    .map(item => ({ ...item, hidden: hidden.has(item.id), entities: entitiesForFocus(mode, item.id, false) }))
    .filter(item => includeHidden || !item.hidden);
}

function focusItemName(mode, id) {
  return focusItems(mode, true).find(item => item.id === id)?.name || (mode === 'rooms' ? 'Room' : 'Device');
}

function setFocusMode(mode, id = null, persist = true) {
  if (!focusModes.includes(mode)) return;
  app.focusMode = mode;
  app.focusId = mode === 'overview' ? null : id;
  app.activeSection = 'all';
  app.focusQuery = '';
  app.focusShowAll = false;
  if (OE_EDITOR_MODE && persist && app.layout.focus.defaultMode !== mode) {
    app.layout.focus.defaultMode = mode;
    scheduleSave();
  }
  syncFocusHash();
  renderAll();
  closeMobileMenu();
}

function renderNav() {
  const chrome = dashboardChrome();
  if (app.activeSection !== 'all' && !app.layout.sections.some(section => section.id === app.activeSection)) app.activeSection = 'all';
  const modeLabels = { overview: ['grid', 'Overview'], rooms: ['rooms', 'Rooms'], devices: ['devices', 'Devices'] };
  $('#focusModes').innerHTML = focusModes.map(mode => {
    const [icon, label] = modeLabels[mode];
    return `<button class="side-item${app.focusMode === mode && !app.focusId ? ' active' : ''}" data-action="focus-mode" data-mode="${mode}">${ico(icon)}<span>${label}</span></button>`;
  }).join('');
  if (app.focusMode === 'overview') {
    $('#contextNavLabel').textContent = 'Dashboard sections';
    $('#sideSections').innerHTML = app.layout.sections.map(section => `<button class="side-item${app.activeSection === section.id ? ' active' : ''}" data-action="filter" data-id="${escapeHtml(section.id)}">${ico('house')}<span>${escapeHtml(section.title)}</span><small>${section.cards.length}</small></button>`).join('');
    const active = app.layout.sections.find(section => section.id === app.activeSection);
    $('#activeSpaceLabel').textContent = active?.title || 'Overview';
  } else {
    const items = focusItems(app.focusMode);
    $('#contextNavLabel').textContent = app.focusMode === 'rooms' ? 'Home Assistant rooms' : 'Home Assistant devices';
    $('#sideSections').innerHTML = items.map(item => `<button class="side-item${app.focusId === item.id ? ' active' : ''}${item.hidden ? ' nav-hidden' : ''}" data-action="focus-item" data-id="${escapeHtml(item.id)}">${ico(item.icon)}<span>${escapeHtml(item.name)}</span><small>${item.entities.length}</small></button>`).join('');
    $('#activeSpaceLabel').textContent = app.focusId ? focusItemName(app.focusMode, app.focusId) : (app.focusMode === 'rooms' ? 'Rooms' : 'Devices');
  }
  const modeChips = chrome.showFocusNav
    ? focusModes.map(mode => `<button class="space-chip${app.focusMode === mode && !app.focusId ? ' active' : ''}" data-action="focus-mode" data-mode="${mode}">${mode[0].toUpperCase() + mode.slice(1)}</button>`).join('')
    : '';
  const detailChip = chrome.showFocusNav && app.focusId ? `<button class="space-chip active" data-action="focus-item" data-id="${escapeHtml(app.focusId)}">${escapeHtml(focusItemName(app.focusMode, app.focusId))}</button>` : '';
  const sectionChips = chrome.showSectionNav && app.focusMode === 'overview' ? app.layout.sections.map(section => `<button class="space-chip${app.activeSection === section.id ? ' active' : ''}" data-action="filter" data-id="${escapeHtml(section.id)}">${escapeHtml(section.title)}</button>`).join('') : '';
  $('#mobileSpaces').innerHTML = `${modeChips}${detailChip}${sectionChips}`;
  $('#mobileSpaces').hidden = !modeChips && !detailChip && !sectionChips;
}

function isOn(entity) {
  return ['on', 'open', 'opening', 'unlocked', 'playing', 'home', 'cleaning', 'returning', 'heat', 'cool', 'dry', 'fan_only'].includes(String(entity?.state || '').toLowerCase());
}

function number(value, fallback = '—') {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
}

function renderSummary() {
  const summary = $('#summaryGrid');
  summary.hidden = !dashboardChrome().showSummary;
  if (summary.hidden) {
    summary.innerHTML = '';
    return;
  }
  const focused = app.focusMode !== 'overview' && app.focusId
    ? entitiesForFocus(app.focusMode, app.focusId)
    : null;
  const entities = focused || [...app.entities.values()];
  const lights = entities.filter(entity => entity.domain === 'light');
  const temp = entities.find(entity => entity.domain === 'climate' && entity.attributes.current_temperature != null) || entities.find(entity => entity.attributes.device_class === 'temperature' && Number.isFinite(Number(entity.state))) || entities.find(entity => entity.domain === 'weather');
  const temperature = temp?.attributes.current_temperature ?? temp?.attributes.temperature ?? temp?.state;
  const tempUnit = temp?.attributes.temperature_unit || temp?.attributes.unit_of_measurement || '°';
  const open = entities.filter(entity => entity.domain === 'lock' ? entity.state === 'unlocked' : entity.domain === 'cover' ? ['open', 'opening'].includes(entity.state) : entity.domain === 'binary_sensor' && ['door', 'window', 'opening', 'garage_door'].includes(entity.attributes.device_class) && entity.state === 'on');
  const available = entities.filter(entity => entity.available).length;
  const items = [
    ['light', `${lights.filter(isOn).length} on`, `${lights.length} lights`],
    ['thermometer', temperature != null ? `${number(temperature)}${tempUnit}` : 'Comfortable', 'Indoor climate'],
    ['shield', open.length ? `${open.length} open` : 'Secure', 'Doors, windows & locks'],
    ['wifi', `${available} online`, focused ? `${entities.length} in this ${focusConfig(app.focusMode).singular}` : `${Math.max(0, entities.length - available)} unavailable`],
  ];
  summary.innerHTML = items.map(([icon, value, label]) => `<article class="summary-card"><span class="summary-icon">${ico(icon)}</span><div style="min-width:0"><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></div></article>`).join('');
}

function entityIcon(entity) {
  const domain = entity.domain;
  const deviceClass = entity.attributes.device_class;
  if (domain === 'light') return 'light';
  if (domain === 'fan') return 'fan';
  if (domain === 'cover') return 'blinds';
  if (domain === 'lock') return 'lock';
  if (domain === 'climate' || deviceClass === 'temperature') return 'thermometer';
  if (domain === 'media_player') return 'speaker';
  if (domain === 'camera') return 'camera';
  if (domain === 'weather') return weatherPresentation(entity.state).icon;
  if (['scene', 'script', 'automation'].includes(domain)) return 'sparkles';
  if (deviceClass === 'humidity' || domain === 'humidifier') return 'droplet';
  if (['door', 'window', 'opening'].includes(deviceClass)) return 'door';
  if (domain === 'binary_sensor') return 'activity';
  if (domain === 'sensor' || domain === 'number' || domain === 'input_number') return 'gauge';
  return domain === 'switch' || domain === 'input_boolean' ? 'power' : 'house';
}

const WEATHER_PRESENTATION = {
  'clear-night': ['moon', 'Clear night'],
  cloudy: ['cloud', 'Cloudy'],
  exceptional: ['activity', 'Exceptional weather'],
  fog: ['fog', 'Foggy'],
  hail: ['cloud-snow', 'Hail'],
  lightning: ['cloud-lightning', 'Lightning'],
  'lightning-rainy': ['cloud-lightning', 'Thunderstorms'],
  partlycloudy: ['cloud-sun', 'Partly cloudy'],
  pouring: ['cloud-rain', 'Heavy rain'],
  rainy: ['cloud-rain', 'Rain'],
  snowy: ['cloud-snow', 'Snow'],
  'snowy-rainy': ['cloud-snow', 'Wintry mix'],
  sunny: ['sun', 'Sunny'],
  windy: ['wind', 'Windy'],
  'windy-variant': ['wind', 'Windy and cloudy'],
};

function weatherPresentation(condition) {
  const normalized = String(condition || 'unknown').trim().toLowerCase().replaceAll('_', '-');
  const [icon, label] = WEATHER_PRESENTATION[normalized] || ['cloud', normalized.replaceAll('-', ' ').replace(/\b\w/g, character => character.toUpperCase()) || 'Weather'];
  return { icon, label, condition: normalized };
}

function stateLabel(entity) {
  if (!entity.available) return 'Unavailable';
  const attrs = entity.attributes;
  const raw = entity.state.replaceAll('_', ' ');
  if (entity.domain === 'weather') return weatherPresentation(entity.state).label;
  if (entity.domain === 'light' && entity.state === 'on' && attrs.brightness != null) return `On · ${Math.round(Number(attrs.brightness) / 255 * 100)}%`;
  if (entity.domain === 'fan' && attrs.percentage != null) return `${raw} · ${attrs.percentage}%`;
  if (entity.domain === 'cover' && attrs.current_position != null) return `${raw} · ${attrs.current_position}%`;
  if (entity.domain === 'climate') return String(attrs.hvac_action && attrs.hvac_action !== 'idle' ? attrs.hvac_action : raw).replaceAll('_', ' ');
  if (entity.domain === 'media_player' && attrs.media_title) return attrs.media_title;
  if (entity.domain === 'binary_sensor') {
    if (['door', 'window', 'opening', 'garage_door'].includes(attrs.device_class)) return entity.state === 'on' ? 'Open' : 'Closed';
    if (['motion', 'occupancy', 'presence'].includes(attrs.device_class)) return entity.state === 'on' ? 'Detected' : 'Clear';
    if (['moisture', 'smoke', 'gas', 'problem'].includes(attrs.device_class)) return entity.state === 'on' ? 'Alert' : 'Clear';
  }
  return raw;
}

function timeAgo(value) {
  const elapsed = Date.now() - new Date(value || 0).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return '';
  if (elapsed < 60000) return 'just now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
  return `${Math.floor(elapsed / 86400000)}d ago`;
}

function editBar(card) {
  if (card.focus) {
    return `<div class="card-editbar focus-editbar"><span class="focus-edit-hint">Tap card to customize</span><button class="card-edit-button card-style-button" data-action="edit-focus-card" data-entity="${escapeHtml(card.entityId)}" title="Edit control style" aria-label="Edit control style">${ico('sliders')}<span>Style</span></button></div>`;
  }
  return `<div class="card-editbar"><div class="editbar-group"><span class="drag-handle" title="Drag to move">${ico('grip')}</span><button class="card-edit-button" data-action="move-card" data-id="${escapeHtml(card.id)}" data-direction="-1" title="Move left">${ico('chevron-left')}</button><button class="card-edit-button" data-action="move-card" data-id="${escapeHtml(card.id)}" data-direction="1" title="Move right">${ico('chevron-right')}</button></div><button class="card-edit-button card-style-button" data-action="edit-card" data-id="${escapeHtml(card.id)}" title="Customize card" aria-label="Customize card">${ico('sliders')}<span>Style</span></button></div>`;
}

function toggleCommand(entity) {
  if (entity.domain === 'lock') return entity.state === 'locked' ? 'unlock' : 'lock';
  if (entity.domain === 'cover') return ['open', 'opening'].includes(entity.state) ? 'close' : 'open';
  if (entity.domain === 'media_player') return 'toggle';
  return isOn(entity) ? 'turn_off' : 'turn_on';
}

function powerButton(entity, action = null) {
  if (!entity.available || !actionable.has(entity.domain) || ['scene', 'script', 'automation', 'cover'].includes(entity.domain)) return '';
  const command = action || toggleCommand(entity);
  return `<button class="power-button card-controls" data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="${command}" aria-label="${escapeHtml(command.replaceAll('_', ' '))} ${escapeHtml(entity.name)}" aria-pressed="${isOn(entity)}">${ico('power')}</button>`;
}

function canOpenExpandedCard(entity) {
  return !!entity && entity.domain !== 'camera';
}

function cardShell(card, entity, body, { className = '', top = undefined } = {}) {
  const title = card.title || entity.name;
  const expandable = !app.editing && !card.expanded && canOpenExpandedCard(entity);
  const classes = ['device-card', `size-${card.size}`, `accent-${card.accent}`, isOn(entity) ? 'on' : '', entity.available ? '' : 'unavailable', app.busy.has(entity.entityId) ? 'busy' : '', expandable ? 'expandable' : '', className].filter(Boolean).join(' ');
  const draggable = app.editing && !card.focus;
  const editAction = app.editing
    ? card.focus
      ? ` data-action="edit-focus-card" data-entity="${escapeHtml(card.entityId)}"`
      : ` data-action="edit-card" data-id="${escapeHtml(card.id)}"`
    : '';
  const expandButton = expandable
    ? `<button class="card-expand-button card-controls" data-action="open-device" data-card="${escapeHtml(card.id)}" data-entity="${escapeHtml(entity.entityId)}" aria-label="Open larger controls for ${escapeHtml(title)}" aria-haspopup="dialog" aria-controls="deviceDialog">${ico('maximize')}</button>`
    : '';
  return `<article class="${classes}" data-card-id="${escapeHtml(card.id)}" data-entity="${escapeHtml(entity.entityId)}"${editAction} draggable="${draggable}" tabindex="${app.editing ? '0' : '-1'}" aria-label="${escapeHtml(title)} card${app.editing ? ', tap to customize' : expandable ? ', open for larger controls' : ''}">${editBar(card)}<div class="card-inner"><div class="card-top"><span class="card-icon">${ico(entityIcon(entity))}</span><div class="card-heading"><div class="card-name">${escapeHtml(title)}</div><div class="card-state">${escapeHtml(stateLabel(entity))}</div></div>${expandButton}${top === false ? '' : top ?? powerButton(entity)}</div><div class="card-body">${body}</div></div></article>`;
}

function compactCard(card, entity) {
  const unit = entity.attributes.unit_of_measurement || '';
  const value = ['sensor', 'weather'].includes(entity.domain) ? entity.state : stateLabel(entity);
  return cardShell(card, entity, `<div class="card-value">${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ''}</div>`, { top: actionable.has(entity.domain) ? undefined : false });
}

function toggleCard(card, entity) {
  let detail = '';
  if (entity.domain === 'lock') detail = entity.state === 'locked' ? 'Secured' : 'Tap to secure';
  else if (entity.domain === 'vacuum' && entity.attributes.battery_level != null) detail = `${entity.attributes.battery_level}% battery`;
  else if (entity.domain === 'humidifier' && entity.attributes.humidity != null) detail = `Target ${entity.attributes.humidity}%`;
  const active = entity.domain === 'lock' ? entity.state === 'locked' : isOn(entity);
  const command = toggleCommand(entity);
  const label = entity.domain === 'lock' ? (active ? 'Locked' : 'Unlocked') : stateLabel(entity);
  const body = `<button class="toggle-control card-controls${active ? ' active' : ''}" data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="${escapeHtml(command)}" aria-label="${escapeHtml(command.replaceAll('_', ' '))} ${escapeHtml(entity.name)}" aria-pressed="${active}"${entity.available ? '' : ' disabled'}><span class="toggle-track"><i>${ico('power')}</i></span><span class="toggle-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail || (active ? 'Tap to turn off' : 'Tap to turn on'))}</small></span></button>`;
  return cardShell(card, entity, body, { top: false, className: 'toggle-card' });
}

function lightCard(card, entity) {
  const brightness = entity.state === 'on' ? Math.max(1, Math.round(Number(entity.attributes.brightness ?? 255) / 255 * 100)) : 0;
  const body = `<div class="card-controls"><div class="card-value" style="margin-bottom:17px">${brightness}<small>% brightness</small></div><div class="range-row">${ico('sun')}<input class="range" type="range" min="1" max="100" value="${brightness || 1}" style="--value:${brightness}%" data-entity="${escapeHtml(entity.entityId)}" data-command="set_brightness" aria-label="${escapeHtml(entity.name)} brightness"><span class="range-value">${brightness}%</span></div></div>`;
  return cardShell(card, entity, body);
}

function lightDimmerCard(card, entity) {
  const level = entity.state === 'on' ? Math.max(1, Math.round(Number(entity.attributes.brightness ?? 255) / 255 * 100)) : 0;
  const body = `<div class="dimmer-body card-controls"><div class="dimmer-dial" style="--level:${level}%" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${level}"><span>${ico('light')}<strong>${level}%</strong></span></div><div class="dimmer-slider"><span>Dim level</span><div class="range-row"><input class="range" type="range" min="0" max="100" value="${level}" style="--value:${level}%" data-entity="${escapeHtml(entity.entityId)}" data-command="set_brightness" data-unit="%" aria-label="${escapeHtml(entity.name)} dim level"><span class="range-value">${level}%</span></div></div></div>`;
  return cardShell(card, entity, body);
}

function supportsLightBrightness(entity) {
  const modes = Array.isArray(entity.attributes.supported_color_modes)
    ? entity.attributes.supported_color_modes
    : [];
  return entity.attributes.brightness != null || modes.some(mode => mode !== 'onoff');
}

function formatRangeValue(spec, value = spec.value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return spec.precision ? String(Number(numeric.toFixed(spec.precision))) : String(Math.round(numeric));
}

function rangeInput(entity, spec, className = '') {
  return `<input class="range${className ? ` ${className}` : ''}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.value}" style="--value:${spec.percent.toFixed(2)}%" data-entity="${escapeHtml(entity.entityId)}" data-command="${escapeHtml(spec.command)}" data-unit="${escapeHtml(spec.unit)}" data-precision="${spec.precision}" aria-label="${escapeHtml(entity.name)} ${escapeHtml(spec.label.toLowerCase())}"${entity.available ? '' : ' disabled'}>`;
}

function rangeContext(spec) {
  if (!Number.isFinite(spec.current)) return '';
  return `<span class="range-context">Current ${escapeHtml(formatRangeValue(spec, spec.current))}${escapeHtml(spec.unit)}</span>`;
}

function linearRangeCard(card, entity, spec) {
  const body = `<div class="linear-slider card-controls"><div class="slider-readout"><div><span>${escapeHtml(spec.label)}</span>${rangeContext(spec)}</div><strong data-range-output>${escapeHtml(formatRangeValue(spec))}<small>${escapeHtml(spec.unit)}</small></strong></div><div class="range-row">${ico(spec.icon)}${rangeInput(entity, spec)}<span class="range-value">${escapeHtml(formatRangeValue(spec))}${escapeHtml(spec.unit)}</span></div><div class="slider-limits"><span>${escapeHtml(formatRangeValue(spec, spec.min))}${escapeHtml(spec.unit)}</span><span>${escapeHtml(formatRangeValue(spec, spec.max))}${escapeHtml(spec.unit)}</span></div></div>`;
  return cardShell(card, entity, body);
}

function dialSliderCard(card, entity, spec) {
  const disabled = entity.available ? '' : ' disabled';
  const body = `<div class="radial-slider card-controls"><div class="radial-control" style="--level:${spec.percent.toFixed(2)}%" role="meter" aria-valuemin="${spec.min}" aria-valuemax="${spec.max}" aria-valuenow="${spec.value}"><span>${ico(spec.icon)}<strong data-range-output>${escapeHtml(formatRangeValue(spec))}<small>${escapeHtml(spec.unit)}</small></strong></span></div><div class="radial-slider-copy"><span class="slider-kind">${escapeHtml(spec.label)}</span>${rangeContext(spec)}<div class="range-stepper"><button data-action="range-step" data-entity="${escapeHtml(entity.entityId)}" data-delta="${-spec.step}" aria-label="Lower ${escapeHtml(spec.label.toLowerCase())}"${disabled}>${ico('minus')}</button><span>${escapeHtml(formatRangeValue(spec, spec.min))}–${escapeHtml(formatRangeValue(spec, spec.max))}${escapeHtml(spec.unit)}</span><button data-action="range-step" data-entity="${escapeHtml(entity.entityId)}" data-delta="${spec.step}" aria-label="Raise ${escapeHtml(spec.label.toLowerCase())}"${disabled}>${ico('plus')}</button></div><div class="range-row radial-track">${rangeInput(entity, spec)}<span class="range-value">${escapeHtml(formatRangeValue(spec))}${escapeHtml(spec.unit)}</span></div></div></div>`;
  return cardShell(card, entity, body);
}

function faderSliderCard(card, entity, spec) {
  const body = `<div class="fader-body card-controls"><div class="fader-track">${rangeInput(entity, spec, 'fader-range')}</div><div class="fader-copy"><span class="slider-kind">${escapeHtml(spec.label)}</span><strong data-range-output>${escapeHtml(formatRangeValue(spec))}<small>${escapeHtml(spec.unit)}</small></strong>${rangeContext(spec)}<div class="fader-limits"><span>${escapeHtml(formatRangeValue(spec, spec.max))}${escapeHtml(spec.unit)}</span><i></i><span>${escapeHtml(formatRangeValue(spec, spec.min))}${escapeHtml(spec.unit)}</span></div></div></div>`;
  return cardShell(card, entity, body);
}

function segmentsSliderCard(card, entity, spec) {
  const segmentCount = 9;
  const active = Math.round(spec.percent / 100 * (segmentCount - 1));
  const segments = Array.from({ length: segmentCount }, (_, index) => `<i class="${index <= active ? 'active' : ''}"></i>`).join('');
  const body = `<div class="segments-body card-controls"><div class="slider-readout"><div><span>${escapeHtml(spec.label)}</span>${rangeContext(spec)}</div><strong data-range-output>${escapeHtml(formatRangeValue(spec))}<small>${escapeHtml(spec.unit)}</small></strong></div><div class="segment-slider" style="--value:${spec.percent.toFixed(2)}%"><div class="segment-marks" aria-hidden="true">${segments}</div>${rangeInput(entity, spec, 'segment-range')}</div><div class="slider-limits"><span>${escapeHtml(formatRangeValue(spec, spec.min))}${escapeHtml(spec.unit)}</span><span>Slide anywhere</span><span>${escapeHtml(formatRangeValue(spec, spec.max))}${escapeHtml(spec.unit)}</span></div></div>`;
  return cardShell(card, entity, body);
}

function fanCard(card, entity) {
  const value = entity.state === 'on' ? Number(entity.attributes.percentage ?? 100) : 0;
  const body = `<div class="card-controls"><div class="card-value" style="margin-bottom:17px">${Math.round(value)}<small>% speed</small></div><div class="range-row">${ico('wind')}<input class="range" type="range" min="0" max="100" step="5" value="${value}" style="--value:${value}%" data-entity="${escapeHtml(entity.entityId)}" data-command="set_percentage" aria-label="${escapeHtml(entity.name)} speed"><span class="range-value">${Math.round(value)}%</span></div></div>`;
  return cardShell(card, entity, body);
}

function climateCard(card, entity) {
  const attrs = entity.attributes;
  const current = attrs.current_temperature ?? attrs.temperature ?? '—';
  const target = Number(attrs.temperature ?? current);
  const min = Number(attrs.min_temp ?? 50);
  const max = Number(attrs.max_temp ?? 90);
  const step = Number(attrs.target_temp_step ?? .5);
  const meter = Number.isFinite(target) && max > min ? Math.max(0, Math.min(100, (target - min) / (max - min) * 100)) : 50;
  const unit = attrs.temperature_unit || '°';
  const body = `<div class="climate-body card-controls"><div><div class="climate-current">Current<strong>${escapeHtml(number(current))}${escapeHtml(unit)}</strong></div><div class="stepper"><button data-action="step-temp" data-entity="${escapeHtml(entity.entityId)}" data-delta="${-step}" aria-label="Lower target">${ico('minus')}</button><span>Set ${escapeHtml(number(target))}${escapeHtml(unit)}</span><button data-action="step-temp" data-entity="${escapeHtml(entity.entityId)}" data-delta="${step}" aria-label="Raise target">${ico('plus')}</button></div></div><div class="meter" style="--meter:${meter.toFixed(1)}" role="meter" aria-valuenow="${Number.isFinite(target) ? target : ''}"><span>${escapeHtml(number(target))}${escapeHtml(unit)}</span></div></div>`;
  return cardShell(card, entity, body);
}

function thermostatSliderCard(card, entity) {
  const attrs = entity.attributes;
  const current = Number(attrs.current_temperature ?? attrs.temperature);
  const target = Number(attrs.temperature ?? current);
  const min = Number(attrs.min_temp ?? 50);
  const max = Number(attrs.max_temp ?? 90);
  const step = Number(attrs.target_temp_step ?? .5);
  const unit = attrs.temperature_unit || '°';
  const value = Number.isFinite(target) ? target : min;
  const percent = max > min ? Math.max(0, Math.min(100, (value - min) / (max - min) * 100)) : 50;
  const precision = Number.isInteger(step) ? 0 : 1;
  const body = `<div class="thermostat-slider card-controls"><div class="thermostat-readout"><span>Current ${escapeHtml(number(current))}${escapeHtml(unit)}</span><strong>Set to ${escapeHtml(number(value))}${escapeHtml(unit)}</strong></div><div class="temperature-scale"><span>${escapeHtml(number(min))}${escapeHtml(unit)}</span><span>${escapeHtml(number(max))}${escapeHtml(unit)}</span></div><div class="range-row"><input class="range temperature-range" type="range" min="${min}" max="${max}" step="${step}" value="${value}" style="--value:${percent}%" data-entity="${escapeHtml(entity.entityId)}" data-command="set_temperature" data-unit="${escapeHtml(unit)}" data-precision="${precision}" aria-label="${escapeHtml(entity.name)} target temperature"><span class="range-value">${escapeHtml(number(value))}${escapeHtml(unit)}</span></div></div>`;
  return cardShell(card, entity, body);
}

function coverCard(card, entity) {
  const hasPosition = entity.attributes.current_position != null
    && Number.isFinite(Number(entity.attributes.current_position));
  const position = Number(hasPosition ? entity.attributes.current_position : (entity.state === 'open' ? 100 : 0));
  const shade = Math.max(0, Math.min(100, 100 - position));
  const value = hasPosition ? `${Math.round(position)}<small>% open</small>` : escapeHtml(stateLabel(entity));
  const positionControl = hasPosition ? `<div class="range-row" style="margin-top:11px">${ico('blinds')}<input class="range" type="range" min="0" max="100" step="5" value="${position}" style="--value:${position}%" data-entity="${escapeHtml(entity.entityId)}" data-command="set_position" aria-label="${escapeHtml(entity.name)} position"><span class="range-value">${Math.round(position)}%</span></div>` : '';
  const body = `<div class="card-controls"><div class="cover-main"><div class="cover-visual" aria-hidden="true"><span class="cover-shade" style="height:${shade}%"></span></div><div style="min-width:0;flex:1"><div class="card-value" style="font-size:23px;margin-bottom:14px">${value}</div><div class="cover-actions"><button data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="open" title="Open">${ico('chevron-up')}</button><button data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="stop" title="Stop">${ico('minus')}</button><button data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="close" title="Close">${ico('chevron-down')}</button></div></div></div>${positionControl}</div>`;
  return cardShell(card, entity, body, { top: false });
}

function mediaCard(card, entity) {
  const attrs = entity.attributes;
  const hasVolume = attrs.volume_level != null && Number.isFinite(Number(attrs.volume_level));
  const volume = Math.round(Number(attrs.volume_level ?? 0) * 100);
  const title = attrs.media_title || attrs.source || 'Ready to play';
  const volumeControl = hasVolume ? `<div class="range-row">${ico('volume')}<input class="range" type="range" min="0" max="100" value="${volume}" style="--value:${volume}%" data-entity="${escapeHtml(entity.entityId)}" data-command="set_volume" aria-label="${escapeHtml(entity.name)} volume"><span class="range-value">${volume}%</span></div>` : '';
  const body = `<div class="card-controls"><div class="media-bars" aria-hidden="true">${'<span></span>'.repeat(8)}</div><div class="media-title">${escapeHtml(title)}${attrs.media_artist ? ` · ${escapeHtml(attrs.media_artist)}` : ''}</div>${volumeControl}</div>`;
  const top = `<button class="power-button card-controls" data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="toggle" aria-label="Play or pause">${ico(entity.state === 'playing' ? 'pause' : 'play')}</button>`;
  return cardShell(card, entity, body, { top });
}

function sparkline(entityId) {
  const values = app.histories.get(entityId) || [];
  if (values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), spread = max - min || 1;
  const points = values.map((value, index) => [index / (values.length - 1) * 94 + 1, 35 - (value - min) / spread * 29]);
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
  const fill = `${line} L${points.at(-1)[0].toFixed(1)},39 L${points[0][0].toFixed(1)},39 Z`;
  return `<svg class="sparkline" viewBox="0 0 96 39"><path class="fill" d="${fill}"></path><path d="${line}"></path></svg>`;
}

function sensorCard(card, entity) {
  const binary = entity.domain === 'binary_sensor';
  const unit = entity.attributes.unit_of_measurement || (entity.domain === 'weather' ? entity.attributes.temperature_unit : '');
  const value = binary ? stateLabel(entity) : entity.state;
  const ago = timeAgo(entity.lastChanged);
  const body = `<div class="sensor-main"><div><div class="card-value"${binary ? ' style="font-size:23px;text-transform:capitalize"' : ''}>${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ''}</div>${ago ? `<div class="binary-sub">Updated ${escapeHtml(ago)}</div>` : ''}</div>${sparkline(entity.entityId)}</div>`;
  return cardShell(card, entity, body, { top: false });
}

function weatherForecastLabel(value, index) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return index === 0 ? 'Next' : `+${index + 1}`;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  return date.toLocaleDateString([], { weekday: 'short' });
}

function weatherNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(value);
}

function weatherCard(card, entity) {
  const details = app.weather.get(entity.entityId) || {};
  const attrs = { ...entity.attributes, ...(details.current || {}) };
  const presentation = weatherPresentation(attrs.condition || entity.state);
  const temperature = weatherNumber(attrs.temperature);
  const humidity = weatherNumber(attrs.humidity);
  const apparent = weatherNumber(attrs.apparentTemperature ?? attrs.apparent_temperature);
  const pressure = weatherNumber(attrs.pressure);
  const wind = weatherNumber(attrs.windSpeed ?? attrs.wind_speed);
  const unit = attrs.temperatureUnit || attrs.temperature_unit || '°';
  const pressureUnit = attrs.pressureUnit || attrs.pressure_unit || '';
  const windUnit = attrs.windSpeedUnit || attrs.wind_speed_unit || '';
  const facts = [
    Number.isFinite(humidity) ? ['droplet', 'Humidity', `${number(humidity)}%`] : null,
    Number.isFinite(apparent) ? ['thermometer', 'Feels like', `${number(apparent)}${unit}`] : null,
    Number.isFinite(wind) ? ['wind', 'Wind', `${number(wind)}${windUnit ? ` ${windUnit}` : ''}`] : null,
    Number.isFinite(pressure) ? ['gauge', 'Pressure', `${number(pressure)}${pressureUnit ? ` ${pressureUnit}` : ''}`] : null,
  ].filter(Boolean).slice(0, 3);
  const requestedForecast = Array.isArray(details.forecast) ? details.forecast : [];
  const forecastLimit = card.size === 'wide' ? 5 : card.size === 'standard' ? 3 : 0;
  const forecast = requestedForecast.slice(0, forecastLimit);
  const forecastMarkup = forecast.length ? `<div class="weather-forecast">${forecast.map((item, index) => {
    const itemPresentation = weatherPresentation(item.condition);
    const high = weatherNumber(item.temperature);
    const low = weatherNumber(item.templow ?? item.temperatureLow ?? item.low);
    const rain = weatherNumber(item.precipitationProbability ?? item.precipitation_probability);
    const temperatures = Number.isFinite(high)
      ? `<strong>${number(high)}°${Number.isFinite(low) ? `<small>${number(low)}°</small>` : ''}</strong>`
      : '<strong>—</strong>';
    return `<div class="weather-forecast-item"><span>${escapeHtml(weatherForecastLabel(item.datetime, index))}</span>${ico(itemPresentation.icon)}${temperatures}${Number.isFinite(rain) ? `<em>${ico('droplet')}${number(rain)}%</em>` : ''}</div>`;
  }).join('')}</div>` : '';
  const factMarkup = facts.length ? `<div class="weather-facts">${facts.map(([icon, label, value]) => `<div>${ico(icon)}<span>${escapeHtml(label)}<strong>${escapeHtml(value)}</strong></span></div>`).join('')}</div>` : '';
  const reading = Number.isFinite(temperature)
    ? `<strong>${number(temperature)}<small>${escapeHtml(unit)}</small></strong>`
    : '<strong>—</strong>';
  const conditionClass = presentation.condition.replace(/[^a-z-]/g, '');
  const body = `<div class="weather-body"><div class="weather-current"><div class="weather-symbol weather-${conditionClass}">${ico(presentation.icon)}</div><div class="weather-reading">${reading}<span>${escapeHtml(presentation.label)}</span></div></div>${factMarkup}${forecastMarkup}</div>`;
  return cardShell(card, entity, body, { top: false, className: 'weather-card' });
}

function cameraImageUrl(entityId) {
  return `/api/dashboard-runtime/camera/${encodeURIComponent(entityId)}?v=${Date.now()}`;
}

function cameraCard(card, entity) {
  const title = card.title || entity.name;
  const body = `<button class="camera-preview card-controls" data-action="open-camera" data-entity="${escapeHtml(entity.entityId)}" aria-label="Open ${escapeHtml(title)} full screen"><img class="camera-image" src="${cameraImageUrl(entity.entityId)}" alt="Latest snapshot from ${escapeHtml(title)}" loading="lazy" decoding="async"><span class="camera-preview-fallback">${ico('camera')}<small>Camera preview unavailable</small></span><span class="camera-live-badge"><i></i>${entity.state === 'recording' ? 'Recording' : 'Snapshot'}</span><span class="camera-expand">${ico('maximize')}<small>Full screen</small></span></button>`;
  return cardShell(card, entity, body, { top: false, className: 'camera-card' });
}

function contactCard(card, entity) {
  const open = entity.state === 'on';
  const label = stateLabel(entity);
  const detail = timeAgo(entity.lastChanged);
  const kind = String(entity.attributes.device_class || 'door').replaceAll('_', ' ');
  const body = `<div class="contact-body"><div class="contact-graphic${open ? ' open' : ''}" aria-hidden="true"><span class="contact-frame"><i></i></span><span class="contact-sensor"></span></div><div class="contact-copy"><span>${escapeHtml(kind)}</span><strong>${escapeHtml(label)}</strong>${detail ? `<small>Changed ${escapeHtml(detail)}</small>` : ''}</div></div>`;
  return cardShell(card, entity, body, { top: false, className: open ? 'contact-open' : 'contact-closed' });
}

function sceneCard(card, entity) {
  const label = entity.domain === 'scene' ? 'Set scene' : entity.domain === 'automation' ? 'Run automation' : 'Run script';
  const body = `<div class="scene-orbit" aria-hidden="true"><span></span></div><button class="scene-run card-controls" data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="turn_on">${ico('play')}${label}</button>`;
  return cardShell(card, entity, body, { top: false });
}

function entityForCard(entityId) {
  return app.entities.get(entityId) || normalizeEntity({
    entityId,
    name: entityId.split('.').at(-1).replaceAll('_', ' '),
    state: 'unavailable',
    available: false,
    attributes: {},
  });
}

function groupItemState(entity) {
  if (!entity.available) return 'Unavailable';
  if (['sensor', 'number', 'input_number'].includes(entity.domain)) {
    const unit = entity.attributes.unit_of_measurement || '';
    return `${entity.state}${unit ? ` ${unit}` : ''}`;
  }
  return stateLabel(entity);
}

function groupItemAction(entity) {
  if (!entity.available || entity.domain === 'camera') return '';
  if (['scene', 'script', 'automation'].includes(entity.domain)) {
    return `<button class="group-item-action card-controls" data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="turn_on" aria-label="Run ${escapeHtml(entity.name)}">${ico('play')}</button>`;
  }
  if (!actionable.has(entity.domain)) return '';
  const command = toggleCommand(entity);
  return `<button class="group-item-action card-controls" data-action="control" data-entity="${escapeHtml(entity.entityId)}" data-command="${escapeHtml(command)}" aria-label="${escapeHtml(command.replaceAll('_', ' '))} ${escapeHtml(entity.name)}" aria-pressed="${isOn(entity)}">${ico('power')}</button>`;
}

function groupCard(card) {
  const entities = card.entityIds.map(entityForCard);
  const available = entities.filter(entity => entity.available);
  const active = available.filter(isOn);
  const unavailable = entities.length - available.length;
  const domains = new Set(entities.map(entity => entity.domain));
  const title = card.title || groupTitleFor(card.entityIds);
  const status = [
    `${entities.length} item${entities.length === 1 ? '' : 's'}`,
    active.length ? `${active.length} active` : '',
    unavailable ? `${unavailable} unavailable` : '',
  ].filter(Boolean).join(' · ');
  const icon = domains.size === 1 ? entityIcon(entities[0]) : 'grid';
  const classes = [
    'device-card',
    'group-card',
    `size-${card.size}`,
    `accent-${card.accent}`,
    active.length ? 'on' : '',
    available.length ? '' : 'unavailable',
  ].filter(Boolean).join(' ');
  const draggable = app.editing;
  const editAction = app.editing ? ` data-action="edit-card" data-id="${escapeHtml(card.id)}"` : '';
  const items = entities.map(entity => {
    const itemClasses = [
      'group-item',
      isOn(entity) ? 'on' : '',
      entity.available ? '' : 'unavailable',
      app.busy.has(entity.entityId) ? 'busy' : '',
    ].filter(Boolean).join(' ');
    return `<div class="${itemClasses}" data-group-entity="${escapeHtml(entity.entityId)}"><button class="group-item-main" data-action="open-group-device" data-card="${escapeHtml(card.id)}" data-entity="${escapeHtml(entity.entityId)}" aria-label="Open ${escapeHtml(entity.name)} controls"><span class="group-item-icon">${ico(entityIcon(entity))}</span><span class="group-item-copy"><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(groupItemState(entity))}</small></span></button>${groupItemAction(entity)}</div>`;
  }).join('');
  return `<article class="${classes}" data-card-id="${escapeHtml(card.id)}" data-group-card="true"${editAction} draggable="${draggable}" tabindex="${app.editing ? '0' : '-1'}" aria-label="${escapeHtml(title)} grouped card${app.editing ? ', tap to customize' : ''}">${editBar(card)}<div class="card-inner group-card-inner"><div class="card-top"><span class="card-icon">${ico(icon)}</span><div class="card-heading"><div class="card-name">${escapeHtml(title)}</div><div class="card-state">${escapeHtml(status)}</div></div></div><div class="card-body group-card-body"><div class="group-items">${items}</div></div></div></article>`;
}

function widgetDate(value, options) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(undefined, options);
}

function widgetDayKey(event) {
  const raw = event?.start;
  if (event?.allDay === true && /^\d{4}-\d{2}-\d{2}/.test(String(raw || ''))) return String(raw).slice(0, 10);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function widgetDayLabel(key) {
  if (!key) return 'Upcoming';
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const localKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const todayKey = localKey(today);
  const tomorrowKey = localKey(tomorrow);
  if (key === todayKey) return 'Today';
  if (key === tomorrowKey) return 'Tomorrow';
  const date = new Date(`${key}T12:00:00`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : key;
}

function widgetEventTime(event) {
  if (event?.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(String(event?.start || ''))) return 'All day';
  const start = widgetDate(event?.start, { hour: 'numeric', minute: '2-digit' });
  const end = widgetDate(event?.end, { hour: 'numeric', minute: '2-digit' });
  if (!start) return 'Time unavailable';
  return end && end !== start ? `${start} – ${end}` : start;
}

function calendarWidgetContent(card, data) {
  const events = (Array.isArray(data?.events) ? data.events : []).slice(0, 20);
  if (!events.length) {
    return {
      subtitle: 'Your schedule is clear',
      body: `<div class="widget-empty">${ico('calendar')}<strong>Nothing scheduled</strong><span>No events in this dashboard range.</span></div>`,
    };
  }
  const groups = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const key = widgetDayKey(event);
    let group = groups.find(item => item.key === key);
    if (!group) {
      group = { key, events: [] };
      groups.push(group);
    }
    group.events.push(event);
  }
  const body = groups.map(group => `<section class="widget-day"><h3>${escapeHtml(widgetDayLabel(group.key))}</h3><div class="widget-list">${group.events.map(event => {
    const title = String(event.title || event.summary || 'Untitled event').slice(0, 160);
    const calendar = String(event.calendarName || event.calendar || '').slice(0, 100);
    const location = String(event.location || '').slice(0, 180);
    return `<div class="widget-row calendar-widget-row"><span class="widget-row-marker"></span><div class="widget-row-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml([widgetEventTime(event), calendar].filter(Boolean).join(' · '))}</small>${location ? `<span>${ico('rooms')}${escapeHtml(location)}</span>` : ''}</div></div>`;
  }).join('')}</div></section>`).join('');
  return {
    subtitle: `${events.length} upcoming event${events.length === 1 ? '' : 's'}`,
    body: `<div class="calendar-widget-body">${body}</div>`,
  };
}

function emailSender(value) {
  const raw = String(value || '').slice(0, 240);
  return raw.replace(/<[^>]+>/, '').replaceAll('"', '').trim() || raw || 'Unknown sender';
}

function emailWidgetContent(card, data) {
  const emails = (Array.isArray(data?.emails) ? data.emails : []).slice(0, 20);
  const account = String(data?.account?.label || '').slice(0, 100);
  if (!emails.length) {
    return {
      subtitle: account || 'Recent email',
      body: `<div class="widget-empty">${ico('mail')}<strong>No recent email</strong><span>This inbox has nothing new to show.</span></div>`,
    };
  }
  const showSnippet = card.config?.showSnippet === true;
  const body = emails.map(email => {
    const sender = emailSender(email?.from);
    const subject = String(email?.subject || '(no subject)').slice(0, 180);
    const snippet = String(email?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    const date = widgetDate(email?.date, { month: 'short', day: 'numeric' });
    return `<div class="widget-row email-widget-row"><span class="widget-avatar">${escapeHtml(sender.charAt(0).toUpperCase() || '?')}</span><div class="widget-row-copy"><span class="widget-row-meta"><strong>${escapeHtml(sender)}</strong><time>${escapeHtml(date)}</time></span><b>${escapeHtml(subject)}</b>${showSnippet && snippet ? `<small>${escapeHtml(snippet)}</small>` : ''}</div></div>`;
  }).join('');
  return {
    subtitle: [account, `${emails.length} recent`].filter(Boolean).join(' · '),
    body: `<div class="widget-list email-widget-list">${body}</div>`,
  };
}

function widgetTone(value) {
  const tone = String(value || '').toLowerCase();
  const aliases = { neutral: 'muted', warn: 'warning', bad: 'danger', info: 'sky' };
  const normalized = aliases[tone] || tone;
  return ['lime', 'sky', 'violet', 'amber', 'rose', 'cyan', 'good', 'warning', 'danger', 'muted'].includes(normalized)
    ? normalized
    : 'muted';
}

function skillWidgetContent(card, data) {
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return {
      subtitle: 'Skill widget',
      body: `<div class="skill-widget-summary">${escapeHtml(String(data).slice(0, 2000))}</div>`,
    };
  }
  const safe = data && typeof data === 'object' ? data : {};
  const summary = String(safe.summary || safe.headline || '').slice(0, 2000);
  const subheadline = String(safe.subheadline || '').slice(0, 240);
  const metrics = (Array.isArray(safe.metrics) ? safe.metrics : []).slice(0, 12);
  const items = (Array.isArray(safe.items) ? safe.items : []).slice(0, 20);
  const metricHtml = metrics.length ? `<div class="widget-metrics">${metrics.map(metric => `<div class="widget-metric tone-${widgetTone(metric?.tone)}"><strong>${escapeHtml(String(metric?.value ?? '—').slice(0, 160))}</strong><span>${escapeHtml(String(metric?.label || '').slice(0, 80))}</span></div>`).join('')}</div>` : '';
  const itemHtml = items.length ? `<div class="widget-list skill-widget-list">${items.map(item => {
    const title = String(item?.title || item?.label || '').slice(0, 160);
    const subtitle = String(item?.subtitle || item?.meta || '').slice(0, 300);
    const value = String(item?.value ?? '').slice(0, 160);
    return `<div class="widget-row skill-widget-row tone-${widgetTone(item?.tone)}"><span class="widget-row-marker"></span><div class="widget-row-copy"><strong>${escapeHtml(title || value || 'Item')}</strong>${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ''}</div>${value && value !== title ? `<b class="widget-row-value">${escapeHtml(value)}</b>` : ''}</div>`;
  }).join('')}</div>` : '';
  const summaryHtml = summary ? `<div class="skill-widget-summary">${escapeHtml(summary)}</div>` : '';
  const body = `${summaryHtml}${metricHtml}${itemHtml}` || `<div class="widget-empty">${ico('sparkles')}<strong>No data to show</strong><span>This skill returned an empty widget.</span></div>`;
  return { subtitle: subheadline || `${metrics.length + items.length} item${metrics.length + items.length === 1 ? '' : 's'}`, body };
}

function widgetStatusContent(card, state, descriptor) {
  if (state.status === 'loading' || state.status === 'idle') {
    return {
      subtitle: 'Updating…',
      body: '<div class="widget-loading" aria-label="Loading widget"><i></i><i></i><i></i></div>',
    };
  }
  const missing = app.widgetCatalogLoaded && !app.widgetCatalogError && !descriptor;
  if (state.status === 'unavailable' || missing || descriptor?.available === false) {
    const reason = state.error || descriptor?.reason || 'This widget is no longer available for this profile.';
    return {
      subtitle: 'Unavailable',
      body: `<div class="widget-empty widget-problem">${ico('package')}<strong>Widget unavailable</strong><span>${escapeHtml(reason)}</span></div>`,
    };
  }
  if (state.status === 'error') {
    return {
      subtitle: 'Could not refresh',
      body: `<div class="widget-empty widget-problem">${ico('refresh')}<strong>Widget could not load</strong><span>${escapeHtml(state.error || 'Try refreshing this card.')}</span><button class="widget-retry" data-action="retry-widget" data-id="${escapeHtml(card.id)}">${ico('refresh')}Retry</button></div>`,
    };
  }
  return null;
}

function widgetCard(card) {
  const descriptor = widgetDescriptor(card.widgetId);
  const state = widgetState(card);
  const title = card.title || descriptor?.title || (widgetType(card) === 'calendar' ? 'Calendar' : widgetType(card) === 'email' ? 'Email' : 'Skill widget');
  const icon = descriptor?.icon || (widgetType(card, state.data) === 'calendar' ? 'calendar' : widgetType(card, state.data) === 'email' ? 'mail' : 'package');
  const statusContent = widgetStatusContent(card, state, descriptor);
  const content = statusContent || (widgetType(card, state.data) === 'calendar'
    ? calendarWidgetContent(card, state.data)
    : widgetType(card, state.data) === 'email'
      ? emailWidgetContent(card, state.data)
      : skillWidgetContent(card, state.data));
  const classes = [
    'device-card', 'dashboard-widget-card', `widget-${widgetType(card, state.data)}`,
    `size-${card.size}`, `accent-${card.accent}`,
    ['error', 'unavailable'].includes(state.status) ? 'widget-unavailable' : 'on',
  ].filter(Boolean).join(' ');
  const draggable = app.editing;
  const editAction = app.editing ? ` data-action="edit-card" data-id="${escapeHtml(card.id)}"` : '';
  const sourceUpdatedAt = widgetType(card, state.data) === 'skill' && state.data && typeof state.data === 'object'
    ? state.data.updatedAt
    : null;
  const updated = sourceUpdatedAt || state.fetchedAt
    ? widgetDate(sourceUpdatedAt || state.fetchedAt, { hour: 'numeric', minute: '2-digit' })
    : '';
  const stale = state.stale || (state.error && state.data !== null);
  const updatedBadge = !stale && updated ? `<span class="widget-updated">Updated ${escapeHtml(updated)}</span>` : '';
  const staleBanner = stale
    ? `<div class="widget-freshness stale">${ico('refresh')}<span>Showing the last update${state.error ? ` · ${escapeHtml(state.error)}` : ''}</span><button data-action="retry-widget" data-id="${escapeHtml(card.id)}">Retry</button></div>`
    : '';
  return `<article class="${classes}" data-card-id="${escapeHtml(card.id)}" data-widget-id="${escapeHtml(card.widgetId)}"${editAction} draggable="${draggable}" tabindex="${app.editing ? '0' : '-1'}" aria-label="${escapeHtml(title)} widget${app.editing ? ', tap to customize' : ''}">${editBar(card)}<div class="card-inner widget-card-inner"><div class="card-top"><span class="card-icon">${ico(icon)}</span><div class="card-heading"><div class="card-name">${escapeHtml(title)}</div><div class="card-state">${escapeHtml(content.subtitle || descriptor?.description || 'Dashboard widget')}</div></div>${updatedBadge}</div>${staleBanner}<div class="card-body widget-card-body">${content.body}</div></div></article>`;
}

function renderCard(card) {
  if (isWidgetCard(card)) return widgetCard(card);
  if (isGroupCard(card)) return groupCard(card);
  const entity = entityForCard(card.entityId);
  const rangeSpec = rangeSpecFor(entity);
  if (entity.domain === 'weather') return weatherCard(card, entity);
  if (card.view === 'compact') return compactCard(card, entity);
  if (card.view === 'contact') return contactCard(card, entity);
  if (card.view === 'status' || ['sensor', 'binary_sensor', 'weather', 'person'].includes(entity.domain)) return sensorCard(card, entity);
  if (entity.domain === 'camera') return cameraCard(card, entity);
  if (card.view === 'toggle') return toggleCard(card, entity);
  if (rangeSpec && card.view === 'dial') return dialSliderCard(card, entity, rangeSpec);
  if (rangeSpec && card.view === 'fader') return faderSliderCard(card, entity, rangeSpec);
  if (rangeSpec && card.view === 'segments') return segmentsSliderCard(card, entity, rangeSpec);
  if (['scene', 'script', 'automation'].includes(entity.domain)) return sceneCard(card, entity);
  if (entity.domain === 'light') return supportsLightBrightness(entity) ? (card.view === 'dimmer' ? lightDimmerCard(card, entity) : lightCard(card, entity)) : toggleCard(card, entity);
  if (entity.domain === 'fan') return entity.attributes.percentage != null || entity.attributes.percentage_step != null ? fanCard(card, entity) : toggleCard(card, entity);
  if (entity.domain === 'climate') return entity.attributes.temperature != null ? (card.view === 'thermostat' ? thermostatSliderCard(card, entity) : climateCard(card, entity)) : toggleCard(card, entity);
  if (entity.domain === 'cover') return coverCard(card, entity);
  if (entity.domain === 'media_player') return mediaCard(card, entity);
  if (rangeSpec && ['number', 'input_number', 'humidifier'].includes(entity.domain)) return linearRangeCard(card, entity, rangeSpec);
  return toggleCard(card, entity);
}

function focusCardFor(entity) {
  const override = app.layout.focus.cards.find(card => card.entityId === entity.entityId);
  return {
    id: `focus-${entity.entityId.replace(/[^a-z0-9_-]/gi, '-')}`,
    entityId: entity.entityId,
    title: override?.title || '',
    view: override?.view || defaultView(entity),
    size: override?.size || defaultSize(entity.domain),
    accent: override?.accent || defaultAccent(entity.domain),
    focus: true,
  };
}

function sortedFocusEntities(entities) {
  const priority = entity => {
    if (actionable.has(entity.domain) || rangeSpecFor(entity)) return 0;
    if (entity.domain === 'binary_sensor' && ['door', 'window', 'opening', 'garage_door'].includes(entity.attributes.device_class)) return 1;
    if (entity.domain === 'binary_sensor') return 2;
    if (entity.domain === 'sensor') return 3;
    return 2;
  };
  return [...entities].sort((a, b) => Number(!a.available) - Number(!b.available) || priority(a) - priority(b) || a.name.localeCompare(b.name));
}

function renderFocusGrid() {
  const grid = $('#focusGrid');
  if (!grid) return;
  const query = app.focusQuery.trim().toLowerCase();
  const mode = app.focusMode;
  const items = focusItems(mode).filter(item => !query || `${item.name} ${item.meta} ${item.entities.map(entity => `${entity.name} ${entity.entityId}`).join(' ')}`.toLowerCase().includes(query));
  if (!items.length) {
    grid.innerHTML = `<div class="focus-empty">${ico('search')}<strong>No ${mode} match</strong><span>${query ? 'Try another search.' : app.editing ? 'All items are hidden. Use Dashboard settings to reset the layout.' : `Home Assistant has no ${mode} to show yet.`}</span></div>`;
    return;
  }
  grid.innerHTML = items.map((item, index) => {
    const on = item.entities.filter(isOn).length;
    const available = item.entities.filter(entity => entity.available).length;
    const icons = sortedFocusEntities(item.entities).slice(0, 4);
    const summary = item.entities.length ? `${available}/${item.entities.length} online${on ? ` · ${on} active` : ''}` : 'No entities';
    const editActions = app.editing ? `<div class="focus-tile-actions"><button data-action="move-focus" data-mode="${mode}" data-id="${escapeHtml(item.id)}" data-direction="-1" aria-label="Move ${escapeHtml(item.name)} earlier"${index === 0 ? ' disabled' : ''}>${ico('chevron-left')}</button><button data-action="move-focus" data-mode="${mode}" data-id="${escapeHtml(item.id)}" data-direction="1" aria-label="Move ${escapeHtml(item.name)} later"${index === items.length - 1 ? ' disabled' : ''}>${ico('chevron-right')}</button><button class="focus-hide-button" data-action="toggle-focus-hidden" data-mode="${mode}" data-id="${escapeHtml(item.id)}">${item.hidden ? 'Show' : 'Hide'}</button></div>` : '';
    return `<article class="focus-tile${item.hidden ? ' focus-hidden' : ''}"><button class="focus-tile-main" data-action="focus-item" data-id="${escapeHtml(item.id)}"><span class="focus-tile-top"><span class="focus-tile-icon">${ico(item.icon)}</span><span class="focus-arrow">${ico('chevron-right')}</span></span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.meta)}</small><span class="focus-entity-icons">${icons.map(entity => `<i title="${escapeHtml(entity.name)}">${ico(entityIcon(entity))}</i>`).join('')}${item.entities.length > 4 ? `<em>+${item.entities.length - 4}</em>` : ''}</span><span class="focus-tile-summary">${escapeHtml(summary)}</span></button>${editActions}</article>`;
  }).join('');
}

function renderFocusResults() {
  const root = $('#focusResults');
  if (!root || !app.focusId) return;
  const query = app.focusQuery.trim().toLowerCase();
  const entities = sortedFocusEntities(entitiesForFocus(app.focusMode, app.focusId, app.focusShowAll))
    .filter(entity => !query || `${entity.name} ${entity.entityId} ${entity.domain} ${stateLabel(entity)}`.toLowerCase().includes(query));
  const primary = entities.filter(entity => actionable.has(entity.domain) || rangeSpecFor(entity) || (entity.domain === 'binary_sensor' && ['door', 'window', 'opening', 'garage_door'].includes(entity.attributes.device_class)));
  const readings = entities.filter(entity => !primary.includes(entity));
  const groups = [
    ['Controls & access', 'sliders', primary],
    ['Sensors & details', 'activity', readings],
  ].filter(([, , list]) => list.length);
  if (!groups.length) {
    root.innerHTML = `<div class="focus-empty">${ico('search')}<strong>No entities to show</strong><span>${query ? 'Try another search or show every entity.' : 'This selection has no current Home Assistant entities.'}</span></div>`;
    return;
  }
  const showHeaders = dashboardChrome().showSectionHeaders || app.editing;
  root.innerHTML = groups.map(([title, icon, list]) => `<section class="section focus-section" aria-label="${escapeHtml(title)}">${showHeaders ? `<header class="section-head"><span class="section-icon">${ico(icon)}</span><h2 class="section-title">${title}</h2><span class="section-count">${list.length}</span></header>` : ''}<div class="device-grid">${list.map(entity => renderCard(focusCardFor(entity))).join('')}</div></section>`).join('');
}

function renderFocusView() {
  const mode = app.focusMode;
  const plural = mode === 'rooms' ? 'Rooms' : 'Devices';
  const description = mode === 'rooms'
    ? 'Every area is pulled directly from Home Assistant. Open one to see its controls, doors, and sensors together.'
    : 'Browse physical Home Assistant devices and all of the entities each device exposes.';
  $('#sections').className = `sections focus-sections${app.editing ? ' editing' : ''}`;
  if (!app.focusId) {
    $('#sections').innerHTML = `<section class="focus-page"><header class="focus-page-head"><div><span class="focus-kicker">Home Assistant ${plural.toLowerCase()}</span><h2>${plural}</h2><p>${description}</p></div><label class="focus-search">${ico('search')}<input id="focusSearch" value="${escapeHtml(app.focusQuery)}" placeholder="Search ${plural.toLowerCase()} or entities" autocomplete="off"></label></header>${app.editing ? `<div class="customize-note">${ico('sliders')}Reorder or hide ${plural.toLowerCase()} here. Open one, then tap any card to choose its control style.</div>` : ''}<div class="focus-grid" id="focusGrid"></div></section>`;
    renderFocusGrid();
    return;
  }
  const name = focusItemName(mode, app.focusId);
  const entityCount = entitiesForFocus(mode, app.focusId).length;
  $('#sections').innerHTML = `<section class="focus-page"><header class="focus-detail-head"><button class="focus-back" data-action="focus-back">${ico('chevron-left')}All ${plural.toLowerCase()}</button><div class="focus-detail-title"><span class="focus-kicker">${mode === 'rooms' ? 'Room focus' : 'Device focus'}</span><h2>${escapeHtml(name)}</h2><p>${entityCount} Home Assistant entit${entityCount === 1 ? 'y' : 'ies'}</p></div><div class="focus-detail-tools"><label class="focus-search compact-search">${ico('search')}<input id="focusSearch" value="${escapeHtml(app.focusQuery)}" placeholder="Filter entities" autocomplete="off"></label><button class="button ghost${app.focusShowAll ? ' editing' : ''}" data-action="focus-show-all">${app.focusShowAll ? 'Hide diagnostics' : 'All entities'}</button></div></header>${app.editing ? `<div class="customize-note">${ico('sliders')}Tap any card to change its slider, graphic, size, name, or color. This style is shared across Rooms and Devices, but not the pinned Overview card.</div>` : ''}<div class="focus-results" id="focusResults"></div></section>`;
  renderFocusResults();
}

function renderSections() {
  if (app.focusMode !== 'overview') {
    renderFocusView();
    renderExpandedCard();
    return;
  }
  const visible = app.layout.sections.filter(section => app.activeSection === 'all' || section.id === app.activeSection);
  $('#sections').className = `sections${app.editing ? ' editing' : ''}`;
  const customizeHint = app.editing ? `<div class="customize-note overview-customize-note">${ico('sliders')}<span><strong>Customize mode</strong> · Tap any card to change its content, size, or color. Drag cards to move them.</span></div>` : '';
  if (!visible.length) {
    const emptyCanvas = OE_EDITOR_MODE && app.editing
      ? `<div class="empty-dashboard-canvas"><span>${ico('folder-plus')}</span><h2>Start with a section</h2><p>Sections organize cards and widgets into any layout you want.</p><button class="button primary" data-action="create-empty-section">${ico('plus')}New section</button></div>`
      : '';
    $('#sections').innerHTML = customizeHint + emptyCanvas;
    renderExpandedCard();
    return;
  }
  const showHeaders = dashboardChrome().showSectionHeaders || app.editing;
  $('#sections').innerHTML = customizeHint + visible.map(section => {
    const collapsed = showHeaders && section.collapsed;
    const header = showHeaders
      ? `<header class="section-head"><span class="section-icon">${ico(section.title.toLowerCase().includes('security') ? 'shield' : section.title.toLowerCase().includes('scene') ? 'sparkles' : 'grid')}</span><h2 class="section-title">${escapeHtml(section.title)}</h2><span class="section-count">${section.cards.length}</span><div class="section-actions"><button class="section-button" data-action="move-section" data-id="${escapeHtml(section.id)}" data-direction="-1" title="Move up" aria-label="Move ${escapeHtml(section.title)} up">${ico('chevron-up')}</button><button class="section-button" data-action="move-section" data-id="${escapeHtml(section.id)}" data-direction="1" title="Move down" aria-label="Move ${escapeHtml(section.title)} down">${ico('chevron-down')}</button><button class="section-button" data-action="edit-section" data-id="${escapeHtml(section.id)}" title="Edit section" aria-label="Edit ${escapeHtml(section.title)} section">${ico('pencil')}</button></div><button class="section-button section-collapse" data-action="collapse" data-id="${escapeHtml(section.id)}" title="${section.collapsed ? 'Expand' : 'Collapse'}" aria-label="${section.collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(section.title)}">${ico(section.collapsed ? 'chevron-down' : 'chevron-up')}</button></header>`
      : '';
    const cards = collapsed ? '' : `<div class="device-grid" data-drop-section="${escapeHtml(section.id)}">${section.cards.length ? section.cards.map(renderCard).join('') : `<div class="section-empty">${ico('plus')}${app.editing ? 'Drop a card here' : 'No cards in this section'}</div>`}</div>`;
    return `<section class="section" data-section-id="${escapeHtml(section.id)}" aria-label="${escapeHtml(section.title)}" style="--accent:var(--${section.accent})">${header}${cards}</section>`;
  }).join('');
  renderExpandedCard();
}

function setSaveStatus(text, className = '') {
  $('#saveStatus').textContent = text;
  $('#saveStatus').className = `save-status ${className}`;
}

function scheduleSave(delay = 420) {
  if (!OE_EDITOR_MODE || app.saveConflict || !app.layout) return;
  app.provisionalLayout = false;
  app.layoutDirty = true;
  app.saveError = null;
  clearTimeout(app.saveTimer);
  app.saveTimer = null;
  setSaveStatus('Saving…', 'saving');
  if (app.saveInFlight) {
    app.saveQueued = true;
    return;
  }
  app.saveTimer = setTimeout(() => {
    app.saveTimer = null;
    saveLayout();
  }, delay);
}

async function saveLayout() {
  clearTimeout(app.saveTimer);
  app.saveTimer = null;
  if (!OE_EDITOR_MODE || app.saveConflict || !app.layout) return false;
  if (app.saveInFlight) {
    app.saveQueued = true;
    const activeSave = app.savePromise;
    if (activeSave) await activeSave;
    if (app.saveConflict || app.saveError) return false;
    return app.layoutDirty ? saveLayout() : true;
  }
  app.saveInFlight = true;
  app.saveQueued = false;
  app.saveError = null;
  const dashboardSlug = app.dashboardSlug;
  const snapshot = JSON.stringify(app.layout);
  const lifecycle = (async () => {
    let result;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (app.layoutEtag) headers['If-Match'] = app.layoutEtag;
      const data = await api(dashboardLayoutApiPath(dashboardSlug), { method: 'PUT', headers, body: snapshot });
      result = { ok: true, data };
    } catch (error) {
      app.saveError = error;
      if (error.status === 409) {
        app.saveConflict = true;
        app.saveQueued = false;
        setSaveStatus('Update conflict', 'error');
        const reload = confirm('This dashboard changed on another screen. Reload the latest layout? Your unsaved changes on this screen will be discarded.');
        if (reload) location.reload();
        else toast('Reload before making more layout changes on this screen', 'refresh');
      } else {
        setSaveStatus('Not saved', 'error');
        toast(error.message, 'refresh');
      }
      result = { ok: false, error };
    } finally {
      const sameDashboard = app.dashboardSlug === dashboardSlug;
      const changed = sameDashboard && JSON.stringify(app.layout) !== snapshot;
      if (result?.ok && sameDashboard) {
        app.layoutEtag = result.data._etag || app.layoutEtag;
        app.layoutDirty = changed;
        if (!changed) {
          setSaveStatus('Saved', 'saved');
          setTimeout(() => { if ($('#saveStatus').textContent === 'Saved') setSaveStatus(''); }, 1800);
        }
      } else if (sameDashboard) {
        app.layoutDirty = true;
      }
      app.saveInFlight = false;
      app.savePromise = null;
      const queued = app.saveQueued;
      app.saveQueued = false;
      if (!app.saveConflict && !app.saveError && app.layoutDirty && (queued || changed)) {
        scheduleSave(0);
      }
    }
    return Boolean(result?.ok && app.dashboardSlug === dashboardSlug && !app.layoutDirty);
  })();
  app.savePromise = lifecycle;
  return lifecycle;
}

async function flushPendingLayout() {
  if (!OE_EDITOR_MODE) return true;
  const dashboardMutation = app.dashboardMutationPromise;
  if (dashboardMutation && !(await dashboardMutation)) return false;
  clearTimeout(app.saveTimer);
  app.saveTimer = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (app.saveConflict) return false;
    if (app.saveInFlight) {
      if (app.savePromise) await app.savePromise;
      if (app.saveError) return false;
      continue;
    }
    if (!app.layoutDirty) return true;
    const saved = await saveLayout();
    if (!saved && app.saveError) return false;
  }
  return !app.layoutDirty && !app.saveInFlight && !app.saveConflict;
}

// OE's same-origin Dashboard drawer calls this before replacing the editor
// iframe, so a pending debounced save cannot be lost during navigation.
window.oeDashboardFlushPendingLayout = flushPendingLayout;

function trackDashboardMutation(promise) {
  const current = Promise.resolve(promise).then(result => result !== false, () => false);
  const previous = app.dashboardMutationPromise;
  const tracked = previous
    ? Promise.all([previous, current]).then(results => results.every(Boolean))
    : current;
  app.dashboardMutationPromise = tracked;
  tracked.finally(() => {
    if (app.dashboardMutationPromise === tracked) app.dashboardMutationPromise = null;
  });
  return tracked;
}

function internalDashboardUrl(anchor) {
  if (!anchor || anchor.target && anchor.target !== '_self' || anchor.hasAttribute('download')) return null;
  let url;
  try { url = new URL(anchor.href, location.href); } catch { return null; }
  if (url.origin !== location.origin) return null;
  if (url.pathname !== '/' && url.pathname !== '/dashboards' && !/^\/dashboards\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(url.pathname)) return null;
  return url;
}

async function navigateAfterLayoutFlush(url) {
  if (app.navigationPending) return;
  app.navigationPending = true;
  setSaveStatus('Saving…', 'saving');
  const saved = await flushPendingLayout();
  if (saved) {
    location.assign(url.toString());
    return;
  }
  app.navigationPending = false;
  setSaveStatus('Not saved', 'error');
  toast('Stay on this dashboard until its changes can be saved', 'refresh');
}

function accentOptions(active) {
  return `<div class="accent-row" id="accentPicker" data-value="${active}">${accents.map(accent => `<button class="accent-option${active === accent ? ' active' : ''}" style="--swatch:var(--${accent})" data-action="accent" data-value="${accent}" title="${accent}" aria-label="${accent} accent"></button>`).join('')}</div>`;
}

const viewChoiceMeta = {
  auto: ['sparkles', 'Chooses the best control automatically'],
  dimmer: ['light', 'Light ring with a fine brightness slider'],
  thermostat: ['thermometer', 'Temperature readout with a full-width slider'],
  slider: ['sliders', 'A familiar horizontal level control'],
  dial: ['gauge', 'A touch-friendly ring with fine adjustment'],
  fader: ['sliders', 'An upright console-style level control'],
  segments: ['grid', 'Large steps that are easy to tap'],
  toggle: ['power', 'A large on/off control'],
  contact: ['door', 'A clear open or closed door graphic'],
  camera: ['camera', 'An authenticated snapshot that refreshes periodically'],
  compact: ['grid', 'A smaller card for dense layouts'],
  status: ['activity', 'State and sensor information only'],
};

function viewChoicePicker(options, active, entity) {
  const adjustableViews = new Set(['dimmer', 'thermostat', 'slider', 'dial', 'fader', 'segments']);
  const adjustable = options.filter(([value]) => adjustableViews.has(value));
  const other = options.filter(([value]) => !adjustableViews.has(value));
  const groups = rangeSpecFor(entity) && adjustable.length
    ? [['Slider types', adjustable], ['Other card styles', other]]
    : [['Available styles', options]];
  const choice = ([value, label]) => {
    const [icon, description] = viewChoiceMeta[value] || ['grid', 'Custom card presentation'];
    const selected = value === active;
    return `<button type="button" class="view-choice${selected ? ' active' : ''}" data-action="card-view-choice" data-value="${escapeHtml(value)}" aria-pressed="${selected}"><span class="view-choice-icon">${ico(icon)}</span><span class="view-choice-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span><span class="view-choice-check">${ico('check')}</span></button>`;
  };
  return `<input type="hidden" id="cardView" value="${escapeHtml(active)}"><div class="view-choice-picker" id="cardViewPicker" data-value="${escapeHtml(active)}">${groups.filter(([, items]) => items.length).map(([title, items]) => `<div class="view-choice-group"><span class="view-choice-group-title">${escapeHtml(title)}</span><div class="view-choice-grid">${items.map(choice).join('')}</div></div>`).join('')}</div>`;
}

function controlStyleField(entity, options, active) {
  const adjustable = Boolean(rangeSpecFor(entity));
  const helper = !entity
    ? 'This entity is no longer available from Home Assistant, so only basic card styles are shown.'
    : adjustable
      ? 'Choose the control you want. Only sliders this Home Assistant entity can safely support are shown.'
      : 'Home Assistant does not expose an adjustable value for this entity, so slider styles are not available.';
  return `<div class="field control-style-field"><span class="field-label">${adjustable ? 'Slider & control style' : 'Control style'}</span><p class="style-helper">${escapeHtml(helper)}</p>${viewChoicePicker(options, active, entity)}</div>`;
}

function panelShell(title, subtitle, body, foot) {
  closeMobileMenu();
  $('#panel').innerHTML = `<header class="panel-head"><div class="panel-head-copy"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="panel-close" data-action="close-panel" aria-label="Close panel">${ico('x')}</button></header><div class="panel-body">${body}</div><footer class="panel-foot">${foot}</footer>`;
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  syncDrawerBackdrop();
}

function closePanel() {
  app.panel = null;
  app.pickerSelection.clear();
  app.pickerWidgetId = null;
  $('#panel').classList.remove('open');
  $('#panel').setAttribute('aria-hidden', 'true');
  syncDrawerBackdrop();
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = value;
    temporary.setAttribute('readonly', '');
    temporary.style.position = 'fixed';
    temporary.style.opacity = '0';
    document.body.appendChild(temporary);
    temporary.select();
    const copied = document.execCommand('copy');
    temporary.remove();
    if (!copied) throw new Error('Copy is unavailable in this browser');
  }
}

async function copyDashboardAddress(slug = app.dashboardSlug) {
  try {
    await copyText(dashboardAddress(slug));
    toast('Dashboard address copied', 'copy');
  } catch (error) {
    toast(error.message || 'Unable to copy the address', 'refresh');
  }
}

function syncDrawerBackdrop() {
  const backdrop = $('#drawerBackdrop');
  const panelOpen = $('#panel').classList.contains('open');
  const menuOpen = $('#sidebar').classList.contains('open');
  backdrop.hidden = !panelOpen && !menuOpen;
  if (!backdrop.hidden) backdrop.dataset.mode = panelOpen ? 'panel' : 'menu';
}

function expandedView(card, entity) {
  if (!['compact', 'status'].includes(card.view)) return card.view;
  return actionable.has(entity.domain) || rangeSpecFor(entity) ? defaultView(entity) : card.view;
}

function renderExpandedCard(force = false) {
  const dialog = $('#deviceDialog');
  if (!app.expandedCard || !dialog) return;
  if (!force && dialog.open && $('.range:active', dialog)) return;
  const container = $('#deviceDialogCard');
  const active = document.activeElement;
  const focusable = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
  let restoreFocus = null;
  if (container?.contains(active)) {
    const peers = $$(focusable, container).filter(item => (
      item.tagName === active.tagName
      && (item.dataset.action || '') === (active.dataset.action || '')
      && (item.dataset.entity || '') === (active.dataset.entity || '')
    ));
    restoreFocus = {
      tagName: active.tagName,
      action: active.dataset.action || '',
      entity: active.dataset.entity || '',
      command: active.dataset.command || '',
      delta: active.dataset.delta || '',
      label: active.getAttribute('aria-label') || '',
      index: Math.max(0, peers.indexOf(active)),
    };
  }
  const entity = entityForCard(app.expandedCard.entityId);
  const title = app.expandedCard.title || entity.name;
  const expanded = {
    ...app.expandedCard,
    id: `expanded-${entity.entityId.replace(/[^a-z0-9_-]/gi, '-')}`,
    view: expandedView(app.expandedCard, entity),
    size: 'wide',
    focus: false,
    expanded: true,
  };
  $('#deviceDialogTitle').textContent = title;
  $('#deviceDialogState').textContent = stateLabel(entity);
  container.innerHTML = renderCard(expanded);
  if (restoreFocus) {
    const peers = $$(focusable, container).filter(item => (
      item.tagName === restoreFocus.tagName
      && (item.dataset.action || '') === restoreFocus.action
      && (item.dataset.entity || '') === restoreFocus.entity
    ));
    const exact = peers.find(item => (
      (item.dataset.command || '') === restoreFocus.command
      && (item.dataset.delta || '') === restoreFocus.delta
      && (item.getAttribute('aria-label') || '') === restoreFocus.label
    ));
    const next = exact || peers[restoreFocus.index] || peers[0];
    (next && !next.disabled ? next : $('#deviceDialogTitle'))?.focus({ preventScroll: true });
  }
}

function openExpandedCard(entityId, sourceCardId) {
  if (app.editing) return;
  const entity = app.entities.get(entityId);
  if (!entity) return;
  if (entity.domain === 'camera') {
    openCameraViewer(entityId);
    return;
  }
  const source = findCardById(sourceCardId)?.card || focusCardFor(entity);
  app.expandedCard = isGroupCard(source)
    ? {
      id: `group-item-${entityId.replace(/[^a-z0-9_-]/gi, '-')}`,
      entityId,
      title: '',
      view: defaultView(entity),
      size: 'wide',
      accent: source.accent,
    }
    : { ...source, entityId };
  app.expandedSourceCardId = sourceCardId;
  closeCameraViewer();
  closePanel();
  closeMobileMenu();
  renderExpandedCard(true);
  const dialog = $('#deviceDialog');
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('device-dialog-open');
  requestAnimationFrame(() => $('#deviceDialogTitle')?.focus());
}

function closeExpandedCard(restoreFocus = true) {
  const dialog = $('#deviceDialog');
  const sourceCardId = app.expandedSourceCardId;
  const sourceEntityId = app.expandedCard?.entityId;
  app.expandedCard = null;
  app.expandedSourceCardId = null;
  document.body.classList.remove('device-dialog-open');
  if (dialog?.open) dialog.close();
  if (!restoreFocus || !sourceCardId) return;
  queueMicrotask(() => {
    const source = $$('.device-card', $('#sections')).find(card => card.dataset.cardId === sourceCardId);
    const groupItem = sourceEntityId
      ? $$('[data-action="open-group-device"]', source).find(item => item.dataset.entity === sourceEntityId)
      : null;
    (groupItem || source?.querySelector('[data-action="open-device"]'))?.focus();
  });
}

function refreshCameraViewer() {
  if (app.cameraViewerMode !== 'snapshot' || !app.cameraViewerEntity || $('#cameraViewer').hidden) return;
  $('#cameraViewerImage').src = cameraImageUrl(app.cameraViewerEntity);
}

function clearCameraViewerRefresh() {
  clearTimeout(app.cameraViewerTimer);
  app.cameraViewerTimer = null;
}

function scheduleCameraViewerRefresh(delay = CAMERA_VIEWER_REFRESH_MS) {
  clearCameraViewerRefresh();
  if (!app.cameraViewerEntity || $('#cameraViewer').hidden) return;
  app.cameraViewerTimer = setTimeout(() => {
    app.cameraViewerTimer = null;
    refreshCameraViewer();
  }, delay);
}

function setCameraViewerStatus(message, detail = '', kind = null) {
  const status = $('#cameraViewerStatus');
  const loading = $('#cameraViewerLoadingText');
  const transport = $('#cameraViewerKind');
  if (status) {
    status.textContent = message;
    status.title = detail;
  }
  if (loading) loading.textContent = message;
  if (transport && kind) transport.textContent = kind;
}

function setCameraViewerRetryVisible(visible) {
  const retry = $('#cameraViewerRetry');
  if (retry) retry.hidden = !visible;
}

function cameraWebRtcSessionActive(session) {
  return !!session && !session.closed && app.cameraViewerWebRtc === session
    && app.cameraViewerEntity === session.entityId && !$('#cameraViewer').hidden;
}

function cameraWebRtcMessageError(message) {
  return message?.error?.message || message?.error?.code || 'Camera signaling request failed';
}

function sendCameraWebRtcRequest(session, type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!cameraWebRtcSessionActive(session) || session.socket?.readyState !== 1) {
      reject(new Error('Camera signaling connection is not open'));
      return;
    }
    const id = session.nextId++;
    session.pending.set(id, { resolve, reject });
    try {
      session.socket.send(JSON.stringify({ id, type, ...payload }));
    } catch (error) {
      session.pending.delete(id);
      reject(error);
    }
  });
}

function sendCameraWebRtcCandidate(session, candidate) {
  if (!cameraWebRtcSessionActive(session) || !candidate?.candidate) return;
  if (!session.sessionId) {
    session.localCandidates.push(candidate);
    return;
  }
  const value = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
  sendCameraWebRtcRequest(session, 'camera/webrtc/candidate', {
    entity_id: session.entityId,
    session_id: session.sessionId,
    candidate: value,
  }).catch(error => {
    if (cameraWebRtcSessionActive(session)) console.warn('Could not send a WebRTC ICE candidate', error);
  });
}

async function addCameraWebRtcRemoteCandidate(session, candidateValue) {
  if (!cameraWebRtcSessionActive(session) || !session.peer || !candidateValue?.candidate) return;
  const value = candidateValue.sdpMid || candidateValue.sdpMLineIndex != null
    ? candidateValue
    : { ...candidateValue, sdpMid: '0' };
  if (!session.peer.remoteDescription) {
    session.remoteCandidates.push(value);
    return;
  }
  try {
    const candidate = typeof RTCIceCandidate === 'function' ? new RTCIceCandidate(value) : value;
    await session.peer.addIceCandidate(candidate);
  } catch (error) {
    // A single unusable candidate is expected on some mixed IPv4/IPv6 networks.
    // Other candidates can still establish the live stream.
    console.warn('Could not add a WebRTC ICE candidate', error);
  }
}

async function handleCameraWebRtcOfferEvent(session, event) {
  if (!cameraWebRtcSessionActive(session) || !event || typeof event !== 'object') return;
  try {
    if (event.type === 'session') {
      if (typeof event.session_id !== 'string' || !event.session_id) throw new Error('Camera returned an invalid WebRTC session');
      session.sessionId = event.session_id;
      const candidates = session.localCandidates.splice(0);
      candidates.forEach(candidate => sendCameraWebRtcCandidate(session, candidate));
      return;
    }
    if (event.type === 'answer') {
      if (typeof event.answer !== 'string' || !event.answer) throw new Error('Camera returned an invalid WebRTC answer');
      if (!session.peer || ['stable', 'closed'].includes(session.peer.signalingState)) return;
      await session.peer.setRemoteDescription({ type: 'answer', sdp: event.answer });
      const candidates = session.remoteCandidates.splice(0);
      for (const candidate of candidates) await addCameraWebRtcRemoteCandidate(session, candidate);
      return;
    }
    if (event.type === 'candidate') {
      await addCameraWebRtcRemoteCandidate(session, event.candidate);
      return;
    }
    if (event.type === 'error') throw new Error(event.message || event.code || 'Camera rejected the WebRTC stream');
  } catch (error) {
    cameraViewerWebRtcFailed(session, error.message);
  }
}

function handleCameraWebRtcMessage(session, raw) {
  if (!cameraWebRtcSessionActive(session)) return;
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (!message || typeof message !== 'object') return;
  if (message.type === 'ready') {
    if (session.started) return;
    session.started = true;
    negotiateCameraWebRtc(session).catch(error => cameraViewerWebRtcFailed(session, error.message));
    return;
  }
  if (message.type === 'bridge_error') {
    cameraViewerWebRtcFailed(session, message.message || 'The WebRTC bridge reported an error.');
    return;
  }
  if (message.type === 'result' && Number.isInteger(message.id)) {
    const pending = session.pending.get(message.id);
    if (pending) {
      session.pending.delete(message.id);
      if (message.success) pending.resolve(message.result);
      else pending.reject(new Error(cameraWebRtcMessageError(message)));
    } else if (message.id === session.offerId && !message.success) {
      cameraViewerWebRtcFailed(session, cameraWebRtcMessageError(message));
    }
    return;
  }
  if (message.type === 'event' && message.id === session.offerId) {
    handleCameraWebRtcOfferEvent(session, message.event);
  }
}

function markCameraWebRtcReady(session) {
  if (!cameraWebRtcSessionActive(session) || app.cameraViewerMode !== 'webrtc') return;
  session.live = true;
  session.iceRestarting = false;
  session.iceRestartAttempts = 0;
  clearTimeout(session.timeout);
  clearTimeout(session.disconnectTimer);
  clearTimeout(session.iceRestartTimer);
  const viewer = $('#cameraViewer');
  viewer.classList.add('webrtc-ready');
  viewer.classList.remove('image-ready', 'image-error', 'webrtc-error');
  setCameraViewerRetryVisible(false);
  setCameraViewerStatus('WebRTC live · Low latency', '', 'Live camera');
}

function unsubscribeCameraWebRtcOffer(session) {
  const subscription = session.offerId;
  session.offerId = null;
  if (!Number.isInteger(subscription) || session.socket?.readyState !== 1) return;
  try {
    session.socket.send(JSON.stringify({
      id: session.nextId++,
      type: 'unsubscribe_events',
      subscription,
    }));
  } catch {}
}

async function startCameraWebRtcNegotiation(session, iceRestart = false) {
  if (!cameraWebRtcSessionActive(session) || !session.peer || session.negotiating) return;
  session.negotiating = true;
  try {
    unsubscribeCameraWebRtcOffer(session);
    session.sessionId = null;
    session.localCandidates.length = 0;
    session.remoteCandidates.length = 0;
    const offer = await session.peer.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
      ...(iceRestart ? { iceRestart: true } : {}),
    });
    if (!cameraWebRtcSessionActive(session)) return;
    await session.peer.setLocalDescription(offer);
    if (!cameraWebRtcSessionActive(session)) return;
    const gathered = session.localCandidates.splice(0)
      .map(candidate => `a=${candidate.candidate}\r\n`)
      .join('');
    const offerSdp = `${offer.sdp || session.peer.localDescription?.sdp || ''}${gathered}`;
    if (!offerSdp) throw new Error('The browser did not create a WebRTC offer.');
    const offerId = session.nextId++;
    session.offerId = offerId;
    session.socket.send(JSON.stringify({
      id: offerId,
      type: 'camera/webrtc/offer',
      entity_id: session.entityId,
      offer: offerSdp,
    }));
  } finally {
    session.negotiating = false;
  }
}

function cameraWebRtcConnectionRecovered(session) {
  if (!cameraWebRtcSessionActive(session)) return;
  clearTimeout(session.disconnectTimer);
  clearTimeout(session.iceRestartTimer);
  session.disconnectTimer = null;
  session.iceRestartTimer = null;
  session.iceRestarting = false;
  session.iceRestartAttempts = 0;
  setCameraViewerStatus(
    session.live ? 'WebRTC live · Low latency' : 'WebRTC connected · Waiting for video…',
    '',
    session.live ? 'Live camera' : 'Camera viewer',
  );
}

function restartCameraWebRtcIce(session, reason = 'The WebRTC media route was interrupted.') {
  if (!cameraWebRtcSessionActive(session) || !session.peer || session.iceRestarting) return;
  clearTimeout(session.disconnectTimer);
  session.disconnectTimer = null;
  if (session.iceRestartAttempts >= CAMERA_WEBRTC_MAX_ICE_RESTARTS) {
    cameraViewerWebRtcFailed(session, reason);
    return;
  }
  session.iceRestartAttempts += 1;
  session.iceRestarting = true;
  setCameraViewerStatus(
    `Reconnecting live view… Attempt ${session.iceRestartAttempts} of ${CAMERA_WEBRTC_MAX_ICE_RESTARTS}`,
    reason,
    'Reconnecting live camera',
  );
  try {
    if (typeof session.peer.restartIce === 'function') {
      // restartIce emits negotiationneeded; the handler below sends the fresh offer.
      session.peer.restartIce();
    } else {
      // Older Chromium/Silk builds can request an ICE restart through createOffer.
      startCameraWebRtcNegotiation(session, true)
        .catch(error => cameraViewerWebRtcFailed(session, error.message));
    }
  } catch (error) {
    session.iceRestarting = false;
    cameraViewerWebRtcFailed(session, error.message);
    return;
  }
  clearTimeout(session.iceRestartTimer);
  session.iceRestartTimer = setTimeout(() => {
    if (!cameraWebRtcSessionActive(session)) return;
    const connected = session.peer?.connectionState === 'connected'
      || ['connected', 'completed'].includes(session.peer?.iceConnectionState);
    if (connected) {
      cameraWebRtcConnectionRecovered(session);
      return;
    }
    session.iceRestarting = false;
    restartCameraWebRtcIce(session, reason);
  }, CAMERA_WEBRTC_ICE_RESTART_TIMEOUT_MS);
}

async function negotiateCameraWebRtc(session) {
  setCameraViewerStatus('Checking WebRTC support…', '', 'Camera viewer');
  const capabilities = await sendCameraWebRtcRequest(session, 'camera/capabilities', {
    entity_id: session.entityId,
  });
  if (!cameraWebRtcSessionActive(session)) return;
  const streamTypes = Array.isArray(capabilities?.frontend_stream_types)
    ? capabilities.frontend_stream_types
    : [];
  if (!streamTypes.includes('web_rtc')) {
    startCameraViewerFallback('This camera does not advertise WebRTC support.');
    return;
  }
  session.nativeWebRtcConfirmed = true;
  if (typeof RTCPeerConnection === 'undefined' || typeof MediaStream === 'undefined') {
    throw new Error('This browser does not support native WebRTC playback.');
  }

  setCameraViewerStatus('Starting low-latency stream…', '', 'Camera viewer');
  const clientConfig = await sendCameraWebRtcRequest(session, 'camera/webrtc/get_client_config', {
    entity_id: session.entityId,
  });
  if (!cameraWebRtcSessionActive(session)) return;
  const configuration = clientConfig?.configuration && typeof clientConfig.configuration === 'object'
    ? clientConfig.configuration
    : {};
  const peer = new RTCPeerConnection(configuration);
  const remoteStream = new MediaStream();
  const video = $('#cameraViewerVideo');
  session.peer = peer;
  session.remoteStream = remoteStream;
  video.muted = true;
  video.defaultMuted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.srcObject = remoteStream;

  if (typeof clientConfig?.dataChannel === 'string' && clientConfig.dataChannel) {
    peer.createDataChannel(clientConfig.dataChannel);
  }
  peer.ontrack = event => {
    if (!cameraWebRtcSessionActive(session)) return;
    if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
    video.srcObject = remoteStream;
    video.play().catch(() => {});
  };
  peer.onicecandidate = event => {
    if (event.candidate?.candidate) sendCameraWebRtcCandidate(session, event.candidate);
  };
  peer.onnegotiationneeded = () => {
    if (!cameraWebRtcSessionActive(session) || session.negotiating) return;
    if (session.offerId && !session.iceRestarting) return;
    startCameraWebRtcNegotiation(session, session.iceRestarting)
      .catch(error => cameraViewerWebRtcFailed(session, error.message));
  };
  peer.onconnectionstatechange = () => {
    if (!cameraWebRtcSessionActive(session)) return;
    if (peer.connectionState === 'connected') {
      cameraWebRtcConnectionRecovered(session);
    } else if (peer.connectionState === 'failed') {
      restartCameraWebRtcIce(session, 'The WebRTC connection failed after retrying its media route.');
    } else if (peer.connectionState === 'disconnected') {
      if (!session.disconnectTimer) {
        setCameraViewerStatus('Live view interrupted · Waiting to reconnect…', '', 'Reconnecting live camera');
        session.disconnectTimer = setTimeout(() => {
          session.disconnectTimer = null;
          if (peer.connectionState === 'disconnected') {
            restartCameraWebRtcIce(session, 'The WebRTC connection stayed disconnected after retrying.');
          }
        }, CAMERA_WEBRTC_DISCONNECT_RESTART_MS);
      }
    }
  };
  peer.oniceconnectionstatechange = () => {
    if (!cameraWebRtcSessionActive(session)) return;
    if (['connected', 'completed'].includes(peer.iceConnectionState)) {
      cameraWebRtcConnectionRecovered(session);
    } else if (peer.iceConnectionState === 'failed') {
      restartCameraWebRtcIce(session, 'WebRTC could not establish a media route after retrying.');
    }
  };
  if (typeof peer.addTransceiver === 'function') {
    peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.addTransceiver('video', { direction: 'recvonly' });
    // A short safety kick keeps older Silk builds working if they miss the event.
    session.negotiationKickTimer = setTimeout(() => {
      if (cameraWebRtcSessionActive(session) && !session.offerId && !session.negotiating) {
        startCameraWebRtcNegotiation(session)
          .catch(error => cameraViewerWebRtcFailed(session, error.message));
      }
    }, 250);
  } else {
    await startCameraWebRtcNegotiation(session);
  }
}

function cleanupCameraViewerWebRtc() {
  const session = app.cameraViewerWebRtc;
  app.cameraViewerWebRtc = null;
  if (!session) {
    const video = $('#cameraViewerVideo');
    if (video) {
      video.srcObject?.getTracks?.().forEach(track => track.stop());
      video.srcObject = null;
    }
    return;
  }
  session.closed = true;
  clearTimeout(session.timeout);
  clearTimeout(session.disconnectTimer);
  clearTimeout(session.iceRestartTimer);
  clearTimeout(session.negotiationKickTimer);
  if (session.socket?.readyState === 1 && Number.isInteger(session.offerId)) {
    try {
      session.socket.send(JSON.stringify({
        id: session.nextId++,
        type: 'unsubscribe_events',
        subscription: session.offerId,
      }));
    } catch {}
  }
  for (const pending of session.pending.values()) pending.reject(new Error('Camera viewer closed'));
  session.pending.clear();
  if (session.peer) {
    session.peer.ontrack = null;
    session.peer.onicecandidate = null;
    session.peer.onnegotiationneeded = null;
    session.peer.onconnectionstatechange = null;
    session.peer.oniceconnectionstatechange = null;
    session.peer.getReceivers?.().forEach(receiver => receiver.track?.stop());
    session.peer.close();
  }
  session.remoteStream?.getTracks().forEach(track => track.stop());
  const video = $('#cameraViewerVideo');
  if (video) {
    video.pause();
    video.srcObject?.getTracks?.().forEach(track => track.stop());
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
  }
  if (session.socket) {
    session.socket.onopen = null;
    session.socket.onmessage = null;
    session.socket.onerror = null;
    session.socket.onclose = null;
    if (session.socket.readyState < 2) session.socket.close(1000, 'Viewer closed');
  }
}

function cameraViewerWebRtcFailed(session, reason = 'WebRTC negotiation failed.') {
  if (!cameraWebRtcSessionActive(session)) return;
  showCameraViewerWebRtcError(session, reason);
}

function showCameraViewerWebRtcError(session, reason) {
  const entityId = session.entityId;
  const nativeWebRtcConfirmed = session.nativeWebRtcConfirmed;
  cleanupCameraViewerWebRtc();
  clearCameraViewerRefresh();
  if (!entityId || app.cameraViewerEntity !== entityId || $('#cameraViewer').hidden) return;
  app.cameraViewerMode = 'webrtc-error';
  app.cameraViewerFallbackReason = null;
  const viewer = $('#cameraViewer');
  const image = $('#cameraViewerImage');
  const explanation = String(reason || 'WebRTC negotiation failed.').replace(/\s+/g, ' ').trim();
  image.removeAttribute('src');
  viewer.classList.remove('webrtc-ready', 'webrtc-error', 'image-ready', 'image-error');
  viewer.classList.add('webrtc-error');
  setCameraViewerStatus(
    `Live view failed: ${explanation} No recorded camera media is being shown.`,
    explanation,
    nativeWebRtcConfirmed ? 'Native live view unavailable' : 'Live view unavailable',
  );
  setCameraViewerRetryVisible(true);
  requestAnimationFrame(() => {
    if (app.cameraViewerMode === 'webrtc-error' && app.cameraViewerEntity === entityId) {
      $('#cameraViewerRetry')?.focus();
    }
  });
}

function startCameraViewerFallback(reason) {
  const entityId = app.cameraViewerEntity;
  if (!entityId || $('#cameraViewer').hidden) return;
  cleanupCameraViewerWebRtc();
  clearCameraViewerRefresh();
  app.cameraViewerMode = 'snapshot';
  app.cameraViewerFallbackReason = reason;
  const viewer = $('#cameraViewer');
  const image = $('#cameraViewerImage');
  const entityName = app.entities.get(entityId)?.name || 'camera';
  viewer.classList.remove('webrtc-ready', 'webrtc-error', 'image-ready', 'image-error');
  setCameraViewerRetryVisible(false);
  image.removeAttribute('src');
  image.alt = `Latest snapshot from ${entityName}`;
  const explanation = String(reason || 'A live camera stream is not available.').replace(/\s+/g, ' ').trim();
  setCameraViewerStatus(
    `${explanation} Showing the latest snapshot, refreshed periodically.`,
    explanation,
    'Latest snapshot',
  );
  image.src = cameraImageUrl(entityId);
}

function retryCameraViewerLive() {
  const entityId = app.cameraViewerEntity;
  if (!entityId || $('#cameraViewer').hidden) return;
  startCameraViewerFallback('Refreshing camera snapshot.');
}

function openCameraViewer(entityId) {
  const entity = app.entities.get(entityId);
  if (!entity || entity.domain !== 'camera') return;
  closeExpandedCard(false);
  closePanel();
  closeMobileMenu();
  cleanupCameraViewerWebRtc();
  clearCameraViewerRefresh();
  app.cameraViewerEntity = entityId;
  app.cameraViewerFallbackReason = null;
  const viewer = $('#cameraViewer');
  const image = $('#cameraViewerImage');
  const video = $('#cameraViewerVideo');
  $('#cameraViewerTitle').textContent = entity.name;
  image.alt = `Camera view from ${entity.name}`;
  video.setAttribute('aria-label', `Live video from ${entity.name}`);
  image.removeAttribute('src');
  viewer.hidden = false;
  viewer.setAttribute('aria-hidden', 'false');
  viewer.classList.remove('webrtc-ready', 'webrtc-error', 'image-ready', 'image-error');
  setCameraViewerRetryVisible(false);
  document.body.classList.add('camera-viewer-open');
  startCameraViewerFallback('Native camera streaming is not enabled in OpenEnsemble.');
  $('.camera-viewer-close', viewer)?.focus();
}

function closeCameraViewer() {
  clearCameraViewerRefresh();
  cleanupCameraViewerWebRtc();
  app.cameraViewerEntity = null;
  app.cameraViewerMode = null;
  app.cameraViewerFallbackReason = null;
  const viewer = $('#cameraViewer');
  viewer.hidden = true;
  viewer.setAttribute('aria-hidden', 'true');
  viewer.classList.remove('webrtc-ready', 'webrtc-error', 'image-ready', 'image-error');
  setCameraViewerRetryVisible(false);
  document.body.classList.remove('camera-viewer-open');
  $('#cameraViewerImage').removeAttribute('src');
  setCameraViewerStatus('Connecting to camera…', '', 'Camera viewer');
}

function openPicker() {
  if (!OE_EDITOR_MODE) return;
  if (!app.layout.sections.length) {
    toast('Create a section before adding cards', 'folder-plus');
    openSectionEditor();
    return;
  }
  app.panel = { type: 'picker' };
  app.pickerQuery = '';
  app.pickerSource = 'devices';
  app.pickerDomain = 'all';
  app.pickerScope = app.focusId && app.focusMode === 'rooms'
    ? `room:${app.focusId}`
    : app.focusId && app.focusMode === 'devices'
      ? `device:${app.focusId}`
      : 'all';
  app.pickerMode = 'separate';
  app.pickerGroupTitle = '';
  app.pickerSectionId = app.activeSection === 'all' ? app.layout.sections[0]?.id : app.activeSection;
  app.pickerSelection.clear();
  app.pickerWidgetId = null;
  renderPickerPanel();
  setTimeout(() => $('#entitySearch')?.focus(), 40);
}

function pickerDomains() {
  return ['all', ...new Set([...app.entities.values()].map(entity => entity.domain))];
}

function pickerScopeOptions() {
  const rooms = focusItems('rooms', true).map(item => `<option value="room:${escapeHtml(item.id)}"${app.pickerScope === `room:${item.id}` ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  const devices = focusItems('devices', true).map(item => `<option value="device:${escapeHtml(item.id)}"${app.pickerScope === `device:${item.id}` ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  return `<option value="all"${app.pickerScope === 'all' ? ' selected' : ''}>Every room and device</option>${rooms ? `<optgroup label="Rooms">${rooms}</optgroup>` : ''}${devices ? `<optgroup label="Devices">${devices}</optgroup>` : ''}`;
}

function renderPickerPanel() {
  const widgets = app.pickerSource === 'widgets';
  const count = app.pickerSelection.size;
  const grouped = app.pickerMode === 'group';
  const canAdd = count > 0 && (!grouped || count >= 2);
  const suggestedTitle = groupTitleFor([...app.pickerSelection]);
  const source = `<div class="picker-source" role="group" aria-label="Card source"><button type="button" data-action="picker-source" data-value="devices" class="${widgets ? '' : 'active'}" aria-pressed="${!widgets}">${ico('devices')}<span><strong>Devices</strong><small>Home Assistant controls</small></span></button><button type="button" data-action="picker-source" data-value="widgets" class="${widgets ? 'active' : ''}" aria-pressed="${widgets}">${ico('grid')}<span><strong>Widgets</strong><small>Calendar, email, and skills</small></span></button></div>`;
  if (widgets) {
    const descriptor = widgetDescriptor(app.pickerWidgetId);
    const available = descriptor?.available !== false;
    const body = `${source}<div class="search-wrap">${ico('search')}<input class="search-input" id="widgetSearch" placeholder="Search widgets…" autocomplete="off" value="${escapeHtml(app.pickerQuery)}"></div><div class="entity-list widget-picker-list" id="widgetList"></div>`;
    const foot = `<select class="panel-select" id="pickerSection" aria-label="Destination section" style="max-width:185px;margin-right:auto">${app.layout.sections.map(section => `<option value="${escapeHtml(section.id)}"${section.id === app.pickerSectionId ? ' selected' : ''}>${escapeHtml(section.title)}</option>`).join('')}</select><button class="button ghost" data-action="close-panel">Cancel</button><button class="button primary" data-action="add-widget"${descriptor && available ? '' : ' disabled'}>${ico('plus')}Add widget</button>`;
    panelShell('Add a widget', 'Choose a read-only card for this dashboard', body, foot);
    renderWidgetPickerList();
    $('#widgetSearch')?.addEventListener('input', event => { app.pickerQuery = event.target.value; renderWidgetPickerList(); });
    $('#pickerSection')?.addEventListener('change', event => { app.pickerSectionId = event.target.value; });
    return;
  }
  const mode = `<div class="field picker-mode-field"><span class="field-label">Add as</span><div class="picker-mode" role="group" aria-label="Card type"><button type="button" data-action="picker-mode" data-value="separate" class="${grouped ? '' : 'active'}" aria-pressed="${!grouped}">${ico('grid')}<span><strong>Separate cards</strong><small>One full control per entity</small></span></button><button type="button" data-action="picker-mode" data-value="group" class="${grouped ? 'active' : ''}" aria-pressed="${grouped}">${ico('folder-plus')}<span><strong>Grouped card</strong><small>Compact items in one place</small></span></button></div></div>`;
  const groupName = grouped ? `<label class="field picker-group-name"><span class="field-label">Group card name</span><input id="pickerGroupTitle" maxlength="80" value="${escapeHtml(app.pickerGroupTitle)}" placeholder="${escapeHtml(suggestedTitle)}"><small>Choose at least two items. Existing standalone cards can be moved into this group.</small></label>` : '';
  const body = `${source}<label class="field picker-scope"><span class="field-label">Find entities by room or device</span><select class="panel-select" id="pickerScope">${pickerScopeOptions()}</select></label>${mode}${groupName}<div class="search-wrap">${ico('search')}<input class="search-input" id="entitySearch" placeholder="Search lights, cameras, sensors…" autocomplete="off" value="${escapeHtml(app.pickerQuery)}"></div><div class="filter-row">${pickerDomains().map(domain => `<button class="filter-chip${app.pickerDomain === domain ? ' active' : ''}" data-action="picker-domain" data-value="${escapeHtml(domain)}">${escapeHtml(domain.replaceAll('_', ' '))}</button>`).join('')}</div><div class="entity-list" id="entityList"></div>`;
  const actionLabel = grouped ? `Create group${count ? ` · ${count}` : ''}` : `Add${count ? ` ${count}` : ''}`;
  const foot = `<select class="panel-select" id="pickerSection" aria-label="Destination section" style="max-width:185px;margin-right:auto">${app.layout.sections.map(section => `<option value="${escapeHtml(section.id)}"${section.id === app.pickerSectionId ? ' selected' : ''}>${escapeHtml(section.title)}</option>`).join('')}</select><button class="button ghost" data-action="close-panel">Cancel</button><button class="button primary" data-action="add-selected"${canAdd ? '' : ' disabled'}>${ico(grouped ? 'folder-plus' : 'plus')}${actionLabel}</button>`;
  panelShell(grouped ? 'Create grouped card' : 'Add cards', grouped ? 'Put lights, sensors, or mixed controls in one card' : 'Pin Home Assistant entities to your dashboard', body, foot);
  renderPickerList();
  $('#entitySearch').addEventListener('input', event => { app.pickerQuery = event.target.value; renderPickerList(); });
  $('#pickerScope').addEventListener('change', event => { app.pickerScope = event.target.value; renderPickerList(); });
  $('#pickerSection').addEventListener('change', event => { app.pickerSectionId = event.target.value; });
  $('#pickerGroupTitle')?.addEventListener('input', event => { app.pickerGroupTitle = event.target.value; });
}

function renderWidgetPickerList() {
  const list = $('#widgetList');
  if (!list) return;
  if (!app.widgetCatalogLoaded) {
    list.innerHTML = '<div class="widget-picker-status"><span class="mini-spinner"></span>Loading widgets…</div>';
    return;
  }
  const query = app.pickerQuery.trim().toLowerCase();
  const widgets = app.widgetCatalog.filter(item => !query || `${item.title} ${item.description} ${item.widgetId}`.toLowerCase().includes(query));
  if (!widgets.length) {
    const message = app.widgetCatalogError || (query ? 'No widgets match that search.' : 'No dashboard widgets are available yet.');
    list.innerHTML = `<div class="section-empty" style="min-height:130px">${ico(app.widgetCatalogError ? 'refresh' : 'grid')}${escapeHtml(message)}</div>`;
    return;
  }
  list.innerHTML = widgets.map(item => {
    const selected = item.widgetId === app.pickerWidgetId;
    const unavailable = item.available === false;
    return `<button class="entity-row widget-picker-row${selected ? ' selected' : ''}${unavailable ? ' unavailable' : ''}" data-action="picker-widget" data-id="${escapeHtml(item.widgetId)}"${unavailable ? ' disabled' : ''}><span class="entity-icon">${ico(item.icon)}</span><span class="widget-picker-copy"><span class="entity-name">${escapeHtml(item.title)}</span><span class="entity-id">${escapeHtml(item.description || item.widgetId)}</span>${unavailable && item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ''}</span><span class="entity-row-tail">${unavailable ? '<small>Unavailable</small>' : `<span class="entity-check">${ico('check')}</span>`}</span></button>`;
  }).join('');
}

function renderPickerList() {
  const list = $('#entityList');
  if (!list) return;
  const grouped = app.pickerMode === 'group';
  const query = app.pickerQuery.trim().toLowerCase();
  const scopeMatches = entity => {
    if (app.pickerScope === 'all') return true;
    const [kind, id] = app.pickerScope.split(':');
    const assignment = assignmentFor(entity.entityId);
    if (kind === 'room') return id === UNASSIGNED_ID ? !assignment.areaId : assignment.areaId === id;
    if (kind === 'device') return id === UNASSIGNED_ID ? !assignment.deviceId : assignment.deviceId === id;
    return true;
  };
  const entities = [...app.entities.values()].filter(entity => scopeMatches(entity) && (app.pickerDomain === 'all' || entity.domain === app.pickerDomain) && (!query || `${entity.name} ${entity.entityId} ${entity.domain}`.toLowerCase().includes(query))).sort((a, b) => Number(!!findEntityPlacement(a.entityId)) - Number(!!findEntityPlacement(b.entityId)) || Number(!a.available) - Number(!b.available) || a.name.localeCompare(b.name)).slice(0, 400);
  if (!entities.length) {
    list.innerHTML = `<div class="section-empty" style="min-height:130px">${ico('search')}No matching entities</div>`;
    return;
  }
  list.innerHTML = entities.map(entity => {
    const placement = findEntityPlacement(entity.entityId);
    const movable = grouped && placement && !isGroupCard(placement.card);
    const locked = placement && !movable;
    const selected = app.pickerSelection.has(entity.entityId);
    const note = locked
      ? isGroupCard(placement.card) ? `In ${placement.card.title || groupTitleFor(placement.card.entityIds)}` : 'Already added'
      : movable
        ? `Move from ${placement.section.title}`
        : entity.available ? '' : 'Unavailable';
    return `<button class="entity-row${selected ? ' selected' : ''}${locked ? ' added' : ''}${movable ? ' movable' : ''}${entity.available ? '' : ' unavailable'}" data-action="picker-entity" data-id="${escapeHtml(entity.entityId)}"${locked ? ' disabled' : ''}><span class="entity-icon">${ico(entityIcon(entity))}</span><span style="min-width:0"><span class="entity-name">${escapeHtml(entity.name)}</span><span class="entity-id">${escapeHtml(entity.entityId)}</span></span><span class="entity-row-tail">${note ? `<small>${escapeHtml(note)}</small>` : ''}${locked ? '' : `<span class="entity-check">${ico('check')}</span>`}</span></button>`;
  }).join('');
}

function widgetEditorFields(card, descriptor) {
  const type = widgetType(card);
  if (type === 'calendar') {
    const days = Math.max(1, Math.min(35, Number(card.config?.days) || 7));
    const choices = [
      [1, 'Today'], [3, 'Next 3 days'], [7, 'Next 7 days'], [14, 'Next 14 days'],
    ];
    if (!choices.some(([value]) => value === days)) choices.push([days, `${days} days`]);
    return `<label class="field"><span class="field-label">Agenda range</span><select id="widgetCalendarDays">${choices.sort((a, b) => a[0] - b[0]).map(([value, label]) => `<option value="${value}"${value === days ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select><small class="field-help">The card begins with today in your profile timezone.</small></label>`;
  }
  if (type === 'email') {
    const currentAccount = String(card.config?.accountId || '');
    const accounts = Array.isArray(descriptor?.options?.accounts) ? descriptor.options.accounts : [];
    const connectedIds = accounts.map(account => String(account?.id || '').slice(0, 160)).filter(Boolean);
    const selectedAccount = connectedIds.includes(currentAccount)
      ? currentAccount
      : connectedIds[0] || currentAccount;
    const accountOptions = accounts.map(account => {
      const id = String(account?.id || '').slice(0, 160);
      if (!id) return '';
      const label = String(account?.label || account?.name || id).slice(0, 120);
      const provider = String(account?.provider || '').slice(0, 60);
      return `<option value="${escapeHtml(id)}"${id === selectedAccount ? ' selected' : ''}>${escapeHtml(provider ? `${label} · ${provider}` : label)}</option>`;
    }).join('');
    const missingCurrent = !connectedIds.length && currentAccount
      ? `<option value="${escapeHtml(currentAccount)}" selected>Previously selected account</option>`
      : '';
    const maxItems = Math.max(1, Math.min(20, Number(card.config?.maxItems) || 8));
    const counts = [3, 5, 8, 10, 15];
    if (!counts.includes(maxItems)) counts.push(maxItems);
    return `<label class="field"><span class="field-label">Email account</span><select id="widgetEmailAccount"${accounts.length || currentAccount ? '' : ' disabled'}>${accounts.length ? '' : `<option value="" selected>No account connected</option>`}${missingCurrent}${accountOptions}</select><small class="field-help">Connect or rename accounts in OpenEnsemble email settings.</small></label><label class="field"><span class="field-label">Messages to show</span><select id="widgetEmailMaxItems">${counts.sort((a, b) => a - b).map(value => `<option value="${value}"${value === maxItems ? ' selected' : ''}>${value}</option>`).join('')}</select></label><label class="widget-check"><input type="checkbox" id="widgetEmailShowSnippet"${card.config?.showSnippet === true ? ' checked' : ''}><span><strong>Show message previews</strong><small>Include a short snippet below each subject.</small></span></label>`;
  }
  return `<div class="panel-note widget-editor-note">This skill controls the widget's read-only data. Its layout, name, size, and color stay specific to this dashboard.</div>`;
}

function openWidgetCardEditor(found) {
  if (!OE_EDITOR_MODE || !found || !isWidgetCard(found.card)) return;
  const { card, section } = found;
  const descriptor = widgetDescriptor(card.widgetId);
  app.panel = { type: 'widget-card', id: card.id };
  const fallbackTitle = descriptor?.title || (widgetType(card) === 'calendar' ? 'Calendar' : widgetType(card) === 'email' ? 'Email' : 'Skill widget');
  const unavailable = descriptor?.available === false || (app.widgetCatalogLoaded && !app.widgetCatalogError && !descriptor);
  const body = `<div class="form"><label class="field"><span class="field-label">Display name</span><input id="cardTitle" maxlength="80" value="${escapeHtml(card.title)}" placeholder="${escapeHtml(fallbackTitle)}"></label><label class="field"><span class="field-label">Section</span><select id="cardSection">${app.layout.sections.map(item => `<option value="${escapeHtml(item.id)}"${item.id === section.id ? ' selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select></label>${widgetEditorFields(card, descriptor)}<label class="field"><span class="field-label">Size</span><select id="cardSize">${sizes.map(value => `<option value="${value}"${value === card.size ? ' selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></label><div class="field"><span class="field-label">Accent</span>${accentOptions(card.accent)}</div>${unavailable ? `<div class="panel-note widget-editor-warning">${escapeHtml(descriptor?.reason || 'This widget is no longer available. You can keep its place or remove it.')}</div>` : ''}</div><div class="danger-zone"><button class="button danger" data-action="remove-card" data-id="${escapeHtml(card.id)}">${ico('trash')}Remove widget</button></div>`;
  panelShell('Customize widget', fallbackTitle, body, `<button class="button ghost" data-action="close-panel">Cancel</button><button class="button primary" data-action="save-widget-card" data-id="${escapeHtml(card.id)}">Save widget</button>`);
}

function openCardEditor(cardId) {
  if (!OE_EDITOR_MODE) return;
  const found = findCardById(cardId);
  if (!found) return;
  if (isWidgetCard(found.card)) {
    openWidgetCardEditor(found);
    return;
  }
  if (isGroupCard(found.card)) {
    openGroupCardEditor(found);
    return;
  }
  app.panel = { type: 'card', id: cardId };
  const { card, section } = found;
  const entity = app.entities.get(card.entityId);
  const cardViews = viewOptionsFor(entity);
  if (!cardViews.some(([value]) => value === card.view)) cardViews.push([card.view, card.view[0].toUpperCase() + card.view.slice(1)]);
  const body = `<div class="form"><label class="field"><span class="field-label">Display name</span><input id="cardTitle" maxlength="80" value="${escapeHtml(card.title)}" placeholder="${escapeHtml(entity?.name || 'Device name')}"></label><label class="field"><span class="field-label">Section</span><select id="cardSection">${app.layout.sections.map(item => `<option value="${escapeHtml(item.id)}"${item.id === section.id ? ' selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select></label>${controlStyleField(entity, cardViews, card.view)}<label class="field"><span class="field-label">Size</span><select id="cardSize">${sizes.map(value => `<option value="${value}"${value === card.size ? ' selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></label><div class="field"><span class="field-label">Accent</span>${accentOptions(card.accent)}</div></div><div class="danger-zone"><button class="button danger" data-action="remove-card" data-id="${escapeHtml(card.id)}">${ico('trash')}Remove from dashboard</button></div>`;
  panelShell('Customize card', entity?.name || card.entityId, body, `<button class="button ghost" data-action="close-panel">Cancel</button><button class="button primary" data-action="save-card" data-id="${escapeHtml(card.id)}">Save card</button>`);
}

function openGroupCardEditor(foundOrId) {
  if (!OE_EDITOR_MODE) return;
  const found = typeof foundOrId === 'string' ? findCardById(foundOrId) : foundOrId;
  if (!found || !isGroupCard(found.card)) return;
  const { card, section } = found;
  app.panel = {
    type: 'group-card',
    id: card.id,
    draft: {
      title: card.title || groupTitleFor(card.entityIds),
      sectionId: section.id,
      size: card.size,
      accent: card.accent,
      entityIds: [...card.entityIds],
    },
  };
  renderGroupCardEditor();
}

function syncGroupDraftFromForm() {
  const draft = app.panel?.type === 'group-card' ? app.panel.draft : null;
  if (!draft) return null;
  if ($('#cardTitle')) draft.title = $('#cardTitle').value.trim().slice(0, 80);
  if ($('#cardSection')) draft.sectionId = $('#cardSection').value;
  if ($('#cardSize') && sizes.includes($('#cardSize').value)) draft.size = $('#cardSize').value;
  const accent = $('#accentPicker')?.dataset.value;
  if (accents.includes(accent)) draft.accent = accent;
  return draft;
}

function groupEditorCandidates(cardId, draft) {
  const selected = new Set(draft.entityIds);
  return [...app.entities.values()].filter(entity => {
    if (selected.has(entity.entityId)) return false;
    const placement = findEntityPlacement(entity.entityId);
    return !placement || placement.card.id === cardId || !isGroupCard(placement.card);
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function renderGroupCardEditor() {
  const panel = app.panel;
  const found = panel?.type === 'group-card' ? findCardById(panel.id) : null;
  if (!found) return;
  const draft = panel.draft;
  const entities = draft.entityIds.map(entityForCard);
  const candidates = groupEditorCandidates(found.card.id, draft);
  const itemRows = entities.map((entity, index) => `<div class="group-editor-item"><span class="entity-icon">${ico(entityIcon(entity))}</span><span class="group-editor-copy"><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(groupItemState(entity))}</small></span><span class="group-editor-actions"><button type="button" data-action="move-group-item" data-index="${index}" data-direction="-1" aria-label="Move ${escapeHtml(entity.name)} earlier"${index === 0 ? ' disabled' : ''}>${ico('chevron-up')}</button><button type="button" data-action="move-group-item" data-index="${index}" data-direction="1" aria-label="Move ${escapeHtml(entity.name)} later"${index === entities.length - 1 ? ' disabled' : ''}>${ico('chevron-down')}</button><button type="button" class="group-editor-remove" data-action="remove-group-item" data-index="${index}" aria-label="Remove ${escapeHtml(entity.name)} from group"${entities.length <= 2 ? ' disabled' : ''}>${ico('x')}</button></span></div>`).join('');
  const candidateOptions = candidates.map(entity => {
    const placement = findEntityPlacement(entity.entityId);
    const suffix = placement && !isGroupCard(placement.card) ? ` · move from ${placement.section.title}` : '';
    return `<option value="${escapeHtml(entity.entityId)}">${escapeHtml(entity.name + suffix)}</option>`;
  }).join('');
  const addItems = `<div class="group-editor-add"><select class="panel-select" id="groupAddEntity" aria-label="Add another entity"${candidates.length && entities.length < MAX_ENTITIES_PER_GROUP ? '' : ' disabled'}><option value="">${entities.length >= MAX_ENTITIES_PER_GROUP ? `Maximum ${MAX_ENTITIES_PER_GROUP} items` : candidates.length ? 'Choose another entity…' : 'No available entities'}</option>${candidateOptions}</select><button type="button" class="button ghost" data-action="add-group-item"${candidates.length && entities.length < MAX_ENTITIES_PER_GROUP ? '' : ' disabled'}>${ico('plus')}Add item</button></div>`;
  const body = `<div class="form"><label class="field"><span class="field-label">Group name</span><input id="cardTitle" maxlength="80" value="${escapeHtml(draft.title)}" placeholder="${escapeHtml(groupTitleFor(draft.entityIds))}"></label><label class="field"><span class="field-label">Section</span><select id="cardSection">${app.layout.sections.map(section => `<option value="${escapeHtml(section.id)}"${section.id === draft.sectionId ? ' selected' : ''}>${escapeHtml(section.title)}</option>`).join('')}</select></label><label class="field"><span class="field-label">Size</span><select id="cardSize">${sizes.map(value => `<option value="${value}"${value === draft.size ? ' selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></label><div class="field"><span class="field-label">Accent</span>${accentOptions(draft.accent)}</div><div class="field group-editor-field"><span class="field-label">Items · ${entities.length}</span><p class="style-helper">Each item keeps its own live state and control. Dragging the dashboard moves this whole card.</p><div class="group-editor-list">${itemRows}</div>${addItems}</div></div><div class="danger-zone"><button class="button danger" data-action="remove-card" data-id="${escapeHtml(found.card.id)}">${ico('trash')}Remove grouped card</button></div>`;
  panelShell('Customize grouped card', `${entities.length} Home Assistant entities`, body, `<button class="button ghost" data-action="close-panel">Cancel</button><button class="button primary" data-action="save-group-card" data-id="${escapeHtml(found.card.id)}">Save card</button>`);
}

function openFocusCardEditor(entityId) {
  if (!OE_EDITOR_MODE) return;
  const entity = app.entities.get(entityId);
  if (!entity) return;
  app.panel = { type: 'focus-card', id: entityId };
  const existing = app.layout.focus.cards.find(card => card.entityId === entityId);
  const card = existing || focusCardFor(entity);
  const cardViews = viewOptionsFor(entity);
  if (!cardViews.some(([value]) => value === card.view)) cardViews.push([card.view, card.view[0].toUpperCase() + card.view.slice(1)]);
  const pinned = findEntityPlacement(entityId);
  const pinControl = pinned
    ? `<div class="panel-note">Already pinned to <strong>${escapeHtml(pinned.section.title)}</strong>. Focus styling is kept separate, so the two views can look different.</div>`
    : `<div class="pin-row"><select class="panel-select" id="focusPinSection" aria-label="Dashboard section">${app.layout.sections.map(section => `<option value="${escapeHtml(section.id)}">${escapeHtml(section.title)}</option>`).join('')}</select><button class="button ghost" data-action="pin-focus" data-entity="${escapeHtml(entityId)}">${ico('plus')}Pin to overview</button></div>`;
  const reset = existing ? `<div class="danger-zone"><button class="button danger" data-action="reset-focus-card" data-entity="${escapeHtml(entityId)}">${ico('refresh')}Use automatic style</button></div>` : '';
  const body = `<div class="form"><label class="field"><span class="field-label">Display name</span><input id="cardTitle" maxlength="80" value="${escapeHtml(card.title)}" placeholder="${escapeHtml(entity.name)}"></label>${controlStyleField(entity, cardViews, card.view)}<label class="field"><span class="field-label">Size</span><select id="cardSize">${sizes.map(value => `<option value="${value}"${value === card.size ? ' selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></label><div class="field"><span class="field-label">Accent</span>${accentOptions(card.accent)}</div><div class="field"><span class="field-label">Overview</span>${pinControl}</div></div>${reset}`;
  panelShell('Customize focus card', entity.name, body, `<button class="button ghost" data-action="close-panel">Cancel</button><button class="button primary" data-action="save-focus-card" data-entity="${escapeHtml(entityId)}">Save style</button>`);
}

function openSectionEditor(sectionId = null) {
  if (!OE_EDITOR_MODE) return;
  const section = sectionId ? app.layout.sections.find(item => item.id === sectionId) : null;
  app.panel = { type: 'section', id: sectionId };
  const body = `<div class="form"><label class="field"><span class="field-label">Section name</span><input id="sectionTitle" maxlength="80" value="${escapeHtml(section?.title || '')}" placeholder="Living room"></label><div class="field"><span class="field-label">Accent</span>${accentOptions(section?.accent || 'lime')}</div></div>${section ? `<div class="danger-zone"><button class="button danger" data-action="remove-section" data-id="${escapeHtml(section.id)}">${ico('trash')}Delete section</button></div>` : ''}`;
  panelShell(section ? 'Edit section' : 'Create section', section ? `${section.cards.length} card${section.cards.length === 1 ? '' : 's'}` : 'Make a room, zone, or collection', body, `<button class="button ghost" data-action="close-panel">Cancel</button><button class="button primary" data-action="save-section" data-id="${escapeHtml(sectionId || '')}">${section ? 'Save section' : 'Create section'}</button>`);
  setTimeout(() => $('#sectionTitle')?.focus(), 30);
}

function dashboardChromeToggle(id, title, description, checked, attributes = '') {
  return `<label class="dashboard-chrome-toggle"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}${attributes ? ` ${attributes}` : ''}><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span></label>`;
}

function dashboardColorControl(key, colors, theme = app.theme) {
  const [label, help] = DASHBOARD_COLOR_LABELS[key];
  const base = effectiveDashboardColors(colors, theme)[key];
  const override = colors[key];
  return `<div class="dashboard-color-control${override ? ' is-custom' : ''}" data-dashboard-color-row="${key}">
    <div class="dashboard-color-control-head"><label for="dashboardColor-${key}">${escapeHtml(label)}</label><button type="button" data-action="reset-dashboard-color" data-color-key="${key}"${override ? '' : ' disabled'}>Use theme</button></div>
    <div class="dashboard-color-inputs">
      <input class="dashboard-color-picker" type="color" id="dashboardColorPicker-${key}" value="${escapeHtml(override || base)}" data-dashboard-color-picker data-color-key="${key}" aria-label="Choose ${escapeHtml(label.toLowerCase())}">
      <input class="dashboard-color-hex" type="text" id="dashboardColor-${key}" value="${escapeHtml(override)}" placeholder="${escapeHtml(base)}" maxlength="7" pattern="#[0-9A-Fa-f]{6}" spellcheck="false" autocomplete="off" autocapitalize="none" data-dashboard-color-input data-color-key="${key}" aria-describedby="dashboardColorHelp-${key}">
    </div>
    <small class="dashboard-color-help" id="dashboardColorHelp-${key}">${escapeHtml(help)} <span>${override ? `Custom · ${override}` : `${['greetingText', 'taglineText'].includes(key) ? 'Default' : 'Theme'} · ${base}`}</span></small>
  </div>`;
}

function dashboardColorsFromSettings() {
  const colors = {};
  for (const key of DASHBOARD_COLOR_KEYS) {
    const input = $(`#dashboardColor-${key}`);
    const raw = String(input?.value ?? '').trim().toLowerCase();
    if (!raw) {
      colors[key] = '';
      continue;
    }
    const normalized = normalizeDashboardColor(raw);
    if (!normalized) {
      return {
        ok: false,
        key,
        input,
        message: `${DASHBOARD_COLOR_LABELS[key][0]} must use a six-digit hex color such as #1a2b3c, or be left blank to use the theme.`,
      };
    }
    colors[key] = normalized;
  }
  return { ok: true, colors: cleanDashboardColors(colors) };
}

function updateDashboardColorEditor() {
  const preview = $('#dashboardColorPreview');
  if (!preview) return;
  const theme = dashboardTheme($('#dashboardTheme')?.value || app.theme);
  const base = dashboardThemeColors(theme);
  const draft = {};
  let invalidCount = 0;
  for (const key of DASHBOARD_COLOR_KEYS) {
    const input = $(`#dashboardColor-${key}`);
    const picker = $(`#dashboardColorPicker-${key}`);
    const row = $(`[data-dashboard-color-row="${key}"]`);
    const reset = row?.querySelector('[data-action="reset-dashboard-color"]');
    const help = $(`#dashboardColorHelp-${key} span`);
    const raw = String(input?.value ?? '').trim().toLowerCase();
    const normalized = normalizeDashboardColor(raw);
    const invalid = Boolean(raw && !normalized);
    draft[key] = normalized;
    invalidCount += invalid ? 1 : 0;
    input?.classList.toggle('invalid', invalid);
    input?.setAttribute('aria-invalid', String(invalid));
    row?.classList.toggle('is-custom', Boolean(normalized));
    row?.classList.toggle('is-invalid', invalid);
    const fallback = key === 'greetingText'
      ? draft.text || base.text
      : key === 'taglineText'
        ? draft.mutedText || base.mutedText
        : base[key];
    if (input) input.placeholder = fallback;
    if (picker && (normalized || !raw)) picker.value = normalized || fallback;
    if (reset) reset.disabled = !raw;
    if (help) help.textContent = invalid
      ? 'Enter # followed by six hexadecimal digits.'
      : normalized
        ? `Custom · ${normalized}`
        : `${['greetingText', 'taglineText'].includes(key) ? 'Default' : 'Theme'} · ${fallback}`;
  }

  const effective = effectiveDashboardColors(draft, theme);
  const previewProperties = {
    '--preview-bg': effective.background,
    '--preview-surface': effective.surface,
    '--preview-card': effective.card,
    '--preview-text': effective.text,
    '--preview-muted': effective.mutedText,
    '--preview-accent': effective.accent,
    '--preview-accent-ink': contrastInk(effective.accent),
    '--preview-greeting': effective.greetingText,
    '--preview-tagline': effective.taglineText,
  };
  for (const [property, value] of Object.entries(previewProperties)) {
    preview.style.setProperty(property, value);
  }

  const textChecks = [
    ['Primary text on the dashboard', 'text', 'background', 4.5, ['text', 'background']],
    ['Primary text on navigation and panels', 'text', 'surface', 4.5, ['text', 'surface']],
    ['Primary text on cards', 'text', 'card', 4.5, ['text', 'card']],
    ['Secondary text on the dashboard', 'mutedText', 'background', 4.5, ['mutedText', 'background']],
    ['Secondary text on navigation and panels', 'mutedText', 'surface', 4.5, ['mutedText', 'surface']],
    ['Secondary text on cards', 'mutedText', 'card', 4.5, ['mutedText', 'card']],
    ['Greeting text', 'greetingText', 'background', 3, ['greetingText', 'text', 'background']],
    ['Tagline text', 'taglineText', 'background', 4.5, ['taglineText', 'mutedText', 'background']],
  ];
  const lowText = textChecks.filter(([, foregroundKey, backgroundKey, threshold, affectedKeys]) => (
    affectedKeys.some(key => draft[key])
    && contrastRatio(effective[foregroundKey], effective[backgroundKey]) < threshold
  ));
  const lowAccent = ['background', 'surface', 'card'].some(backgroundKey => (
    (draft.accent || draft[backgroundKey])
    && contrastRatio(effective.accent, effective[backgroundKey]) < 3
  ));
  const warnings = $('#dashboardColorWarnings');
  if (warnings) {
    warnings.classList.toggle('warning', Boolean(invalidCount || lowText.length || lowAccent));
    warnings.classList.toggle('good', !invalidCount && !lowText.length && !lowAccent);
    if (invalidCount) {
      warnings.textContent = `${invalidCount} color ${invalidCount === 1 ? 'value needs' : 'values need'} a valid six-digit hex code.`;
    } else if (lowText.length || lowAccent) {
      const labels = lowText.map(([label]) => label.toLowerCase());
      if (lowAccent) labels.push('the accent');
      warnings.textContent = `Contrast note: ${labels.join(', ')} may be hard to see. You can still save this palette.`;
    } else {
      warnings.textContent = 'The previewed text and accent have strong contrast.';
    }
  }
}

function resetDashboardColor(key) {
  if (!DASHBOARD_COLOR_KEYS.includes(key)) return;
  const input = $(`#dashboardColor-${key}`);
  if (input) input.value = '';
  updateDashboardColorEditor();
}

function resetDashboardColors() {
  for (const key of DASHBOARD_COLOR_KEYS) {
    const input = $(`#dashboardColor-${key}`);
    if (input) input.value = '';
  }
  updateDashboardColorEditor();
}

function dashboardChromeFromSettings() {
  const checked = id => $(`#${id}`)?.checked === true;
  return cleanDashboardChrome({
    showSidebar: checked('dashboardChromeShowSidebar'),
    showTopbar: checked('dashboardChromeShowTopbar'),
    showBrand: checked('dashboardChromeShowBrand'),
    showFocusNav: checked('dashboardChromeShowFocusNav'),
    showSectionNav: checked('dashboardChromeShowSectionNav'),
    showSidebarStatus: checked('dashboardChromeShowSidebarStatus'),
    showHeroStatus: checked('dashboardChromeShowHeroStatus'),
    heroStatusText: String($('#dashboardHeroStatusText')?.value ?? '').trim().slice(0, MAX_DASHBOARD_GREETING_LENGTH),
    greetingMode: $('#dashboardGreetingMode')?.value,
    greetingText: String($('#dashboardGreetingText')?.value ?? '').trim().slice(0, MAX_DASHBOARD_GREETING_LENGTH),
    showTagline: checked('dashboardChromeShowTagline'),
    showClock: checked('dashboardChromeShowClock'),
    showSummary: checked('dashboardChromeShowSummary'),
    showSectionHeaders: checked('dashboardChromeShowSectionHeaders'),
  });
}

function updateDashboardAppearanceControls() {
  const sidebarEnabled = $('#dashboardChromeShowSidebar')?.checked === true;
  const heroStatusEnabled = $('#dashboardChromeShowHeroStatus')?.checked === true;
  const taglineEnabled = $('#dashboardChromeShowTagline')?.checked === true;
  const greetingCustom = $('#dashboardGreetingMode')?.value === 'custom';
  for (const id of [
    'dashboardChromeShowBrand', 'dashboardChromeShowSidebarStatus',
  ]) {
    const input = $(`#${id}`);
    if (input) input.disabled = !sidebarEnabled;
  }
  const statusText = $('#dashboardHeroStatusText');
  if (statusText) statusText.disabled = !heroStatusEnabled;
  const tagline = $('#dashboardTitle');
  if (tagline) tagline.disabled = !taglineEnabled;
  const greetingField = $('#dashboardGreetingTextField');
  if (greetingField) greetingField.hidden = !greetingCustom;
  const greetingText = $('#dashboardGreetingText');
  if (greetingText) greetingText.disabled = !greetingCustom;
}

function openDashboardEditor() {
  if (!OE_EDITOR_MODE) return;
  app.panel = { type: 'dashboard' };
  const dashboard = app.dashboard || { name: 'Home', description: '', theme: app.theme };
  const chrome = cleanDashboardChrome(app.layout.chrome);
  const colors = cleanDashboardColors(app.layout.colors);
  const address = dashboardAddress(app.dashboardSlug);
  const body = `<div class="form dashboard-settings-form">
    <label class="field"><span class="field-label">Dashboard name</span><input id="dashboardName" maxlength="${MAX_DASHBOARD_NAME_LENGTH}" value="${escapeHtml(dashboard.name)}" placeholder="Home"></label>
    <label class="field"><span class="field-label">Description</span><textarea id="dashboardDescription" maxlength="${MAX_DASHBOARD_DESCRIPTION_LENGTH}" rows="3" placeholder="What this dashboard is for">${escapeHtml(dashboard.description)}</textarea></label>
    <div class="field"><span class="field-label">Stable address</span><button class="dashboard-address dashboard-settings-address" data-action="copy-dashboard-address" data-slug="${escapeHtml(app.dashboardSlug)}"><span>${ico('link')}</span><code>${escapeHtml(address)}</code>${ico('copy')}</button><small class="field-help">The address stays the same when you rename this dashboard.</small></div>
    <label class="field"><span class="field-label">Theme</span><select id="dashboardTheme"><option value="midnight"${app.theme === 'midnight' ? ' selected' : ''}>Midnight</option><option value="sand"${app.theme === 'sand' ? ' selected' : ''}>Warm daylight</option></select></label>
    <label class="field"><span class="field-label">Default focus</span><select id="dashboardFocus"><option value="overview"${app.layout.focus.defaultMode === 'overview' ? ' selected' : ''}>Overview</option><option value="rooms"${app.layout.focus.defaultMode === 'rooms' ? ' selected' : ''}>Rooms</option><option value="devices"${app.layout.focus.defaultMode === 'devices' ? ' selected' : ''}>Devices</option></select></label>
    <fieldset class="dashboard-appearance-group dashboard-colors-editor" aria-describedby="dashboardColorWarnings">
      <legend>Colors</legend>
      <div class="dashboard-colors-heading"><div><strong>Make this dashboard yours</strong><small>Each blank value follows the selected base theme. The OE editor stays on that readable base while this preview shows the browser display.</small></div><button class="button ghost dashboard-colors-reset" type="button" data-action="reset-dashboard-colors">${ico('refresh')}Reset all</button></div>
      <div class="dashboard-color-grid">${DASHBOARD_COLOR_KEYS.map(key => dashboardColorControl(key, colors)).join('')}</div>
      <div class="dashboard-color-preview" id="dashboardColorPreview" aria-label="Dashboard color preview">
        <div class="dashboard-color-preview-side"><i></i><span></span><span></span><span></span></div>
        <div class="dashboard-color-preview-main"><small>Live home</small><strong>Good morning.</strong><em>Everything is in its place.</em><div class="dashboard-color-preview-card"><i></i><span><b>Living room</b><small>Comfortable</small></span><button type="button" tabindex="-1">On</button></div></div>
      </div>
      <output class="dashboard-color-warnings" id="dashboardColorWarnings" aria-live="polite"></output>
    </fieldset>
    <section class="dashboard-appearance-editor" aria-labelledby="dashboardAppearanceTitle">
      <div class="dashboard-appearance-intro"><span>${ico('sliders')}</span><div><strong id="dashboardAppearanceTitle">Page elements</strong><small>Choose exactly what this dashboard shows. OE keeps the editing controls available while you configure it.</small></div></div>
      <fieldset class="dashboard-appearance-group">
        <legend>Welcome area</legend>
        <div class="dashboard-chrome-grid">
          ${dashboardChromeToggle('dashboardChromeShowHeroStatus', 'Live source status', 'Show the connection label above the greeting.', chrome.showHeroStatus)}
          ${dashboardChromeToggle('dashboardChromeShowClock', 'Clock & date', 'Show the browser’s local time and date.', chrome.showClock)}
          ${dashboardChromeToggle('dashboardChromeShowSummary', 'Home summary', 'Show lights, climate, security, and availability.', chrome.showSummary)}
          ${dashboardChromeToggle('dashboardChromeShowSectionHeaders', 'Section headings', 'Show section names, counts, and collapse controls.', chrome.showSectionHeaders)}
        </div>
        <label class="field"><span class="field-label">Live status text</span><input id="dashboardHeroStatusText" maxlength="${MAX_DASHBOARD_GREETING_LENGTH}" value="${escapeHtml(chrome.heroStatusText)}" placeholder="Automatic connection status"><small class="field-help">Leave blank to use the live OpenEnsemble or Home Assistant status.</small></label>
        <label class="field"><span class="field-label">Greeting</span><select id="dashboardGreetingMode"><option value="auto"${chrome.greetingMode === 'auto' ? ' selected' : ''}>Automatic for the time of day</option><option value="custom"${chrome.greetingMode === 'custom' ? ' selected' : ''}>Custom message</option><option value="hidden"${chrome.greetingMode === 'hidden' ? ' selected' : ''}>Hidden</option></select></label>
        <label class="field" id="dashboardGreetingTextField"><span class="field-label">Custom greeting</span><input id="dashboardGreetingText" maxlength="${MAX_DASHBOARD_GREETING_LENGTH}" value="${escapeHtml(chrome.greetingText)}" placeholder="Welcome home."></label>
        ${dashboardChromeToggle('dashboardChromeShowTagline', 'Dashboard tagline', 'Show a short line below the greeting.', chrome.showTagline)}
        <label class="field"><span class="field-label">Tagline text</span><input id="dashboardTitle" maxlength="100" value="${escapeHtml(app.layout.title)}" placeholder="Optional"></label>
      </fieldset>
      <fieldset class="dashboard-appearance-group">
        <legend>Navigation & frame</legend>
        <div class="dashboard-chrome-grid">
          ${dashboardChromeToggle('dashboardChromeShowTopbar', 'Top toolbar', 'Show breadcrumbs, refresh, and fullscreen controls.', chrome.showTopbar)}
          ${dashboardChromeToggle('dashboardChromeShowSidebar', 'Sidebar', 'Show the dashboard navigation rail.', chrome.showSidebar)}
          ${dashboardChromeToggle('dashboardChromeShowBrand', 'OpenEnsemble brand', 'Show the brand at the top of the sidebar.', chrome.showBrand)}
          ${dashboardChromeToggle('dashboardChromeShowFocusNav', 'Focus navigation', 'Show Overview, Rooms, and Devices.', chrome.showFocusNav)}
          ${dashboardChromeToggle('dashboardChromeShowSectionNav', 'Section shortcuts', 'Show links to each dashboard section.', chrome.showSectionNav)}
          ${dashboardChromeToggle('dashboardChromeShowSidebarStatus', 'Sidebar status', 'Show connection and permission status at the bottom.', chrome.showSidebarStatus)}
        </div>
      </fieldset>
    </section>
    <div class="panel-note">These choices apply to this dashboard address on every browser. Hidden top and side navigation remain available inside the OE editor.</div>
    <p class="form-error" id="dashboardSettingsError" role="alert"></p>
  </div><div class="danger-zone"><button class="button danger" data-action="reset-focus">${ico('rooms')}Reset room & device organization</button><button class="button danger" data-action="reset-layout" style="margin-left:6px">${ico('refresh')}Reset everything</button></div>`;
  panelShell('Dashboard settings', dashboard.name, body, `<button class="button ghost" data-action="close-panel">Cancel</button><button class="button primary" id="saveDashboardButton" data-action="save-dashboard">Save dashboard</button>`);
  updateDashboardAppearanceControls();
  updateDashboardColorEditor();
}

async function saveDashboardSettings() {
  if (!OE_EDITOR_MODE || app.dashboardMutation || !app.dashboard || !app.layout) return;
  const name = $('#dashboardName')?.value.trim().slice(0, MAX_DASHBOARD_NAME_LENGTH);
  if (!name) return $('#dashboardName')?.focus();
  const description = $('#dashboardDescription')?.value.trim().slice(0, MAX_DASHBOARD_DESCRIPTION_LENGTH) || '';
  const theme = dashboardTheme($('#dashboardTheme')?.value);
  const title = String($('#dashboardTitle')?.value ?? '').trim().slice(0, 100);
  const defaultMode = focusModes.includes($('#dashboardFocus')?.value) ? $('#dashboardFocus').value : 'overview';
  const chrome = dashboardChromeFromSettings();
  const checkedColors = dashboardColorsFromSettings();
  if (!checkedColors.ok) {
    const errorLabel = $('#dashboardSettingsError');
    if (errorLabel) errorLabel.textContent = checkedColors.message;
    checkedColors.input?.focus();
    return false;
  }
  const colors = checkedColors.colors;
  if (chrome.greetingMode === 'custom' && !chrome.greetingText) {
    const errorLabel = $('#dashboardSettingsError');
    if (errorLabel) errorLabel.textContent = 'Enter a custom greeting, or choose Automatic or Hidden.';
    return $('#dashboardGreetingText')?.focus();
  }
  const previous = {
    dashboard: { ...app.dashboard },
    theme: app.theme,
    title: app.layout.title,
    defaultMode: app.layout.focus.defaultMode,
    chrome: { ...app.layout.chrome },
    colors: { ...app.layout.colors },
  };
  const button = $('#saveDashboardButton');
  const errorLabel = $('#dashboardSettingsError');
  app.dashboardMutation = true;
  if (button) { button.disabled = true; button.innerHTML = `${ico('refresh')}Saving…`; }
  if (errorLabel) errorLabel.textContent = '';
  app.dashboard = { ...app.dashboard, name, description, theme };
  app.theme = theme;
  app.layout.title = title;
  app.layout.focus.defaultMode = defaultMode;
  app.layout.chrome = chrome;
  app.layout.colors = colors;
  app.layoutDirty = true;
  app.saveError = null;
  applyTheme();
  renderDashboardIdentity();
  let layoutSaved = false;
  try {
    clearTimeout(app.saveTimer);
    app.saveTimer = null;
    layoutSaved = await saveLayout();
    if (!layoutSaved) throw new Error('The layout could not be saved. Reload before changing dashboard settings.');
    await api(dashboardMetadataApiPath(app.dashboardSlug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, theme }),
    });
    app.dashboardMutation = false;
    closePanel();
    renderAll();
    toast('Dashboard settings saved');
    return true;
  } catch (error) {
    app.dashboard = previous.dashboard;
    app.theme = previous.theme;
    if (!layoutSaved) {
      app.layout.title = previous.title;
      app.layout.focus.defaultMode = previous.defaultMode;
      app.layout.chrome = previous.chrome;
      app.layout.colors = previous.colors;
    }
    app.dashboardMutation = false;
    applyTheme();
    renderAll();
    const message = layoutSaved
      ? `The layout was saved, but the dashboard details were not: ${error.message}`
      : error.message;
    if (errorLabel) errorLabel.textContent = message;
    if (button) { button.disabled = false; button.textContent = 'Save dashboard'; }
    toast(message || 'Dashboard settings were not saved', 'refresh');
    return false;
  }
}

async function toggleDashboardTheme() {
  if (!OE_EDITOR_MODE || app.dashboardMutation || !app.dashboard) return;
  const previous = app.theme;
  const theme = previous === 'sand' ? 'midnight' : 'sand';
  app.theme = theme;
  app.dashboard = { ...app.dashboard, theme };
  app.dashboardMutation = true;
  applyTheme();
  try {
    await api(dashboardMetadataApiPath(app.dashboardSlug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
    const index = app.dashboards.findIndex(item => item.slug === app.dashboardSlug);
    if (index >= 0) app.dashboards[index] = { ...app.dashboards[index], theme };
    app.dashboardMutation = false;
    toast(`${dashboardThemeLabel(theme)} theme applied`);
    return true;
  } catch (error) {
    app.theme = previous;
    app.dashboard = { ...app.dashboard, theme: previous };
    app.dashboardMutation = false;
    applyTheme();
    toast(error.message || 'Theme was not saved', 'refresh');
    return false;
  }
}

function saveFocusCard(entityId) {
  if (!OE_EDITOR_MODE) return;
  const entity = app.entities.get(entityId);
  if (!entity) return;
  const next = {
    entityId,
    title: $('#cardTitle').value.trim().slice(0, 80),
    view: views.includes($('#cardView').value) ? $('#cardView').value : defaultView(entity),
    size: sizes.includes($('#cardSize').value) ? $('#cardSize').value : defaultSize(entity.domain),
    accent: accents.includes($('#accentPicker').dataset.value) ? $('#accentPicker').dataset.value : defaultAccent(entity.domain),
  };
  const index = app.layout.focus.cards.findIndex(card => card.entityId === entityId);
  if (index >= 0) app.layout.focus.cards[index] = next;
  else app.layout.focus.cards.push(next);
  closePanel();
  scheduleSave();
  renderAll();
}

function resetFocusCard(entityId) {
  if (!OE_EDITOR_MODE) return;
  app.layout.focus.cards = app.layout.focus.cards.filter(card => card.entityId !== entityId);
  closePanel();
  scheduleSave();
  renderAll();
  toast('Automatic card style restored');
}

function pinFocusEntity(entityId) {
  if (!OE_EDITOR_MODE) return;
  const entity = app.entities.get(entityId);
  const section = app.layout.sections.find(item => item.id === $('#focusPinSection')?.value) || app.layout.sections[0];
  if (!entity || !section || findEntityPlacement(entityId)) return;
  if (section.cards.length >= MAX_CARDS_PER_SECTION
    || allCards().length >= MAX_CARDS_TOTAL
    || allEntityIds().length >= MAX_ENTITIES_TOTAL) return toast('That dashboard section is full', 'refresh');
  section.cards.push(cardFor(entity));
  scheduleSave();
  openFocusCardEditor(entityId);
  toast(`${entity.name} pinned to ${section.title}`);
}

function moveFocusItem(mode, id, direction) {
  if (!OE_EDITOR_MODE) return;
  const { orderKey } = focusConfig(mode);
  const ids = focusItems(mode, true).map(item => item.id);
  const index = ids.indexOf(id);
  const next = Math.max(0, Math.min(ids.length - 1, index + Number(direction)));
  if (index < 0 || index === next) return;
  [ids[index], ids[next]] = [ids[next], ids[index]];
  app.layout.focus[orderKey] = ids.slice(0, MAX_FOCUS_ENTRIES);
  scheduleSave();
  renderAll();
}

function toggleFocusHidden(mode, id) {
  if (!OE_EDITOR_MODE) return;
  const { hiddenKey } = focusConfig(mode);
  const hidden = new Set(app.layout.focus[hiddenKey]);
  hidden.has(id) ? hidden.delete(id) : hidden.add(id);
  app.layout.focus[hiddenKey] = [...hidden].slice(0, MAX_FOCUS_ENTRIES);
  scheduleSave();
  renderAll();
}

function toast(message, iconName = 'check') {
  const item = document.createElement('div');
  item.className = 'toast';
  item.innerHTML = `${ico(iconName)}<span>${escapeHtml(message)}</span>`;
  $('#toastRegion').appendChild(item);
  setTimeout(() => item.remove(), 3300);
}

function optimisticEntity(entity, command, value) {
  const next = { ...entity, attributes: { ...entity.attributes }, lastChanged: new Date().toISOString() };
  if (command === 'turn_on') next.state = 'on';
  else if (command === 'turn_off') next.state = 'off';
  else if (command === 'lock') next.state = 'locked';
  else if (command === 'unlock') next.state = 'unlocked';
  else if (command === 'open') next.state = 'opening';
  else if (command === 'close') next.state = 'closing';
  else if (command === 'toggle') next.state = entity.state === 'playing' ? 'paused' : entity.state === 'on' ? 'off' : 'on';
  else if (command === 'set_brightness') { next.state = Number(value) > 0 ? 'on' : 'off'; next.attributes.brightness = Math.round(Number(value) / 100 * 255); }
  else if (command === 'set_percentage') { next.state = Number(value) > 0 ? 'on' : 'off'; next.attributes.percentage = Number(value); }
  else if (command === 'set_temperature') next.attributes.temperature = Number(value);
  else if (command === 'set_position') next.attributes.current_position = Number(value);
  else if (command === 'set_volume') next.attributes.volume_level = Number(value) / 100;
  else if (command === 'set_value') next.state = String(Number(value));
  else if (command === 'set_humidity') next.attributes.humidity = Number(value);
  return next;
}

async function controlEntity(entityId, command, value) {
  if (app.status.canControl !== true) {
    toast(app.status.canView === false
      ? 'Home Assistant access is not enabled for this OE profile'
      : 'This OE profile has view-only Home Assistant access', 'lock');
    return;
  }
  const before = app.entities.get(entityId);
  if (!before || !before.available || app.busy.has(entityId)) return;
  if (command === 'unlock' && !confirm(`Unlock ${before.name}?`)) return;
  app.busy.add(entityId);
  app.entities.set(entityId, optimisticEntity(before, command, value));
  renderSummary();
  renderSections();
  try {
    const payload = { dashboardSlug: app.dashboardSlug, entityId, action: command };
    if (value !== undefined) payload.value = Number(value);
    const data = await api('/api/dashboard-runtime/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (data.state) {
      const entity = normalizeEntity(data.state);
      if (entity) app.entities.set(entity.entityId, entity);
    }
    if (['scene', 'script', 'automation'].includes(before.domain) && command === 'turn_on') toast(`${before.name} started`, 'sparkles');
    else if (data.pending) toast('Command sent · waiting for the device', 'clock');
  } catch (error) {
    app.entities.set(entityId, before);
    toast(error.message || 'That device did not respond', 'refresh');
  } finally {
    app.busy.delete(entityId);
    renderSummary();
    renderSections();
  }
}

function saveCard(cardId) {
  if (!OE_EDITOR_MODE) return;
  const found = findCardById(cardId);
  if (!found) return;
  const { card, section } = found;
  card.title = $('#cardTitle').value.trim().slice(0, 80);
  card.view = views.includes($('#cardView').value) ? $('#cardView').value : 'auto';
  card.size = sizes.includes($('#cardSize').value) ? $('#cardSize').value : 'standard';
  const accent = $('#accentPicker').dataset.value;
  if (accents.includes(accent)) card.accent = accent;
  const destination = app.layout.sections.find(item => item.id === $('#cardSection').value);
  if (destination && destination.id !== section.id) {
    section.cards.splice(found.cardIndex, 1);
    destination.cards.push(card);
    app.activeSection = destination.id;
  }
  closePanel();
  scheduleSave();
  renderAll();
}

function saveWidgetCard(cardId) {
  if (!OE_EDITOR_MODE) return;
  const found = findCardById(cardId);
  if (!found || !isWidgetCard(found.card)) return;
  const { card, section } = found;
  const nextTitle = $('#cardTitle')?.value.trim().slice(0, 80) || '';
  const nextSize = sizes.includes($('#cardSize')?.value) ? $('#cardSize').value : 'standard';
  const selectedAccent = $('#accentPicker')?.dataset.value;
  const nextAccent = accents.includes(selectedAccent) ? selectedAccent : card.accent;
  const config = cleanWidgetConfig(card.config);
  const type = widgetType(card);
  if (type === 'calendar') {
    config.days = Math.max(1, Math.min(35, Number($('#widgetCalendarDays')?.value) || 7));
  } else if (type === 'email') {
    const accountId = String($('#widgetEmailAccount')?.value || '').slice(0, 160);
    if (!accountId) {
      toast('Choose a connected email account before saving', 'mail');
      $('#widgetEmailAccount')?.focus();
      return;
    }
    config.accountId = accountId;
    config.maxItems = Math.max(1, Math.min(20, Number($('#widgetEmailMaxItems')?.value) || 8));
    config.showSnippet = $('#widgetEmailShowSnippet')?.checked === true;
  }
  const destination = app.layout.sections.find(item => item.id === $('#cardSection')?.value);
  if (destination && destination.id !== section.id && destination.cards.length >= MAX_CARDS_PER_SECTION) {
    return toast(`${destination.title} has reached its card limit`, 'refresh');
  }
  card.title = nextTitle;
  card.size = nextSize;
  card.accent = nextAccent;
  card.config = config;
  if (destination && destination.id !== section.id) {
    section.cards.splice(found.cardIndex, 1);
    destination.cards.push(card);
    app.activeSection = destination.id;
  }
  app.widgetData.delete(card.id);
  closePanel();
  scheduleSave();
  renderAll();
  void refreshWidgetAfterSave(card.id);
}

function addGroupEditorItem() {
  if (!OE_EDITOR_MODE) return;
  const draft = syncGroupDraftFromForm();
  const entityId = $('#groupAddEntity')?.value;
  if (!draft || !entityId || draft.entityIds.includes(entityId)) return;
  if (draft.entityIds.length >= MAX_ENTITIES_PER_GROUP) return toast(`A grouped card can contain up to ${MAX_ENTITIES_PER_GROUP} items`, 'refresh');
  const placement = findEntityPlacement(entityId);
  if (placement && placement.card.id !== app.panel.id && isGroupCard(placement.card)) {
    return toast('That entity is already inside another grouped card', 'refresh');
  }
  draft.entityIds.push(entityId);
  renderGroupCardEditor();
}

function moveGroupEditorItem(index, direction) {
  if (!OE_EDITOR_MODE) return;
  const draft = syncGroupDraftFromForm();
  if (!draft) return;
  const from = Number(index);
  const to = Math.max(0, Math.min(draft.entityIds.length - 1, from + Number(direction)));
  if (!Number.isInteger(from) || from < 0 || from >= draft.entityIds.length || from === to) return;
  const [entityId] = draft.entityIds.splice(from, 1);
  draft.entityIds.splice(to, 0, entityId);
  renderGroupCardEditor();
}

function removeGroupEditorItem(index) {
  if (!OE_EDITOR_MODE) return;
  const draft = syncGroupDraftFromForm();
  if (!draft || draft.entityIds.length <= 2) return toast('A grouped card needs at least two items', 'refresh');
  const itemIndex = Number(index);
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= draft.entityIds.length) return;
  draft.entityIds.splice(itemIndex, 1);
  renderGroupCardEditor();
}

function saveGroupCard(cardId) {
  if (!OE_EDITOR_MODE) return;
  const found = findCardById(cardId);
  const draft = syncGroupDraftFromForm();
  if (!found || !isGroupCard(found.card) || !draft) return;
  const entityIds = [...new Set(draft.entityIds)].slice(0, MAX_ENTITIES_PER_GROUP);
  if (entityIds.length < 2) return toast('Choose at least two items for this card', 'refresh');
  const destination = app.layout.sections.find(section => section.id === draft.sectionId) || found.section;
  const movableCards = new Map();
  for (const entityId of entityIds) {
    const placement = findEntityPlacement(entityId);
    if (!placement || placement.card.id === cardId) continue;
    if (isGroupCard(placement.card)) return toast(`${app.entities.get(entityId)?.name || entityId} is already in another grouped card`, 'refresh');
    movableCards.set(placement.card.id, placement);
  }
  const removedFromDestination = [...movableCards.values()].filter(placement => placement.section.id === destination.id).length;
  const destinationCount = destination.cards.length - removedFromDestination + (destination.id === found.section.id ? 0 : 1);
  if (destinationCount > MAX_CARDS_PER_SECTION) return toast(`${destination.title} has reached its card limit`, 'refresh');
  const removedEntityIds = new Set([...found.card.entityIds, ...[...movableCards.values()].flatMap(placement => cardEntityIds(placement.card))]);
  const retainedEntityCount = allEntityIds().filter(entityId => !removedEntityIds.has(entityId)).length;
  if (retainedEntityCount + entityIds.length > MAX_ENTITIES_TOTAL) return toast('This dashboard has reached its entity limit', 'refresh');

  const movingCardIds = new Set(movableCards.keys());
  for (const section of app.layout.sections) {
    section.cards = section.cards.filter(card => !movingCardIds.has(card.id));
  }
  found.card.entityIds = entityIds;
  found.card.title = draft.title || groupTitleFor(entityIds);
  found.card.view = 'group';
  found.card.size = sizes.includes(draft.size) ? draft.size : 'wide';
  found.card.accent = accents.includes(draft.accent) ? draft.accent : 'amber';
  if (destination.id !== found.section.id) {
    const currentIndex = found.section.cards.findIndex(card => card.id === cardId);
    if (currentIndex >= 0) found.section.cards.splice(currentIndex, 1);
    destination.cards.push(found.card);
  }
  app.activeSection = destination.id;
  closePanel();
  scheduleSave();
  renderAll();
  toast(`${found.card.title} updated`);
}

function saveSection(sectionId) {
  if (!OE_EDITOR_MODE) return;
  const title = $('#sectionTitle').value.trim().slice(0, 80);
  if (!title) return $('#sectionTitle').focus();
  const accent = $('#accentPicker').dataset.value;
  let section = app.layout.sections.find(item => item.id === sectionId);
  if (section) {
    section.title = title;
    if (accents.includes(accent)) section.accent = accent;
  } else {
    if (app.layout.sections.length >= MAX_SECTIONS) return toast(`A dashboard can have up to ${MAX_SECTIONS} sections`, 'refresh');
    section = { id: uid('space'), title, accent: accents.includes(accent) ? accent : 'lime', collapsed: false, cards: [] };
    app.layout.sections.push(section);
  }
  app.activeSection = section.id;
  closePanel();
  scheduleSave();
  renderAll();
}

function removeCard(cardId) {
  if (!OE_EDITOR_MODE) return;
  const found = findCardById(cardId);
  if (!found) return;
  const name = found.card.title
    || (isWidgetCard(found.card) ? widgetDescriptor(found.card.widgetId)?.title || 'Widget'
      : isGroupCard(found.card) ? groupTitleFor(found.card.entityIds)
        : app.entities.get(found.card.entityId)?.name)
    || 'Card';
  found.section.cards.splice(found.cardIndex, 1);
  app.widgetData.delete(cardId);
  closePanel();
  scheduleSave();
  renderAll();
  toast(`${name} removed from this dashboard`);
}

function removeSection(sectionId) {
  if (!OE_EDITOR_MODE) return;
  const index = app.layout.sections.findIndex(section => section.id === sectionId);
  if (index < 0) return;
  const section = app.layout.sections[index];
  if (section.cards.length && !confirm(`Delete ${section.title} and remove its ${section.cards.length} cards?`)) return;
  app.layout.sections.splice(index, 1);
  app.activeSection = 'all';
  closePanel();
  scheduleSave();
  renderAll();
}

function addSelected() {
  if (!OE_EDITOR_MODE) return;
  const destination = app.layout.sections.find(section => section.id === (app.pickerSectionId || $('#pickerSection')?.value)) || app.layout.sections[0];
  if (!destination || !app.pickerSelection.size) return;
  if (app.pickerMode === 'group') {
    createGroupedSelected(destination);
    return;
  }
  const requested = app.pickerSelection.size;
  const capacity = Math.max(0, Math.min(
    MAX_CARDS_PER_SECTION - destination.cards.length,
    MAX_CARDS_TOTAL - allCards().length,
    MAX_ENTITIES_TOTAL - allEntityIds().length,
  ));
  if (!capacity) return toast(`${destination.title} has reached its device limit`, 'refresh');
  let added = 0;
  for (const entityId of app.pickerSelection) {
    if (added >= capacity) break;
    const entity = app.entities.get(entityId);
    if (!entity || findEntityPlacement(entityId)) continue;
    destination.cards.push(cardFor(entity));
    added++;
  }
  app.activeSection = destination.id;
  closePanel();
  scheduleSave();
  renderAll();
  toast(`${added} device${added === 1 ? '' : 's'} added to ${destination.title}`);
  if (added < requested) toast('Some devices were left unpinned because the dashboard is full', 'refresh');
}

function addWidget() {
  if (!OE_EDITOR_MODE) return;
  const descriptor = widgetDescriptor(app.pickerWidgetId);
  const destination = app.layout.sections.find(section => section.id === (app.pickerSectionId || $('#pickerSection')?.value)) || app.layout.sections[0];
  if (!descriptor || descriptor.available === false || !destination) return;
  if (allCards().filter(isWidgetCard).length >= MAX_WIDGET_CARDS) {
    return toast(`A dashboard can contain up to ${MAX_WIDGET_CARDS} widget cards`, 'refresh');
  }
  if (destination.cards.length >= MAX_CARDS_PER_SECTION || allCards().length >= MAX_CARDS_TOTAL) {
    return toast(`${destination.title} has reached its card limit`, 'refresh');
  }
  const card = widgetCardFor(descriptor);
  destination.cards.push(card);
  app.activeSection = destination.id;
  app.widgetData.set(card.id, { ...widgetState(card), status: 'loading' });
  closePanel();
  scheduleSave();
  renderAll();
  toast(`${descriptor.title} added to ${destination.title}`, 'grid');
  void refreshWidgetAfterSave(card.id);
}

function createGroupedSelected(destination) {
  if (!OE_EDITOR_MODE) return;
  const entityIds = [...new Set(app.pickerSelection)]
    .filter(entityId => app.entities.has(entityId))
    .filter(entityId => {
      const placement = findEntityPlacement(entityId);
      return !placement || !isGroupCard(placement.card);
    })
    .slice(0, MAX_ENTITIES_PER_GROUP);
  if (entityIds.length < 2) return toast('Choose at least two available items for a grouped card', 'refresh');
  const movingCards = new Map();
  for (const entityId of entityIds) {
    const placement = findEntityPlacement(entityId);
    if (placement) movingCards.set(placement.card.id, placement);
  }
  const removedFromDestination = [...movingCards.values()].filter(placement => placement.section.id === destination.id).length;
  const finalDestinationCount = destination.cards.length - removedFromDestination + 1;
  const finalCardCount = allCards().length - movingCards.size + 1;
  if (finalDestinationCount > MAX_CARDS_PER_SECTION || finalCardCount > MAX_CARDS_TOTAL) {
    return toast(`${destination.title} has reached its card limit`, 'refresh');
  }
  const movingEntityIds = new Set([...movingCards.values()].flatMap(placement => cardEntityIds(placement.card)));
  const retainedEntityCount = allEntityIds().filter(entityId => !movingEntityIds.has(entityId)).length;
  if (retainedEntityCount + entityIds.length > MAX_ENTITIES_TOTAL) return toast('This dashboard has reached its entity limit', 'refresh');
  const movingCardIds = new Set(movingCards.keys());
  for (const section of app.layout.sections) {
    section.cards = section.cards.filter(card => !movingCardIds.has(card.id));
  }
  const card = groupCardFor(entityIds, app.pickerGroupTitle);
  destination.cards.push(card);
  app.activeSection = destination.id;
  closePanel();
  scheduleSave();
  renderAll();
  toast(`${card.title} created with ${entityIds.length} items`, 'folder-plus');
}

function moveCard(cardId, direction) {
  if (!OE_EDITOR_MODE) return;
  const found = findCardById(cardId);
  if (!found) return;
  const next = Math.max(0, Math.min(found.section.cards.length - 1, found.cardIndex + Number(direction)));
  if (next === found.cardIndex) return;
  const [card] = found.section.cards.splice(found.cardIndex, 1);
  found.section.cards.splice(next, 0, card);
  scheduleSave();
  renderSections();
}

function moveSection(sectionId, direction) {
  if (!OE_EDITOR_MODE) return;
  const index = app.layout.sections.findIndex(section => section.id === sectionId);
  const next = Math.max(0, Math.min(app.layout.sections.length - 1, index + Number(direction)));
  if (index < 0 || next === index) return;
  const [section] = app.layout.sections.splice(index, 1);
  app.layout.sections.splice(next, 0, section);
  scheduleSave();
  renderAll();
}

function dropCard(cardId, sectionId, targetCardId, after) {
  if (!OE_EDITOR_MODE) return;
  const found = findCardById(cardId);
  const destination = app.layout.sections.find(section => section.id === sectionId);
  if (!found || !destination) return;
  const [card] = found.section.cards.splice(found.cardIndex, 1);
  let index = targetCardId ? destination.cards.findIndex(item => item.id === targetCardId) : destination.cards.length;
  if (index < 0) index = destination.cards.length;
  if (after && index < destination.cards.length) index++;
  destination.cards.splice(index, 0, card);
  scheduleSave();
  renderAll();
}

document.addEventListener('click', event => {
  const dashboardLink = internalDashboardUrl(event.target.closest('a[href]'));
  if (dashboardLink
    && !event.defaultPrevented
    && event.button === 0
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && (app.layoutDirty || app.saveInFlight)) {
    event.preventDefault();
    navigateAfterLayoutFlush(dashboardLink);
    return;
  }
  const target = event.target.closest('[data-action]');
  if (!target) {
    const card = event.target.closest('.device-card[data-card-id]');
    const interactive = event.target.closest('button, input, select, textarea, a, [role="button"], [contenteditable="true"]');
    if (card?.dataset.entity && !interactive && !app.editing && !card.closest('#deviceDialog')) {
      openExpandedCard(card.dataset.entity, card.dataset.cardId);
    }
    return;
  }
  const action = target.dataset.action;
  if (!OE_EDITOR_MODE && OE_EDITOR_ACTIONS.has(action)) {
    event.preventDefault();
    return;
  }
  if (action === 'reload') location.reload();
  else if (action === 'copy-dashboard-address') copyDashboardAddress(target.dataset.slug || app.dashboardSlug);
  else if (action === 'cycle-dashboard') cycleDashboard(target.dataset.direction);
  else if (action === 'open-dashboard-settings') openDashboardEditor();
  else if (action === 'focus-mode') setFocusMode(target.dataset.mode);
  else if (action === 'focus-item') { app.focusId = target.dataset.id; app.focusQuery = ''; app.focusShowAll = false; syncFocusHash(); renderAll(); closeMobileMenu(); }
  else if (action === 'focus-back') { app.focusId = null; app.focusQuery = ''; app.focusShowAll = false; syncFocusHash(); renderAll(); }
  else if (action === 'focus-show-all') { app.focusShowAll = !app.focusShowAll; renderSections(); }
  else if (action === 'filter') {
    app.focusMode = 'overview';
    app.focusId = null;
    app.activeSection = target.dataset.id || 'all';
    if (OE_EDITOR_MODE && app.layout.focus.defaultMode !== 'overview') { app.layout.focus.defaultMode = 'overview'; scheduleSave(); }
    syncFocusHash();
    renderAll(); closeMobileMenu();
  }
  else if (action === 'collapse') { const section = app.layout.sections.find(item => item.id === target.dataset.id); if (section) { section.collapsed = !section.collapsed; if (OE_EDITOR_MODE) scheduleSave(); renderSections(); } }
  else if (action === 'move-card') moveCard(target.dataset.id, target.dataset.direction);
  else if (action === 'move-section') moveSection(target.dataset.id, target.dataset.direction);
  else if (action === 'edit-card') openCardEditor(target.dataset.id);
  else if (action === 'edit-focus-card') openFocusCardEditor(target.dataset.entity);
  else if (action === 'edit-section') openSectionEditor(target.dataset.id);
  else if (action === 'create-empty-section') openSectionEditor();
  else if (action === 'open-device') openExpandedCard(target.dataset.entity, target.dataset.card);
  else if (action === 'open-group-device') openExpandedCard(target.dataset.entity, target.dataset.card);
  else if (action === 'close-device') closeExpandedCard();
  else if (action === 'open-camera') openCameraViewer(target.dataset.entity);
  else if (action === 'retry-camera-live') retryCameraViewerLive();
  else if (action === 'retry-widget') {
    const found = findCardById(target.dataset.id);
    if (found && isWidgetCard(found.card)) void refreshWidgetCard(found.card, { force: true });
  }
  else if (action === 'close-camera') closeCameraViewer();
  else if (action === 'close-panel') closePanel();
  else if (action === 'picker-source') {
    app.pickerSource = target.dataset.value === 'widgets' ? 'widgets' : 'devices';
    app.pickerQuery = '';
    app.pickerSelection.clear();
    app.pickerWidgetId = null;
    renderPickerPanel();
    if (app.pickerSource === 'widgets' && !app.widgetCatalogLoaded) void loadWidgetCatalog();
  }
  else if (action === 'picker-domain') { app.pickerDomain = target.dataset.value; renderPickerPanel(); }
  else if (action === 'picker-mode') {
    app.pickerMode = target.dataset.value === 'group' ? 'group' : 'separate';
    if (app.pickerMode === 'separate') {
      app.pickerSelection = new Set([...app.pickerSelection].filter(entityId => !findEntityPlacement(entityId)));
    }
    renderPickerPanel();
  }
  else if (action === 'picker-entity') {
    const id = target.dataset.id;
    if (app.pickerSelection.has(id)) app.pickerSelection.delete(id);
    else if (app.pickerMode === 'group' && app.pickerSelection.size >= MAX_ENTITIES_PER_GROUP) return toast(`A grouped card can contain up to ${MAX_ENTITIES_PER_GROUP} items`, 'refresh');
    else app.pickerSelection.add(id);
    renderPickerPanel();
  }
  else if (action === 'picker-widget') {
    const descriptor = widgetDescriptor(target.dataset.id);
    if (!descriptor || descriptor.available === false) return;
    app.pickerWidgetId = descriptor.widgetId;
    renderPickerPanel();
  }
  else if (action === 'add-selected') addSelected();
  else if (action === 'add-widget') addWidget();
  else if (action === 'add-group-item') addGroupEditorItem();
  else if (action === 'move-group-item') moveGroupEditorItem(target.dataset.index, target.dataset.direction);
  else if (action === 'remove-group-item') removeGroupEditorItem(target.dataset.index);
  else if (action === 'card-view-choice') {
    const input = $('#cardView');
    const picker = $('#cardViewPicker');
    if (input && picker && views.includes(target.dataset.value)) {
      input.value = target.dataset.value;
      picker.dataset.value = target.dataset.value;
      $$('.view-choice', picker).forEach(button => {
        const selected = button === target;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    }
  }
  else if (action === 'accent') { const row = $('#accentPicker'); if (row) { row.dataset.value = target.dataset.value; $$('.accent-option', row).forEach(button => button.classList.toggle('active', button === target)); } }
  else if (action === 'save-card') saveCard(target.dataset.id);
  else if (action === 'save-group-card') saveGroupCard(target.dataset.id);
  else if (action === 'save-widget-card') saveWidgetCard(target.dataset.id);
  else if (action === 'save-focus-card') saveFocusCard(target.dataset.entity);
  else if (action === 'reset-focus-card') resetFocusCard(target.dataset.entity);
  else if (action === 'pin-focus') pinFocusEntity(target.dataset.entity);
  else if (action === 'move-focus') moveFocusItem(target.dataset.mode, target.dataset.id, target.dataset.direction);
  else if (action === 'toggle-focus-hidden') toggleFocusHidden(target.dataset.mode, target.dataset.id);
  else if (action === 'save-section') saveSection(target.dataset.id || null);
  else if (action === 'remove-card') removeCard(target.dataset.id);
  else if (action === 'remove-section') removeSection(target.dataset.id);
  else if (action === 'reset-dashboard-color') resetDashboardColor(target.dataset.colorKey);
  else if (action === 'reset-dashboard-colors') resetDashboardColors();
  else if (action === 'save-dashboard') trackDashboardMutation(saveDashboardSettings());
  else if (action === 'reset-focus') {
    const defaultMode = app.layout.focus.defaultMode;
    app.layout.focus = emptyFocus(defaultMode);
    closePanel(); scheduleSave(); renderAll(); toast('Room and device organization reset', 'refresh');
  } else if (action === 'reset-layout') {
    if (!confirm('Reset to a fresh automatic layout? Your actual Home Assistant devices will not be changed.')) return;
    app.layout = buildDefaultLayout(); app.focusMode = 'overview'; app.focusId = null; app.activeSection = 'all'; closePanel(); scheduleSave(); renderAll(); toast('Dashboard reset', 'refresh');
  } else if (action === 'control') {
    const value = target.dataset.value === undefined ? undefined : Number(target.dataset.value);
    controlEntity(target.dataset.entity, target.dataset.command, value);
  } else if (action === 'step-temp') {
    const entity = app.entities.get(target.dataset.entity);
    const current = Number(entity?.attributes.temperature ?? entity?.attributes.current_temperature);
    if (Number.isFinite(current)) controlEntity(entity.entityId, 'set_temperature', Math.round((current + Number(target.dataset.delta)) * 10) / 10);
  } else if (action === 'range-step') {
    const entity = app.entities.get(target.dataset.entity);
    const spec = rangeSpecFor(entity);
    if (spec) {
      const raw = spec.value + Number(target.dataset.delta);
      const snapped = Math.round((raw - spec.min) / spec.step) * spec.step + spec.min;
      const next = Math.max(spec.min, Math.min(spec.max, Number(snapped.toFixed(spec.precision))));
      controlEntity(entity.entityId, spec.command, next);
    }
  }
});

document.addEventListener('input', event => {
  if (event.target.matches?.('[data-dashboard-color-picker]')) {
    const key = event.target.dataset.colorKey;
    const input = DASHBOARD_COLOR_KEYS.includes(key) ? $(`#dashboardColor-${key}`) : null;
    if (input) input.value = normalizeDashboardColor(event.target.value);
    updateDashboardColorEditor();
    return;
  }
  if (event.target.matches?.('[data-dashboard-color-input]')) {
    updateDashboardColorEditor();
    return;
  }
  if (event.target.id === 'focusSearch') {
    app.focusQuery = event.target.value;
    if (app.focusId) renderFocusResults();
    else renderFocusGrid();
    return;
  }
  if (!event.target.classList.contains('range')) return;
  const input = event.target;
  const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value);
  const percent = max > min ? (value - min) / (max - min) * 100 : 0;
  input.style.setProperty('--value', `${percent}%`);
  const precision = Number(input.dataset.precision || 0);
  const shown = precision > 0 ? String(Number(value.toFixed(precision))) : Math.round(value);
  const formatted = `${shown}${input.dataset.unit ?? '%'}`;
  const controls = input.closest('.card-controls');
  controls?.querySelector('.radial-control')?.style.setProperty('--level', `${percent}%`);
  const rangeLabel = input.parentElement.querySelector('.range-value');
  if (rangeLabel) rangeLabel.textContent = formatted;
  controls?.querySelectorAll('[data-range-output]').forEach(label => { label.textContent = formatted; });
  const segmented = input.closest('.segment-slider');
  if (segmented) {
    segmented.style.setProperty('--value', `${percent}%`);
    const marks = $$('.segment-marks i', segmented);
    const active = Math.round(percent / 100 * Math.max(0, marks.length - 1));
    marks.forEach((mark, index) => mark.classList.toggle('active', index <= active));
  }
});

document.addEventListener('change', event => {
  if (event.target.matches?.('[data-dashboard-color-input]')) {
    const normalized = normalizeDashboardColor(event.target.value);
    if (normalized) event.target.value = normalized;
    updateDashboardColorEditor();
    return;
  }
  if (event.target.matches?.('[data-dashboard-color-picker]')) {
    updateDashboardColorEditor();
    return;
  }
  if (event.target.id === 'dashboardTheme') {
    updateDashboardColorEditor();
    return;
  }
  if (event.target.closest?.('.dashboard-appearance-editor')) {
    updateDashboardAppearanceControls();
    return;
  }
  if (!event.target.classList.contains('range')) return;
  controlEntity(event.target.dataset.entity, event.target.dataset.command, Number(event.target.value));
});

document.addEventListener('load', event => {
  if (!event.target.matches?.('img.camera-image, #cameraViewerImage')) return;
  event.target.closest('.camera-preview')?.classList.add('image-ready');
  if (event.target.id === 'cameraViewerImage') {
    if ($('#cameraViewer').hidden || !['stream', 'snapshot'].includes(app.cameraViewerMode)) return;
    $('#cameraViewer').classList.add('image-ready');
    $('#cameraViewer').classList.remove('image-error');
    if (app.cameraViewerMode === 'snapshot') {
      const reason = app.cameraViewerFallbackReason
        ? `${app.cameraViewerFallbackReason} `
        : '';
      setCameraViewerStatus(
        `${reason}Latest snapshot refreshes periodically.`,
        app.cameraViewerFallbackReason || '',
        'Latest snapshot',
      );
      scheduleCameraViewerRefresh();
    } else if (app.cameraViewerMode === 'stream') {
      const reason = app.cameraViewerFallbackReason
        ? `${app.cameraViewerFallbackReason} `
        : '';
      setCameraViewerStatus(
        `${reason}Compatibility camera view may be delayed.`,
        app.cameraViewerFallbackReason || '',
        'Compatibility camera view',
      );
    }
  }
}, true);

document.addEventListener('error', event => {
  if (!event.target.matches?.('img.camera-image, #cameraViewerImage')) return;
  event.target.closest('.camera-preview')?.classList.add('image-error');
  if (event.target.id === 'cameraViewerImage') {
    if ($('#cameraViewer').hidden || !['stream', 'snapshot'].includes(app.cameraViewerMode)) return;
    $('#cameraViewer').classList.add('image-error');
    $('#cameraViewer').classList.remove('image-ready');
    if (app.cameraViewerMode === 'stream' && app.cameraViewerEntity && !$('#cameraViewer').hidden) {
      app.cameraViewerMode = 'snapshot';
      const entityName = app.entities.get(app.cameraViewerEntity)?.name || 'camera';
      $('#cameraViewerImage').alt = `Latest snapshot from ${entityName}`;
      const reason = app.cameraViewerFallbackReason
        ? ` ${app.cameraViewerFallbackReason}`
        : '';
      setCameraViewerStatus(
        `Compatibility stream unavailable. Loading the latest snapshot…${reason}`,
        app.cameraViewerFallbackReason || '',
        'Latest snapshot',
      );
      refreshCameraViewer();
    } else if (app.cameraViewerMode === 'snapshot') {
      const reason = app.cameraViewerFallbackReason
        ? ` ${app.cameraViewerFallbackReason}`
        : '';
      setCameraViewerStatus(
        `Latest snapshot unavailable. Retrying…${reason}`,
        app.cameraViewerFallbackReason || '',
        'Latest snapshot',
      );
      scheduleCameraViewerRefresh(CAMERA_VIEWER_RETRY_MS);
    }
  }
}, true);

document.addEventListener('dragstart', event => {
  const card = event.target.closest('[data-card-id]');
  if (!card || !app.editing) return;
  app.dragCardId = card.dataset.cardId;
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', app.dragCardId);
});

document.addEventListener('dragover', event => {
  if (!app.dragCardId || !app.editing) return;
  const section = event.target.closest('[data-section-id]');
  if (!section) return;
  event.preventDefault();
  $$('.drag-over, .drop-target').forEach(item => item.classList.remove('drag-over', 'drop-target'));
  section.classList.add('drag-over');
  event.target.closest('[data-card-id]')?.classList.add('drop-target');
});

document.addEventListener('drop', event => {
  if (!app.dragCardId || !app.editing) return;
  const section = event.target.closest('[data-section-id]');
  if (!section) return;
  event.preventDefault();
  const target = event.target.closest('[data-card-id]');
  const rect = target?.getBoundingClientRect();
  const after = rect ? event.clientX > rect.left + rect.width / 2 : false;
  const dragged = app.dragCardId;
  app.dragCardId = null;
  if (target?.dataset.cardId !== dragged) dropCard(dragged, section.dataset.sectionId, target?.dataset.cardId || null, after);
  $$('.drag-over, .drop-target, .dragging').forEach(item => item.classList.remove('drag-over', 'drop-target', 'dragging'));
});

document.addEventListener('dragend', () => {
  app.dragCardId = null;
  $$('.drag-over, .drop-target, .dragging').forEach(item => item.classList.remove('drag-over', 'drop-target', 'dragging'));
});

$('.main').addEventListener('touchstart', startDashboardSwipe, { passive: true });
$('.main').addEventListener('touchmove', moveDashboardSwipe, { passive: false });
$('.main').addEventListener('touchend', finishDashboardSwipe, { passive: false });
$('.main').addEventListener('touchcancel', cancelDashboardSwipe, { passive: true });
document.addEventListener('click', event => {
  if (Date.now() >= dashboardSwipeSuppressClickUntil) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeExpandedCard(); closeCameraViewer(); closePanel(); closeMobileMenu(); }
  const typing = event.target.matches?.('input, select, textarea, [contenteditable="true"]');
  const editingCard = app.editing && event.target.matches?.('[data-card-id][data-action]') ? event.target : null;
  if (!typing && editingCard && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    if (editingCard.dataset.action === 'edit-focus-card') openFocusCardEditor(editingCard.dataset.entity);
    else openCardEditor(editingCard.dataset.id);
    return;
  }
  if (!typing && event.key.toLowerCase() === 'f' && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    setFullscreenMode(!app.fullscreen);
    return;
  }
  if (!app.editing || !event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const card = event.target.closest('[data-card-id]');
  if (!card) return;
  event.preventDefault();
  moveCard(card.dataset.cardId, ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
});

function closeMobileMenu() {
  $('#sidebar').classList.remove('open');
  $('#menuButton').setAttribute('aria-expanded', 'false');
  $('#floatingMenuButton').setAttribute('aria-expanded', 'false');
  syncDrawerBackdrop();
}

function toggleMobileMenu() {
  $('#sidebar').classList.toggle('open');
  const open = $('#sidebar').classList.contains('open');
  $('#menuButton').setAttribute('aria-expanded', String(open));
  $('#floatingMenuButton').setAttribute('aria-expanded', String(open));
  syncDrawerBackdrop();
}

$('#menuButton').addEventListener('click', toggleMobileMenu);
$('#floatingMenuButton').addEventListener('click', toggleMobileMenu);
$('#drawerBackdrop').addEventListener('click', () => { closePanel(); closeMobileMenu(); });
$('#deviceDialog').addEventListener('cancel', event => {
  event.preventDefault();
  closeExpandedCard();
});
$('#deviceDialog').addEventListener('click', event => {
  if (event.target === $('#deviceDialog')) closeExpandedCard();
});
$('#themeButton').addEventListener('click', () => trackDashboardMutation(toggleDashboardTheme()));
$('#fullscreenButton').addEventListener('click', () => setFullscreenMode(true));
$('#fullscreenExit').addEventListener('click', () => setFullscreenMode(false));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && app.fullscreen) {
    app.fullscreen = false;
    localStorage.setItem(OE_FULLSCREEN_KEY, '0');
    clearFullscreenQuery();
    applyFullscreenMode();
  }
});
$('#refreshButton').addEventListener('click', () => refreshDashboard(true));
$('#customizeButton').addEventListener('click', () => {
  if (!OE_EDITOR_MODE) return;
  closeExpandedCard(false);
  app.editing = !app.editing;
  closePanel();
  renderAll();
  if (!app.editing) scheduleSave(0);
  else toast(app.focusMode === 'overview' ? 'Tap any card to change its content, size, or color' : 'Open a room or device, then tap any card to restyle it', 'sliders');
});
$('#addDeviceButton').addEventListener('click', () => { if (OE_EDITOR_MODE) openPicker(); });
$('#addSectionButton').addEventListener('click', () => { if (OE_EDITOR_MODE) openSectionEditor(); });
$('#dashboardStyleButton').addEventListener('click', () => { if (OE_EDITOR_MODE) openDashboardEditor(); });
$('#cameraViewerVideo').addEventListener('loadeddata', () => markCameraWebRtcReady(app.cameraViewerWebRtc));
$('#cameraViewerVideo').addEventListener('playing', () => markCameraWebRtcReady(app.cameraViewerWebRtc));
window.addEventListener('pagehide', () => { cancelDashboardSwipe(); closeCameraViewer(); });
window.addEventListener('blur', cancelDashboardSwipe);
window.addEventListener('resize', cancelDashboardSwipe);
window.addEventListener('beforeunload', event => {
  if (!app.layoutDirty
      && !app.saveInFlight
      && !app.dashboardMutation
      && !app.dashboardMutationPromise) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('hashchange', closeCameraViewer);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshWidgets();
});
matchMedia('(min-width: 961px)').addEventListener('change', event => { if (event.matches) closeMobileMenu(); });

updateClock();
setInterval(updateClock, 30000);
applyFullscreenMode();
loadApp();
