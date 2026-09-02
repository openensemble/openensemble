// ── Display dashboards studio ───────────────────────────────────────────────────────────────────────
// Management lives in OE's authenticated Dashboard drawer. The browser
// display itself remains a separate, view-only page at /dashboards/:slug.

let _oeDisplayDashboards = [];
let _oeDisplayDefaultSlug = 'home';
let _oeDisplayStudioMode = 'library';
let _oeDisplayCreateSource = '';
let _oeDisplayCreateDuplicate = false;
let _oeDisplayMutation = false;
let _oeDisplaySlugTouched = false;
let _oeDisplayThemeTouched = false;
let _oeDisplayLoadGeneration = 0;

const OE_DISPLAY_THEMES = {
  midnight: 'Midnight',
  sand: 'Warm daylight',
};

const OE_DISPLAY_DEFAULT_CHROME = Object.freeze({
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

const OE_DISPLAY_COLOR_KEYS = Object.freeze([
  'background', 'surface', 'card', 'text', 'mutedText', 'accent',
  'greetingText', 'taglineText',
]);
const OE_DISPLAY_DEFAULT_COLORS = Object.freeze(Object.fromEntries(
  OE_DISPLAY_COLOR_KEYS.map(key => [key, '']),
));

function oeDisplayColors(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(OE_DISPLAY_COLOR_KEYS.map(key => {
    const value = typeof source[key] === 'string' ? source[key].trim().toLowerCase() : '';
    return [key, /^#[0-9a-f]{6}$/.test(value) ? value : OE_DISPLAY_DEFAULT_COLORS[key]];
  }));
}

function oeDisplayChrome(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = key => typeof source[key] === 'boolean'
    ? source[key]
    : OE_DISPLAY_DEFAULT_CHROME[key];
  return {
    showSidebar: bool('showSidebar'),
    showTopbar: bool('showTopbar'),
    showBrand: bool('showBrand'),
    showFocusNav: bool('showFocusNav'),
    showSectionNav: bool('showSectionNav'),
    showSidebarStatus: bool('showSidebarStatus'),
    showHeroStatus: bool('showHeroStatus'),
    heroStatusText: typeof source.heroStatusText === 'string' ? source.heroStatusText.slice(0, 100) : '',
    greetingMode: ['auto', 'custom', 'hidden'].includes(source.greetingMode) ? source.greetingMode : 'auto',
    greetingText: typeof source.greetingText === 'string' ? source.greetingText.slice(0, 100) : '',
    showTagline: bool('showTagline'),
    showClock: bool('showClock'),
    showSummary: bool('showSummary'),
    showSectionHeaders: bool('showSectionHeaders'),
  };
}

function oeDisplayArgs(values) {
  return JSON.stringify(values).replace(/'/g, '&#39;');
}

function oeDisplayUid(prefix) {
  const token = globalThis.crypto?.randomUUID?.().slice(0, 8)
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return `${prefix}-${token}`;
}

function oeDisplaySafeSlug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function oeDisplayTheme(value) {
  return value === 'sand' ? 'sand' : 'midnight';
}

function oeDisplayPath(slug) {
  return `/dashboards/${encodeURIComponent(slug)}`;
}

function oeDisplayAddress(slug) {
  return new URL(oeDisplayPath(slug), location.origin).toString();
}

function oeDisplayNormalizeSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const slug = String(raw.slug || '');
  if (!slug || oeDisplaySafeSlug(slug) !== slug) return null;
  return {
    slug,
    name: String(raw.name || slug).slice(0, 100),
    owner: String(raw.owner || '').slice(0, 100),
    description: String(raw.description || '').slice(0, 500),
    theme: oeDisplayTheme(raw.theme),
    url: oeDisplayPath(slug),
    isDefault: raw.isDefault === true,
    sectionCount: Math.max(0, Number(raw.sectionCount) || 0),
    cardCount: Math.max(0, Number(raw.cardCount) || 0),
  };
}

async function oeDisplayApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => '');
    data = text ? { error: text } : null;
  }
  if (!response.ok) {
    throw new Error(data?.error || `Dashboard request failed (${response.status}).`);
  }
  return data;
}

async function oeDisplayLoadCatalog() {
  const data = await oeDisplayApi('/api/dashboards', { cache: 'no-store' });
  _oeDisplayDashboards = (Array.isArray(data?.dashboards) ? data.dashboards : [])
    .map(oeDisplayNormalizeSummary)
    .filter(Boolean);
  const requestedDefault = oeDisplaySafeSlug(data?.defaultSlug);
  _oeDisplayDefaultSlug = _oeDisplayDashboards.some(item => item.slug === requestedDefault)
    ? requestedDefault
    : _oeDisplayDashboards.find(item => item.isDefault)?.slug || 'home';
}

