/** Native iOS drawer descriptions. Data only; no downloaded UI code. */
export function validateNativeDrawerUI(value, apiPrefixes) {
  if (value == null) return null;
  try {
    const fail = message => { throw new Error(message); };
    const v2 = value.version === 2;
    const object = input => input !== null && typeof input === 'object' && !Array.isArray(input);
    const keys = (input, allowed) => {
      if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('Unsupported property or object shape');
    };
    const field = input => {
      if (typeof input !== 'string' || input.length > 160 || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(input)
          || input.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail('Invalid field reference');
    };
    const title = input => { if (typeof input !== 'string' || !input.trim() || input.length > 120) fail('A short title is required'); };
    const binding = (input, depth = 0) => {
      if (depth > 12) fail('Value nesting is too deep');
      if (object(input)) {
        if (Object.hasOwn(input, '$row')) { keys(input, ['$row']); field(input.$row); return; }
        for (const [key, child] of Object.entries(input)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Invalid object key');
          binding(child, depth + 1);
        }
      } else if (Array.isArray(input)) input.forEach(child => binding(child, depth + 1));
    };
    const request = (input, placeholders = false) => {
      keys(input, ['path', 'query']);
      if (typeof input.path !== 'string' || input.path.length > 512
          || !apiPrefixes.some(prefix => prefix.startsWith('/api/usr_') && input.path.startsWith(prefix))) fail('A native drawer can only use its own API namespace');
      for (const part of input.path.split('/').slice(1)) {
        if (placeholders && part.startsWith('{') && part.endsWith('}')) { field(part.slice(1, -1)); continue; }
        const decoded = decodeURIComponent(part);
        if (!decoded || decoded === '.' || decoded === '..' || /[\\/{}?#\x00-\x1f\x7f]/.test(decoded)) fail('Invalid API path');
      }
      if (input.query !== undefined) {
        if (!object(input.query) || Object.keys(input.query).length > 32) fail('Invalid query');
        for (const val of Object.values(input.query)) {
          if (object(val)) { keys(val, ['$row']); field(val.$row); }
          else if (!['string', 'number', 'boolean'].includes(typeof val) || String(val).length > 2048) fail('Invalid query value');
        }
      }
    };
    const action = input => {
      keys(input, ['title', 'method', 'request', 'body', 'fields', 'destructive', 'confirmation', ...(v2 ? ['result'] : [])]);
      title(input.title);
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)) fail('Invalid action method');
      request(input.request, true);
      if (input.body !== undefined) { if (!object(input.body)) fail('Action body must be an object'); binding(input.body); }
      if (input.fields !== undefined) {
        if (!Array.isArray(input.fields) || input.fields.length > 32) fail('Too many form fields');
        const seen = new Set();
        for (const item of input.fields) {
          keys(item, ['key', 'label', 'type', 'required', 'choices', 'initial', 'help', ...(v2 ? ['source', 'sourceCollection', 'valueField', 'labelField'] : [])]);
          field(item.key); title(item.label);
          if (seen.has(item.key)) fail('Duplicate form field'); seen.add(item.key);
          if (!['text', 'multiline', 'secret', 'number', 'toggle', 'choice', 'multiChoice', ...(v2 ? ['nullableNumber', 'date', 'nullableDate', 'strings', 'json', 'secretJSON', 'file', 'jsonFile'] : [])].includes(item.type)) fail('Unsupported native control');
          if (item.source !== undefined) {
            if (!['choice', 'multiChoice'].includes(item.type)) fail('Only choice controls accept a source');
            request(item.source, true);
            for (const key of ['sourceCollection', 'valueField', 'labelField']) if (item[key]) field(item[key]);
          }
          if (item.choices !== undefined) {
            if (!Array.isArray(item.choices) || item.choices.length > 100) fail('Too many choices');
            item.choices.forEach(choice => { keys(choice, ['value', 'label']); title(choice.label); if (typeof choice.value !== 'string') fail('Invalid choice value'); });
          }
          if (item.initial !== undefined) binding(item.initial);
        }
      }
    };
    keys(value, ['version', 'screens']);
    if (![1, 2].includes(value.version) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 65_536) fail('nativeUI must use version 1 or 2 and be at most 64 KiB');
    if (!Array.isArray(value.screens) || value.screens.length < 1 || value.screens.length > 12) fail('nativeUI needs 1–12 screens');
    const ids = new Set();
    let screenCount = 0;
    const screenDefinition = (screen, depth = 0) => {
      if (depth > 3 || ++screenCount > 48) fail('Too many nested screens');
      keys(screen, ['id', 'title', 'request', 'presentation', 'collection', 'titleField', 'subtitleField', 'fields', 'create', 'actions',
        ...(v2 ? ['children', 'detailRequest', 'idField', 'refreshSeconds', 'nextPageField', 'pageParameter', 'searchParameter', 'download', 'upload'] : [])]);
      if (typeof screen.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(screen.id) || ids.has(screen.id)) fail('Invalid or duplicate screen id');
      ids.add(screen.id); title(screen.title); request(screen.request, depth > 0);
      if (screen.presentation !== undefined && !['list', 'record', ...(v2 ? ['table'] : [])].includes(screen.presentation)) fail('Unsupported presentation');
      for (const key of ['collection', 'titleField', 'subtitleField', 'idField', 'nextPageField', 'pageParameter', 'searchParameter']) if (screen[key]) field(screen[key]);
      if (screen.refreshSeconds !== undefined && (!Number.isInteger(screen.refreshSeconds) || screen.refreshSeconds < 5 || screen.refreshSeconds > 300)) fail('Refresh interval must be 5–300 seconds');
      if (screen.detailRequest !== undefined) request(screen.detailRequest, true);
      if (screen.download !== undefined) { keys(screen.download, ['request', 'filenameField']); request(screen.download.request, true); field(screen.download.filenameField); }
      if (screen.upload !== undefined) { keys(screen.upload, ['request']); request(screen.upload.request, depth > 0); }
      if (screen.fields !== undefined) { if (!Array.isArray(screen.fields) || screen.fields.length > 32) fail('Too many displayed fields'); screen.fields.forEach(field); }
      if (screen.create != null) action(screen.create);
      if (screen.actions !== undefined) { if (!Array.isArray(screen.actions) || screen.actions.length > 16) fail('Too many actions'); screen.actions.forEach(action); }
      if (screen.children !== undefined) { if (!Array.isArray(screen.children) || screen.children.length > 12) fail('Too many child screens'); screen.children.forEach(child => screenDefinition(child, depth + 1)); }
      for (const input of [screen.create, ...(screen.actions || [])]) if (input?.result) screenDefinition(input.result, depth + 1);
    };
    value.screens.forEach(screen => screenDefinition(screen));
    return null;
  } catch (error) { return `drawer.nativeUI: ${error.message}`; }
}
