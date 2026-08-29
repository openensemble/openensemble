// OE Bridge surrogate for Google Publisher Tag (gpt.js).
//
// Publisher pages drive their layout through `googletag.cmd.push(...)`. Without
// a stub those callbacks never run and the surrounding content never renders.
(() => {
  const noop = () => {};
  const chainable = () => new Slot();

  function Slot() {}
  const proto = Slot.prototype;
  for (const method of [
    'addService', 'clearCategoryExclusions', 'clearTargeting', 'defineSizeMapping',
    'setCategoryExclusion', 'setClickUrl', 'setCollapseEmptyDiv', 'setConfig',
    'setForceSafeFrame', 'setSafeFrameConfig', 'setTargeting', 'updateTargetingFromMap',
  ]) proto[method] = chainable;
  proto.get = () => null;
  proto.getAdUnitPath = () => '';
  proto.getAttributeKeys = () => [];
  proto.getCategoryExclusions = () => [];
  proto.getDomId = () => '';
  proto.getResponseInformation = () => null;
  proto.getSlotElementId = () => '';
  proto.getSlotId = () => ({ getDomId: () => '', getId: () => '' });
  proto.getSizes = () => [];
  proto.getTargeting = () => [];
  proto.getTargetingKeys = () => [];

  function Service() {}
  const service = Service.prototype;
  for (const method of [
    'addEventListener', 'removeEventListener', 'clear', 'clearTargeting', 'collapseEmptyDivs',
    'defineOutOfPageSlot', 'disableInitialLoad', 'display', 'enable', 'enableAsyncRendering',
    'enableSingleRequest', 'enableVideoAds', 'refresh', 'set', 'setCentering',
    'setCookieOptions', 'setPublisherProvidedId', 'setRequestNonPersonalizedAds',
    'setSafeFrameConfig', 'setTargeting', 'setVideoContent', 'updateCorrelator',
  ]) service[method] = function () { return this; };
  service.getSlots = () => [];
  service.getSlotIdMap = () => ({});
  service.get = () => null;
  service.getTargeting = () => [];
  service.getTargetingKeys = () => [];

  const pubads = new Service();
  const googletag = {
    apiReady: true,
    pubadsReady: true,
    cmd: [],
    companionAds: () => new Service(),
    content: () => ({ setContent: noop }),
    defineOutOfPageSlot: chainable,
    defineSlot: chainable,
    defineUnit: chainable,
    destroySlots: noop,
    disablePublisherConsole: noop,
    display: noop,
    enableServices: noop,
    getVersion: () => '0',
    pubads: () => pubads,
    setAdIframeTitle: noop,
    setConfig: noop,
    sizeMapping: () => {
      const builder = { addSize: () => builder, build: () => [] };
      return builder;
    },
  };

  // Anything already queued by the page must still run, and later pushes must
  // execute immediately rather than pile up in an array nobody drains.
  const pending = Array.isArray(window.googletag?.cmd) ? window.googletag.cmd : [];
  googletag.cmd.push = function (...callbacks) {
    for (const callback of callbacks) {
      if (typeof callback === 'function') setTimeout(() => { try { callback(); } catch {} }, 1);
    }
    return 1;
  };
  try { window.googletag = googletag; } catch {}
  for (const callback of pending) {
    if (typeof callback === 'function') setTimeout(() => { try { callback(); } catch {} }, 1);
  }
})();