function oeDisplayStudioPanel() {
  return $('dashboardDisplayStudioBody');
}

function oeDisplayOperationIsCurrent(panel, generation, mode) {
  return generation === _oeDisplayLoadGeneration
    && Boolean(panel?.isConnected)
    && oeDisplayStudioPanel() === panel
    && _oeDisplayStudioMode === mode;
}

async function oeDisplayFlushEditor() {
  const frame = document.querySelector('.dash-display-editor-frame');
  if (!frame?.contentWindow) return true;
  try {
    const flush = frame.contentWindow.oeDashboardFlushPendingLayout;
    if (typeof flush !== 'function') return true;
    const saved = await flush.call(frame.contentWindow);
    if (saved) return true;
    oeDisplaySetNotice('Changes could not be saved. Resolve the error in the editor before leaving.', 'error');
    return false;
  } catch {
    oeDisplaySetNotice('Changes could not be saved. Try again before leaving the editor.', 'error');
    return false;
  }
}

function oeDisplaySetNotice(message, tone = '') {
  const notice = $('dashboardDisplayNotice');
  if (!notice) return;
  notice.textContent = message || '';
  notice.className = `dash-display-notice${tone ? ` ${tone}` : ''}`;
}

function openDashboardDisplays(mode = 'library', sourceSlug = '', duplicate = false) {
  if (typeof mode !== 'string') mode = 'library';
  if (typeof sourceSlug !== 'string') sourceSlug = '';
  _oeDisplayStudioMode = ['create', 'configure'].includes(mode) ? mode : 'library';
  _oeDisplayCreateSource = oeDisplaySafeSlug(sourceSlug);
  _oeDisplayCreateDuplicate = duplicate === true;
  if (_oeDisplayStudioMode === 'create') {
    _oeDisplaySlugTouched = false;
    _oeDisplayThemeTouched = false;
  }
  const body = $('dashBody');
  if (!body) return;
  body.classList.add('dashboard-tool-open');
  body.innerHTML = `
    <div class="dash-tool-shell dash-display-shell">
      <div class="dash-tool-head">
        <button class="dash-tool-back" data-action="loadDashboard">${icon('arrow-left', 14)} Back</button>
        <div class="dash-tool-title">${icon('monitor-smartphone', 18)} Display dashboards</div>
        <div class="dash-display-head-actions">
          <span class="dash-display-notice" id="dashboardDisplayNotice" role="status" aria-live="polite"></span>
          <button class="dash-display-primary" data-action="openDashboardDisplayCreate">${icon('plus', 14)} New dashboard</button>
        </div>
      </div>
      <div class="dash-tool-panel dash-display-studio" id="dashboardDisplayStudioBody">
        <div class="dash-display-loading"><span class="dash-display-spinner"></span>Loading dashboards…</div>
      </div>
    </div>`;
  loadDashboardDisplayStudio();
  if (window.lucide) lucide.createIcons();
}

async function loadDashboardDisplayStudio() {
  const panel = oeDisplayStudioPanel();
  if (!panel) return;
  const generation = ++_oeDisplayLoadGeneration;
  panel.innerHTML = '<div class="dash-display-loading"><span class="dash-display-spinner"></span>Loading dashboards…</div>';
  try {
    await oeDisplayLoadCatalog();
    if (generation !== _oeDisplayLoadGeneration
        || !panel.isConnected
        || oeDisplayStudioPanel() !== panel) return;
    if (_oeDisplayStudioMode === 'create') {
      renderDashboardDisplayCreate(_oeDisplayCreateSource, _oeDisplayCreateDuplicate);
    } else if (_oeDisplayStudioMode === 'configure') {
      if (_oeDisplayDashboards.some(item => item.slug === _oeDisplayCreateSource)) {
        dashboardDisplayConfigure(_oeDisplayCreateSource);
      } else {
        renderDashboardDisplayLibrary();
        oeDisplaySetNotice('That dashboard is no longer available.', 'error');
      }
    } else {
      renderDashboardDisplayLibrary();
    }
  } catch (error) {
    if (generation !== _oeDisplayLoadGeneration
        || !panel.isConnected
        || oeDisplayStudioPanel() !== panel) return;
    panel.innerHTML = `
      <div class="dash-display-empty error">
        <span class="dash-display-empty-icon">${icon('triangle-alert', 28)}</span>
        <h3>Dashboard studio is unavailable</h3>
        <p>${escHtml(error.message)}</p>
        <button class="dash-display-secondary" data-action="loadDashboardDisplayStudio">Try again</button>
      </div>`;
    if (window.lucide) lucide.createIcons();
  }
}

