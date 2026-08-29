// OE Bridge surrogate for Google Analytics (analytics.js / gtag.js).
//
// Blocking analytics outright breaks pages that call `ga(...)` or `gtag(...)`
// in line with their own logic. This stub keeps those call sites working and
// sends nothing anywhere.
(() => {
  const noop = () => {};

  function Tracker() {}
  const proto = Tracker.prototype;
  proto.get = noop;
  proto.set = noop;
  proto.send = noop;

  const ga = function (...args) {
    const last = args[args.length - 1];
    // `ga('send', ..., { hitCallback })` and `ga(fn)` both expect their
    // callback to run, or the page can stall waiting for it.
    if (typeof last === 'function') { setTimeout(() => { try { last(); } catch {} }, 1); return; }
    if (last && typeof last === 'object' && typeof last.hitCallback === 'function') {
      setTimeout(() => { try { last.hitCallback(); } catch {} }, 1);
    }
  };
  ga.create = () => new Tracker();
  ga.getByName = () => new Tracker();
  ga.getAll = () => [];
  ga.remove = noop;
  ga.loaded = true;
  ga.q = [];

  const name = window.GoogleAnalyticsObject || 'ga';
  try { window[name] = ga; } catch {}
  try { window.ga = ga; } catch {}

  try {
    window.dataLayer = window.dataLayer || [];
    if (typeof window.dataLayer.push !== 'function' || !window.dataLayer.__oe) {
      window.dataLayer.push = function (...args) {
        for (const entry of args) {
          const callback = entry && typeof entry === 'object' ? entry.eventCallback : null;
          if (typeof callback === 'function') setTimeout(() => { try { callback(); } catch {} }, 1);
        }
        return 0;
      };
      window.dataLayer.__oe = true;
    }
  } catch {}

  try { if (typeof window.gtag !== 'function') window.gtag = noop; } catch {}
})();
