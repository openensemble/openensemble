// Optional workspaces load once when opened; failed downloads can be retried.
const optionalScriptLoads = new Map();
function loadOptionalScript(src) {
  if (optionalScriptLoads.has(src)) return optionalScriptLoads.get(src);
  const pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => {
      optionalScriptLoads.delete(src);
      script.remove();
      reject(new Error('Could not load this workspace. Please try again.'));
    };
    document.head.appendChild(script);
  });
  optionalScriptLoads.set(src, pending);
  return pending;
}

function lazyWorkspaceAction(name, src) {
  let opening = null;
  const open = function (...args) {
    if (opening) return opening;
    const generation = typeof _authGeneration === 'undefined' ? null : _authGeneration;
    opening = loadOptionalScript(src).then(() => {
      if (typeof _authSuspended !== 'undefined' && _authSuspended) return;
      if (generation !== null && generation !== _authGeneration) return;
      if (window[name] === open) throw new Error('The workspace did not initialize. Reload and try again.');
      return window[name].apply(this, args);
    }).catch(error => showToast(error.message)).finally(() => { opening = null; });
    return opening;
  };
  window[name] = open;
}

lazyWorkspaceAction('openMailWorkspace', '/mail-workspace.js');
lazyWorkspaceAction('flashNewDevice', '/flash-wizard.js');