function oeDisplayLibraryCard(dashboard) {
  const args = oeDisplayArgs([dashboard.slug]);
  const permanent = dashboard.slug === 'home' || dashboard.isDefault;
  const address = oeDisplayAddress(dashboard.slug);
  const owner = dashboard.owner || _currentUser?.name || 'Your profile';
  const deleteAction = permanent
    ? `<button class="dash-display-danger" type="button" disabled title="Home is required. To start over, use Customize → Dashboard settings → Reset everything.">${icon('lock-keyhole', 14)} Home is required</button>`
    : `<button class="dash-display-danger" type="button" data-action="dashboardDisplayDelete" data-args='${args}'>${icon('trash-2', 14)} Delete</button>`;
  return `
    <article class="dash-display-card${permanent ? ' is-home' : ''}">
      <div class="dash-display-card-top">
        <span class="dash-display-theme-swatch ${dashboard.theme}" aria-hidden="true"></span>
        <div class="dash-display-card-identity">
          <div class="dash-display-card-title-row">
            <h3>${escHtml(dashboard.name)}</h3>
            ${permanent ? '<span class="dash-display-pill" title="Home is the required default dashboard">Home</span>' : ''}
          </div>
          <p>${escHtml(dashboard.description || 'A dedicated display for this home.')}</p>
        </div>
        <button class="dash-display-icon-btn" data-action="dashboardDisplayCopyAddress" data-args='${args}' title="Copy address" aria-label="Copy ${escHtml(dashboard.name)} address">${icon('copy', 15)}</button>
      </div>
      <div class="dash-display-address" title="${escHtml(address)}">${icon('link', 13)}<span>${escHtml(address)}</span></div>
      <div class="dash-display-card-meta">
        <span>${icon('user-round', 13)}${escHtml(owner)}</span>
        <span>${icon('layout-grid', 13)}${dashboard.sectionCount} section${dashboard.sectionCount === 1 ? '' : 's'}</span>
        <span>${icon('panels-top-left', 13)}${dashboard.cardCount} card${dashboard.cardCount === 1 ? '' : 's'}</span>
        <span>${icon(dashboard.theme === 'sand' ? 'sun' : 'moon', 13)}${escHtml(OE_DISPLAY_THEMES[dashboard.theme])}</span>
      </div>
      <div class="dash-display-card-actions">
        <button class="dash-display-primary" data-action="dashboardDisplayConfigure" data-args='${args}'>${icon('sliders-horizontal', 14)} Configure</button>
        <a class="dash-display-secondary" href="${escHtml(dashboard.url)}" target="_blank" rel="noopener">${icon('external-link', 14)} Open display</a>
        <button class="dash-display-secondary" data-action="dashboardDisplayDuplicate" data-args='${args}'>${icon('copy-plus', 14)} Duplicate</button>
        ${deleteAction}
      </div>
    </article>`;
}

function renderDashboardDisplayLibrary() {
  _oeDisplayStudioMode = 'library';
  const panel = oeDisplayStudioPanel();
  if (!panel) return;
  panel.classList.remove('configuring');
  const profile = _currentUser?.name || 'your profile';
  panel.innerHTML = `
    <div class="dash-display-library">
      <div class="dash-display-hero">
        <div>
          <span class="dash-display-eyebrow">Browser displays</span>
          <h2>One home, a display for every place.</h2>
          <p>Create tablet, wall, or room dashboards for ${escHtml(profile)}. Each gets a stable address and opens in a browser signed into this OE profile.</p>
        </div>
        <button class="dash-display-primary hero-action" data-action="openDashboardDisplayCreate">${icon('plus', 15)} New dashboard</button>
      </div>
      ${_oeDisplayDashboards.length ? `
        <div class="dash-display-library-head">
          <span>${_oeDisplayDashboards.length} dashboard${_oeDisplayDashboards.length === 1 ? '' : 's'}</span>
          <button class="dash-display-text-btn" data-action="loadDashboardDisplayStudio">${icon('refresh-cw', 13)} Refresh</button>
        </div>
        <div class="dash-display-list">${_oeDisplayDashboards.map(oeDisplayLibraryCard).join('')}</div>` : `
        <div class="dash-display-empty">
          <span class="dash-display-empty-icon">${icon('monitor-up', 30)}</span>
          <h3>Create your first display</h3>
          <p>Give a wall tablet or browser a focused dashboard of its own.</p>
          <button class="dash-display-primary" data-action="openDashboardDisplayCreate">New dashboard</button>
        </div>`}
    </div>`;
  if (window.lucide) lucide.createIcons();
}

