// Credential prompt bubbles — extracted from chat-render.js.
// Globals intentional.

// ── Credential prompt bubble ─────────────────────────────────────────────────
// A tool (or the oe-admin skill) asked the user for a secret. The value is
// pasted into a password-style input and submitted via a NEW WS frame
// (`submit_credential`), bypassing the normal chat input pipeline so it
// never enters the LLM message history. The bubble morphs into a "Provided"
// indicator on submit — the actual value is never rendered to the DOM.
function appendCredentialPromptBubble(credentialId, label, description, kind) {
  if (!credentialId) return;
  if (document.querySelector(`.msg.credential-prompt[data-credential-id="${CSS.escape(credentialId)}"]`)) return;

  const el = document.createElement('div');
  el.className = 'msg credential-prompt';
  el.dataset.credentialId = credentialId;
  el.dataset.credentialKind = kind || 'api_key';
  el.style.cssText = 'padding:10px 12px;margin:6px 0;font-size:13px;border-left:3px solid #f0b400;background:rgba(240,180,0,0.06);border-radius:4px';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
  const icon = document.createElement('span');
  icon.textContent = kind === 'sudo' ? '🔐' : kind === 'confirm' ? '⚠️' : '🔑';
  header.appendChild(icon);
  const labelEl = document.createElement('span');
  labelEl.style.cssText = 'font-weight:600';
  labelEl.textContent = label || 'Enter credential';
  header.appendChild(labelEl);
  el.appendChild(header);

  if (description) {
    const desc = document.createElement('div');
    desc.style.cssText = 'color:var(--muted);font-size:12px;margin-bottom:8px;white-space:pre-wrap';
    desc.textContent = description;
    el.appendChild(desc);
  }
  if (kind === 'sudo') {
    const note = document.createElement('div');
    note.style.cssText = 'color:var(--muted);font-size:11px;margin-bottom:8px';
    note.textContent = 'Used once for this operation. Not stored.';
    el.appendChild(note);
  } else if (kind === 'confirm') {
    const note = document.createElement('div');
    note.style.cssText = 'color:var(--muted);font-size:11px;margin-bottom:8px';
    note.textContent = 'Type the exact confirmation phrase shown above.';
    el.appendChild(note);
  }

  const form = document.createElement('form');
  form.style.cssText = 'display:flex;gap:6px;align-items:center';

  const input = document.createElement('input');
  input.type = kind === 'confirm' ? 'text' : 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText = 'flex:1;padding:6px 8px;border:1px solid var(--border);background:var(--bg-input, #111);color:var(--fg);border-radius:4px;font-family:inherit;font-size:13px';
  input.placeholder = kind === 'sudo' ? 'sudo password' : kind === 'confirm' ? 'type here…' : 'paste secret here';
  form.appendChild(input);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = 'Submit';
  submitBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--accent, #6c8cff);background:var(--accent, #6c8cff);color:#fff;border-radius:4px;cursor:pointer;font-size:12px';
  form.appendChild(submitBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:4px;cursor:pointer;font-size:12px';
  form.appendChild(cancelBtn);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = input.value;
    if (!value) return;
    // Clear input immediately — the value lives only on the wire from here.
    input.value = '';
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    try {
      ws.send(JSON.stringify({ type: 'submit_credential', credentialId, value }));
    } catch (e) {
      markCredentialBubbleError(credentialId, 'send_failed');
    }
  });
  cancelBtn.addEventListener('click', () => {
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelled';
    try { ws.send(JSON.stringify({ type: 'cancel_credential', credentialId })); } catch {}
  });

  el.appendChild(form);
  insertBefore(el);
  scrollToBottom();
}

function resolveCredentialBubble(credentialId, cancelled) {
  const el = document.querySelector(`.msg.credential-prompt[data-credential-id="${CSS.escape(credentialId)}"]`);
  if (!el) return;
  const form = el.querySelector('form');
  if (form) form.remove();
  const status = document.createElement('div');
  status.style.cssText = 'color:var(--muted);font-size:12px';
  status.textContent = cancelled ? 'Cancelled.' : 'Provided.';
  el.appendChild(status);
}

function markCredentialBubbleError(credentialId, error) {
  const el = document.querySelector(`.msg.credential-prompt[data-credential-id="${CSS.escape(credentialId)}"]`);
  if (!el) return;
  const err = document.createElement('div');
  err.style.cssText = 'color:#f55;font-size:12px;margin-top:6px';
  err.textContent = 'Error: ' + (error || 'unknown');
  el.appendChild(err);
}