function oeDisplayAvailableSlug(base, exclude = '') {
  const initial = oeDisplaySafeSlug(base) || 'dashboard';
  let candidate = initial;
  let suffix = 2;
  while (_oeDisplayDashboards.some(item => item.slug === candidate && item.slug !== exclude)) {
    const suffixText = `-${suffix}`;
    candidate = `${initial.slice(0, 64 - suffixText.length).replace(/-+$/g, '')}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

async function openDashboardDisplayCreate(sourceSlug = '', duplicate = false) {
  if (!(await oeDisplayFlushEditor())) return;
  if (typeof sourceSlug !== 'string') sourceSlug = '';
  _oeDisplayStudioMode = 'create';
  _oeDisplayCreateSource = oeDisplaySafeSlug(sourceSlug);
  _oeDisplayCreateDuplicate = duplicate === true;
  _oeDisplaySlugTouched = false;
  _oeDisplayThemeTouched = false;
  _oeDisplayLoadGeneration++;
  if (!oeDisplayStudioPanel()) {
    openDashboardDisplays('create', _oeDisplayCreateSource, _oeDisplayCreateDuplicate);
    return;
  }
  renderDashboardDisplayCreate(_oeDisplayCreateSource, _oeDisplayCreateDuplicate);
}

function dashboardDisplayDuplicate(slug) {
  openDashboardDisplayCreate(slug, true);
}

function renderDashboardDisplayCreate(sourceSlug = '', duplicate = false) {
  const panel = oeDisplayStudioPanel();
  if (!panel) return;
  panel.classList.remove('configuring');
  const source = _oeDisplayDashboards.find(item => item.slug === sourceSlug)
    || _oeDisplayDashboards.find(item => item.slug === _oeDisplayDefaultSlug)
    || _oeDisplayDashboards[0];
  const baseName = duplicate ? `${source?.name || 'Dashboard'} copy` : 'New dashboard';
  const slug = oeDisplayAvailableSlug(baseName);
  const theme = oeDisplayTheme(source?.theme);
  const template = duplicate ? 'copy' : 'starter';
  const sourceOptions = _oeDisplayDashboards.map(item =>
    `<option value="${escHtml(item.slug)}"${item.slug === source?.slug ? ' selected' : ''}>${escHtml(item.name)}</option>`
  ).join('');
  panel.innerHTML = `
    <div class="dash-display-create">
      <div class="dash-display-create-head">
        <button class="dash-display-text-btn" data-action="dashboardDisplayShowLibrary">${icon('arrow-left', 14)} Dashboard library</button>
        <div>
          <span class="dash-display-eyebrow">${duplicate ? 'Duplicate display' : 'New display'}</span>
          <h2>${duplicate ? `Copy ${escHtml(source?.name || 'dashboard')}` : 'Create a dashboard'}</h2>
          <p>Set the permanent address now, then configure the cards in OE.</p>
        </div>
      </div>
      <form class="dash-display-form" data-submit-action="dashboardDisplaySubmitCreate" data-prevent-default>
        <div class="dash-display-form-grid">
          <label class="dash-display-field">
            <span>Name</span>
            <input id="dashboardDisplayName" maxlength="100" value="${escHtml(baseName)}" placeholder="Kitchen tablet" autocomplete="off" data-input-action="dashboardDisplayNameInput" data-input-args='["$value"]'>
          </label>
          <label class="dash-display-field">
            <span>Theme</span>
            <select id="dashboardDisplayTheme" data-change-action="dashboardDisplayThemeChange">
              <option value="midnight"${theme === 'midnight' ? ' selected' : ''}>Midnight</option>
              <option value="sand"${theme === 'sand' ? ' selected' : ''}>Warm daylight</option>
            </select>
          </label>
          <label class="dash-display-field dash-display-field-wide">
            <span>Stable address</span>
            <div class="dash-display-slug-row">
              <span>${escHtml(location.origin)}/dashboards/</span>
              <input id="dashboardDisplaySlug" maxlength="64" value="${escHtml(slug)}" placeholder="kitchen-tablet" spellcheck="false" autocapitalize="none" data-input-action="dashboardDisplaySlugInput" data-input-args='["$value"]' data-blur-action="dashboardDisplaySlugBlur" data-blur-args='["$value"]'>
            </div>
            <small>This address is set when the dashboard is created.</small>
          </label>
          <label class="dash-display-field dash-display-field-wide">
            <span>Description</span>
            <textarea id="dashboardDisplayDescription" maxlength="500" rows="3" placeholder="Where or how this display will be used">${escHtml(duplicate ? source?.description || '' : '')}</textarea>
          </label>
        </div>
        <fieldset class="dash-display-template-fieldset">
          <legend>Start with</legend>
          <div class="dash-display-template-grid">
            ${oeDisplayTemplateOption('blank', 'Blank', 'One empty section, ready to build.', 'file-plus-2', template === 'blank')}
            ${oeDisplayTemplateOption('starter', 'Starter home', 'A balanced set of Home Assistant devices.', 'house', template === 'starter')}
            ${oeDisplayTemplateOption('copy', 'Copy existing', 'Reuse another display\'s complete layout.', 'copy', template === 'copy')}
          </div>
          <label class="dash-display-copy-source${template === 'copy' ? ' visible' : ''}" id="dashboardDisplayCopySourceRow">
            <span>Dashboard to copy</span>
            <select id="dashboardDisplayCopySource"${template === 'copy' ? '' : ' disabled'} data-change-action="dashboardDisplayCopySourceChange" data-change-args='["$value"]'>${sourceOptions}</select>
          </label>
        </fieldset>
        <div class="dash-display-form-footer">
          <p class="dash-display-form-error" id="dashboardDisplayCreateError" role="alert"></p>
          <button type="button" class="dash-display-secondary" data-action="dashboardDisplayShowLibrary">Cancel</button>
          <button type="submit" class="dash-display-primary" id="dashboardDisplayCreateButton">${icon('plus', 14)} Create dashboard</button>
        </div>
      </form>
    </div>`;
  dashboardDisplayUpdateSlugPreview(slug);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => $('dashboardDisplayName')?.focus(), 20);
}

function oeDisplayTemplateOption(value, title, description, iconName, selected) {
  return `
    <label class="dash-display-template-option">
      <input type="radio" name="dashboardDisplayTemplate" value="${value}"${selected ? ' checked' : ''} data-change-action="dashboardDisplayTemplateChange" data-change-args='["${value}"]'>
      <span class="dash-display-template-icon">${icon(iconName, 20)}</span>
      <span><strong>${escHtml(title)}</strong><small>${escHtml(description)}</small></span>
      <i>${icon('check', 14)}</i>
    </label>`;
}

async function dashboardDisplayShowLibrary() {
  if (!(await oeDisplayFlushEditor())) return;
  _oeDisplayStudioMode = 'library';
  _oeDisplayCreateSource = '';
  _oeDisplayCreateDuplicate = false;
  loadDashboardDisplayStudio();
}

function dashboardDisplayNameInput(value) {
  if (_oeDisplaySlugTouched) return;
  const input = $('dashboardDisplaySlug');
  if (!input) return;
  input.value = oeDisplayAvailableSlug(value);
  dashboardDisplayUpdateSlugPreview(input.value);
}

function dashboardDisplaySlugInput(value) {
  _oeDisplaySlugTouched = true;
  dashboardDisplayUpdateSlugPreview(value);
}

function dashboardDisplaySlugBlur(value) {
  const input = $('dashboardDisplaySlug');
  const slug = oeDisplaySafeSlug(value);
  if (input) input.value = slug;
  dashboardDisplayUpdateSlugPreview(slug);
}

function dashboardDisplayUpdateSlugPreview(value) {
  const input = $('dashboardDisplaySlug');
  if (!input) return;
  const slug = oeDisplaySafeSlug(value);
  const duplicate = _oeDisplayDashboards.some(item => item.slug === slug);
  input.setCustomValidity(!slug
    ? 'Enter a dashboard address.'
    : duplicate
      ? 'That dashboard address is already in use.'
      : '');
  input.classList.toggle('invalid', Boolean(value && (!slug || duplicate)));
}

function dashboardDisplayTemplateChange(value) {
  const row = $('dashboardDisplayCopySourceRow');
  const select = $('dashboardDisplayCopySource');
  const visible = value === 'copy';
  row?.classList.toggle('visible', visible);
  if (select) select.disabled = !visible;
  if (visible) dashboardDisplayCopySourceChange(select?.value);
}

function dashboardDisplayThemeChange() {
  _oeDisplayThemeTouched = true;
}

function dashboardDisplayCopySourceChange(value) {
  if (_oeDisplayThemeTouched) return;
  const source = _oeDisplayDashboards.find(item => item.slug === oeDisplaySafeSlug(value));
  const select = $('dashboardDisplayTheme');
  if (source && select) select.value = oeDisplayTheme(source.theme);
}

function oeDisplayEmptyFocus() {
  return {
    defaultMode: 'overview',
    roomOrder: [],
    hiddenRooms: [],
    deviceOrder: [],
    hiddenDevices: [],
    cards: [],
  };
}

function oeDisplayBlankLayout() {
  return {
    version: 6,
    title: 'Everything is in its place.',
    sections: [{
      id: oeDisplayUid('space'),
      title: 'My dashboard',
      accent: 'lime',
      collapsed: false,
      cards: [],
    }],
    focus: oeDisplayEmptyFocus(),
    chrome: oeDisplayChrome(),
    colors: oeDisplayColors(),
  };
}

function oeDisplayNormalizeEntity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entityId = String(raw.entityId || raw.entity_id || '');
  if (!/^[a-z][a-z0-9_]{0,63}\.[a-z0-9_]{1,190}$/.test(entityId)) return null;
  const domain = String(raw.domain || entityId.split('.')[0]).toLowerCase();
  const attributes = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : {};
  const name = String(raw.name || attributes.friendly_name || entityId.split('.').slice(1).join(' ').replaceAll('_', ' '));
  const state = String(raw.state ?? 'unknown');
  return {
    entityId,
    domain,
    attributes,
    name,
    state,
    available: raw.available !== false && !['unknown', 'unavailable'].includes(state.toLowerCase()),
  };
}

function oeDisplayCardView(entity) {
  const domain = entity.domain;
  const attrs = entity.attributes || {};
  if (domain === 'binary_sensor' && ['door', 'window', 'opening', 'garage_door'].includes(attrs.device_class)) return 'contact';
  if (domain === 'light') {
    const modes = Array.isArray(attrs.supported_color_modes) ? attrs.supported_color_modes : [];
    return attrs.brightness != null || modes.some(mode => mode !== 'onoff') ? 'dimmer' : 'toggle';
  }
  if (domain === 'climate') return 'thermostat';
  if (['fan', 'cover', 'media_player', 'number', 'input_number', 'humidifier'].includes(domain)) return 'slider';
  if (domain === 'camera') return 'camera';
  if (['sensor', 'binary_sensor', 'weather', 'person'].includes(domain)) return 'status';
  if (['switch', 'input_boolean', 'lock'].includes(domain)) return 'toggle';
  return 'auto';
}

function oeDisplayCardFor(entity) {
  const accent = ({
    light: 'amber', switch: 'lime', input_boolean: 'lime', fan: 'cyan', cover: 'sky',
    lock: 'violet', climate: 'rose', media_player: 'violet', scene: 'violet',
    script: 'violet', automation: 'violet', sensor: 'cyan', binary_sensor: 'rose',
    vacuum: 'sky', humidifier: 'cyan', number: 'sky', input_number: 'sky',
    weather: 'sky', camera: 'violet',
  })[entity.domain] || 'lime';
  const size = ['climate', 'cover', 'media_player', 'camera'].includes(entity.domain)
    ? 'wide'
    : ['sensor', 'binary_sensor', 'scene', 'script', 'automation'].includes(entity.domain)
      ? 'compact'
      : 'standard';
  return {
    id: oeDisplayUid('card'),
    kind: 'ha-entity',
    entityId: entity.entityId,
    title: '',
    view: oeDisplayCardView(entity),
    size,
    accent,
  };
}

function oeDisplayStarterLayout(rawEntities) {
  const candidates = (Array.isArray(rawEntities) ? rawEntities : [])
    .map(oeDisplayNormalizeEntity)
    .filter(Boolean)
    .filter(entity => entity.attributes?.entity_category !== 'diagnostic');
  const available = candidates.filter(entity => entity.available);
  const entities = (available.length ? available : candidates)
    .sort((left, right) => left.name.localeCompare(right.name));
  const used = new Set();
  const take = (domains, limit) => {
    const cards = [];
    while (cards.length < limit) {
      let added = false;
      for (const domain of domains) {
        const entity = entities.find(item => item.domain === domain && !used.has(item.entityId));
        if (!entity) continue;
        used.add(entity.entityId);
        cards.push(oeDisplayCardFor(entity));
        added = true;
        if (cards.length >= limit) break;
      }
      if (!added) break;
    }
    return cards;
  };
  const sections = [
    { id: oeDisplayUid('space'), title: 'Everyday', accent: 'lime', collapsed: false, cards: take(['light', 'switch', 'input_boolean', 'fan', 'climate', 'cover', 'media_player', 'vacuum', 'humidifier', 'number', 'input_number'], 12) },
    { id: oeDisplayUid('space'), title: 'Security & access', accent: 'violet', collapsed: false, cards: take(['lock', 'binary_sensor'], 7) },
    { id: oeDisplayUid('space'), title: 'At a glance', accent: 'cyan', collapsed: false, cards: take(['sensor', 'weather', 'person'], 7) },
    { id: oeDisplayUid('space'), title: 'Scenes', accent: 'amber', collapsed: false, cards: take(['scene', 'script', 'automation'], 7) },
  ].filter(section => section.cards.length);
  if (!sections.length) {
    sections.push({ id: oeDisplayUid('space'), title: 'My devices', accent: 'lime', collapsed: false, cards: [] });
  }
  return {
    version: 6,
    title: 'Everything is in its place.',
    sections,
    focus: oeDisplayEmptyFocus(),
    chrome: oeDisplayChrome(),
    colors: oeDisplayColors(),
  };
}

function oeDisplayUpgradeLayout(rawLayout) {
  const layout = typeof structuredClone === 'function'
    ? structuredClone(rawLayout)
    : JSON.parse(JSON.stringify(rawLayout));
  const sourceVersion = Number(layout.version);
  layout.version = 6;
  layout.focus = layout.focus && typeof layout.focus === 'object'
    ? layout.focus
    : oeDisplayEmptyFocus();
  layout.chrome = oeDisplayChrome(sourceVersion >= 5 ? layout.chrome : null);
  layout.colors = oeDisplayColors(sourceVersion >= 6 ? layout.colors : null);
  if (sourceVersion < 5) {
    layout.chrome.showSummary = layout.sections.some(section => section.cards.some(card => card.kind !== 'widget'));
  }
  layout.sections = layout.sections.map(section => ({
    ...section,
    cards: section.cards.map(card => {
      if (card.kind === 'widget') return card;
      const group = card.kind === 'ha-group'
        || Array.isArray(card.entityIds)
        || card.view === 'group';
      return { ...card, kind: group ? 'ha-group' : 'ha-entity' };
    }),
  }));
  return layout;
}

async function oeDisplayLayoutForTemplate(template) {
  if (template === 'blank') return oeDisplayBlankLayout();
  if (template === 'copy') {
    const source = oeDisplaySafeSlug($('dashboardDisplayCopySource')?.value);
    if (!source) throw new Error('Choose a dashboard to copy.');
    const data = await oeDisplayApi(`/api/dashboards/${encodeURIComponent(source)}/layout`, { cache: 'no-store' });
    if (!data?.layout || !Array.isArray(data.layout.sections)) {
      throw new Error('The selected dashboard has no layout to copy.');
    }
    return oeDisplayUpgradeLayout(data.layout);
  }
  let data;
  try {
    data = await oeDisplayApi('/api/dashboard-runtime/entities', { cache: 'no-store' });
  } catch (error) {
    throw new Error(`Starter home needs Home Assistant entities: ${error.message}`);
  }
  const entities = Array.isArray(data) ? data : data?.entities;
  if (!Array.isArray(entities)) {
    throw new Error('Starter home could not read the Home Assistant entity list. Choose Blank instead.');
  }
  return oeDisplayStarterLayout(entities);
}

async function dashboardDisplaySubmitCreate() {
  if (_oeDisplayMutation) return;
  const nameInput = $('dashboardDisplayName');
  const slugInput = $('dashboardDisplaySlug');
  const errorLabel = $('dashboardDisplayCreateError');
  const button = $('dashboardDisplayCreateButton');
  const name = String(nameInput?.value || '').trim().slice(0, 100);
  const slug = oeDisplaySafeSlug(slugInput?.value);
  if (slugInput) slugInput.value = slug;
  dashboardDisplayUpdateSlugPreview(slug);
  if (!name) {
    if (errorLabel) errorLabel.textContent = 'Give this dashboard a name.';
    nameInput?.focus();
    return;
  }
  if (!slug || _oeDisplayDashboards.some(item => item.slug === slug)) {
    if (errorLabel) errorLabel.textContent = !slug
      ? 'Enter a stable dashboard address.'
      : 'That dashboard address is already in use.';
    slugInput?.focus();
    return;
  }
  const description = String($('dashboardDisplayDescription')?.value || '').trim().slice(0, 500);
  const theme = oeDisplayTheme($('dashboardDisplayTheme')?.value);
  const template = document.querySelector('input[name="dashboardDisplayTemplate"]:checked')?.value || 'starter';
  const operationPanel = oeDisplayStudioPanel();
  const operationGeneration = ++_oeDisplayLoadGeneration;
  _oeDisplayMutation = true;
  if (button) {
    button.disabled = true;
    button.innerHTML = `${icon('loader-circle', 14)} Creating…`;
  }
  if (errorLabel) errorLabel.textContent = '';
  try {
    const layout = await oeDisplayLayoutForTemplate(template);
    await oeDisplayApi('/api/dashboards', {
      method: 'POST',
      body: JSON.stringify({ slug, name, description, theme, layout }),
    });
    await oeDisplayLoadCatalog();
    _oeDisplayMutation = false;
    if (!oeDisplayOperationIsCurrent(operationPanel, operationGeneration, 'create')) return;
    oeDisplaySetNotice('Dashboard created', 'success');
    dashboardDisplayConfigure(slug);
  } catch (error) {
    _oeDisplayMutation = false;
    if (!oeDisplayOperationIsCurrent(operationPanel, operationGeneration, 'create')) return;
    if (errorLabel) errorLabel.textContent = error.message;
    if (button) {
      button.disabled = false;
      button.innerHTML = `${icon('plus', 14)} Create dashboard`;
    }
    if (window.lucide) lucide.createIcons();
  }
}

async function dashboardDisplayDelete(slug) {
  if (_oeDisplayMutation) return;
  const dashboard = _oeDisplayDashboards.find(item => item.slug === slug);
  if (!dashboard) return;
  if (slug === 'home' || dashboard.isDefault) {
    oeDisplaySetNotice('Home is the required default dashboard and cannot be deleted.', 'error');
    return;
  }
  if (!confirm(`Delete ${dashboard.name}? This permanently removes its saved layout.`)) return;
  const operationPanel = oeDisplayStudioPanel();
  const operationMode = _oeDisplayStudioMode;
  const operationGeneration = ++_oeDisplayLoadGeneration;
  _oeDisplayMutation = true;
  oeDisplaySetNotice('Saving changes…');
  if (!(await oeDisplayFlushEditor())) {
    _oeDisplayMutation = false;
    return;
  }
  if (!oeDisplayOperationIsCurrent(operationPanel, operationGeneration, operationMode)) {
    _oeDisplayMutation = false;
    oeDisplaySetNotice('');
    return;
  }
  oeDisplaySetNotice('Deleting…');
  try {
    await oeDisplayApi(`/api/dashboards/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    await oeDisplayLoadCatalog();
    _oeDisplayMutation = false;
    if (!oeDisplayOperationIsCurrent(operationPanel, operationGeneration, operationMode)) return;
    _oeDisplayCreateSource = '';
    _oeDisplayCreateDuplicate = false;
    renderDashboardDisplayLibrary();
    oeDisplaySetNotice('Dashboard deleted', 'success');
  } catch (error) {
    _oeDisplayMutation = false;
    if (!oeDisplayOperationIsCurrent(operationPanel, operationGeneration, operationMode)) return;
    oeDisplaySetNotice(error.message, 'error');
  }
}

async function dashboardDisplayCopyAddress(slug) {
  const address = oeDisplayAddress(slug);
  try {
    await navigator.clipboard.writeText(address);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = address;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  oeDisplaySetNotice('Address copied', 'success');
}

function dashboardDisplayConfigure(slug) {
  const dashboard = _oeDisplayDashboards.find(item => item.slug === slug);
  if (!dashboard) return;
  _oeDisplayLoadGeneration++;
  _oeDisplayStudioMode = 'configure';
  const panel = oeDisplayStudioPanel();
  if (!panel) return;
  const address = oeDisplayAddress(slug);
  const permanent = slug === 'home' || dashboard.isDefault;
  const deleteAction = permanent
    ? `<button class="dash-display-danger" type="button" disabled title="Home is required. To start over, use Customize → Dashboard settings → Reset everything.">${icon('lock-keyhole', 14)} Home is required</button>`
    : `<button class="dash-display-danger" type="button" data-action="dashboardDisplayDelete" data-args='${oeDisplayArgs([slug])}'>${icon('trash-2', 14)} Delete</button>`;
  const frameUrl = new URL(dashboard.url || oeDisplayPath(slug), location.origin);
  frameUrl.searchParams.set('oe_editor', '1');
  panel.classList.add('configuring');
  panel.innerHTML = `
    <div class="dash-display-configure">
      <div class="dash-display-configure-bar">
        <button class="dash-display-text-btn" data-action="dashboardDisplayShowLibrary">${icon('arrow-left', 14)} Dashboard library</button>
        <div class="dash-display-configure-identity">
          <strong>${escHtml(dashboard.name)}</strong>
          <span>${escHtml(address)}</span>
        </div>
        <button class="dash-display-secondary" data-action="dashboardDisplayCopyAddress" data-args='${oeDisplayArgs([slug])}'>${icon('copy', 14)} Copy address</button>
        <a class="dash-display-primary" href="${escHtml(dashboard.url)}" target="_blank" rel="noopener">${icon('external-link', 14)} Open display</a>
        ${deleteAction}
      </div>
      <div class="dash-display-frame-wrap">
        <iframe class="dash-display-editor-frame" src="${escHtml(`${frameUrl.pathname}${frameUrl.search}`)}" title="Configure ${escHtml(dashboard.name)}"></iframe>
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
}
