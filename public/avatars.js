// ── Avatar system ────────────────────────────────────────────────────────────

const BUILTIN_AVATARS = [
  '🧑','👩','👨','🧒','👧','👦',
  '🧑‍💻','👩‍💻','👨‍💻','🧑‍🎨','👩‍🎨','👨‍🎨',
  '🧑‍🏫','👩‍🏫','👨‍🏫','🧑‍🔬','👩‍🔬','👨‍🔬',
  '🧑‍🚀','👩‍🚀','🧑‍🍳','🧑‍⚕️','🦊','🐱',
  '🐶','🐼','🦁','🐸','🦉','🐧',
  '🤖','👽','💀','🎃','🦄','🐉',
];

function renderAvatar(user, size = 36) {
  if (user?.avatar) {
    return `<img src="${user.avatar}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block" alt="">`;
  }
  return user?.emoji ?? '🧑';
}

function hasCustomAvatar(user) {
  return !!(user?.avatar);
}

// ── Avatar picker (shown in Profile tab) ─────────────────────────────────────
function renderAvatarPicker(container) {
  const user = _currentUser;
  if (!user) return;

  const currentPreview = hasCustomAvatar(user)
    ? `<img src="${user.avatar}?t=${Date.now()}" class="avatar-preview-img" alt="">`
    : `<div class="avatar-preview-emoji" style="background:${user.color ?? 'var(--bg3)'}">${user.emoji ?? '🧑'}</div>`;

  container.innerHTML = `
    <div class="avatar-picker">
      <div class="avatar-picker-current">
        <div class="avatar-preview" id="avatarPreview">${currentPreview}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--text)">${escHtml(user.name)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${hasCustomAvatar(user) ? 'Custom photo' : 'Emoji avatar'}</div>
        </div>
        ${hasCustomAvatar(user) ? `<button class="avatar-remove-btn" onclick="removeAvatar()" title="Remove photo">✕</button>` : ''}
      </div>

      <div class="avatar-section-title">Upload Photo</div>
      <div class="avatar-upload-row">
        <input type="file" id="avatarFileInput" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none" onchange="handleAvatarFileSelect(this.files[0])">
        <button class="avatar-upload-btn" onclick="$('avatarFileInput').click()">
          <span style="font-size:16px">📷</span> Choose Image
        </button>
        <div style="font-size:10px;color:var(--muted)">JPG, PNG, WebP, or GIF. Max 2MB.</div>
      </div>

      <div class="avatar-section-title">Built-in Avatars</div>
      <div class="avatar-builtin-grid">
        ${BUILTIN_AVATARS.map(e => `<button class="avatar-builtin-item${user.emoji === e && !hasCustomAvatar(user) ? ' active' : ''}" onclick="selectEmojiAvatar('${e}')">${e}</button>`).join('')}
      </div>
    </div>`;
}

// ── Crop modal state ─────────────────────────────────────────────────────────
let _cropState = null;

function handleAvatarFileSelect(file) {
  if (!file || !_currentUser) return;
  if (file.size > 2 * 1024 * 1024) { showToast('Image must be under 2MB'); return; }
  if (!file.type.match(/^image\/(jpeg|png|webp|gif)$/)) { showToast('Unsupported image type'); return; }

  const reader = new FileReader();
  reader.onload = () => openAvatarCropper(reader.result, file);
  reader.readAsDataURL(file);
}

function openAvatarCropper(dataUrl, file) {
  // Remove existing modal if any
  $('avatarCropModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'avatarCropModal';
  modal.className = 'avatar-crop-backdrop';
  modal.innerHTML = `
    <div class="avatar-crop-panel">
      <div class="avatar-crop-title">Position Your Photo</div>
      <div class="avatar-crop-hint">Drag to reposition. Scroll or use slider to zoom.</div>
      <div class="avatar-crop-viewport" id="avatarCropViewport">
        <img id="avatarCropImg" src="${dataUrl}" draggable="false">
      </div>
      <div class="avatar-crop-controls">
        <span style="font-size:14px;color:var(--muted)">−</span>
        <input type="range" id="avatarCropZoom" min="100" max="400" value="100" class="avatar-crop-slider">
        <span style="font-size:14px;color:var(--muted)">+</span>
      </div>
      <div class="avatar-crop-actions">
        <button class="avatar-crop-cancel" onclick="closeAvatarCropper()">Cancel</button>
        <button class="avatar-crop-save" onclick="saveAvatarCrop()">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) closeAvatarCropper(); });

  const img = $('avatarCropImg');
  const viewport = $('avatarCropViewport');
  const slider = $('avatarCropZoom');

  // Wait for image to load to get natural dimensions
  img.onload = () => {
    const vw = viewport.clientWidth;
    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    // Scale so both dimensions overflow the viewport by ~15%, giving room to pan both axes
    const fitScale = (vw / Math.min(nat.w, nat.h)) * 1.15;

    _cropState = {
      file,
      nat,
      vw,
      scale: fitScale,
      minScale: fitScale,
      maxScale: fitScale * 4,
      x: (vw - nat.w * fitScale) / 2,
      y: (vw - nat.h * fitScale) / 2,
      dragging: false,
      startX: 0, startY: 0,
      startOx: 0, startOy: 0,
    };

    slider.min = 100;
    slider.max = 400;
    slider.value = 100;

    applyCropTransform();
    setupCropEvents(viewport, img, slider);
  };
  // Trigger load if cached
  if (img.complete) img.onload();
}

function applyCropTransform() {
  const s = _cropState;
  if (!s) return;
  const img = $('avatarCropImg');
  if (!img) return;
  img.style.width = (s.nat.w * s.scale) + 'px';
  img.style.height = (s.nat.h * s.scale) + 'px';
  img.style.left = s.x + 'px';
  img.style.top = s.y + 'px';
}

function clampCropPosition() {
  const s = _cropState;
  if (!s) return;
  const imgW = s.nat.w * s.scale;
  const imgH = s.nat.h * s.scale;
  // Image must cover the viewport circle — don't let edges inside
  s.x = Math.min(0, Math.max(s.vw - imgW, s.x));
  s.y = Math.min(0, Math.max(s.vw - imgH, s.y));
}

function setupCropEvents(viewport, img, slider) {
  const s = _cropState;

  // ── Pointer drag (mouse + touch) ──
  function onPointerDown(e) {
    e.preventDefault();
    s.dragging = true;
    const pt = e.touches ? e.touches[0] : e;
    s.startX = pt.clientX; s.startY = pt.clientY;
    s.startOx = s.x; s.startOy = s.y;
  }
  function onPointerMove(e) {
    if (!s.dragging) return;
    e.preventDefault();
    const pt = e.touches ? e.touches[0] : e;
    s.x = s.startOx + (pt.clientX - s.startX);
    s.y = s.startOy + (pt.clientY - s.startY);
    clampCropPosition();
    applyCropTransform();
  }
  function onPointerUp() { s.dragging = false; }

  viewport.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  viewport.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp);

  // ── Scroll to zoom ──
  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    zoomCrop(delta, e.offsetX, e.offsetY);
    slider.value = Math.round(((s.scale - s.minScale) / (s.maxScale - s.minScale)) * 300 + 100);
  }, { passive: false });

  // ── Pinch to zoom ──
  let lastPinchDist = 0;
  viewport.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  }, { passive: false });
  viewport.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const delta = (dist - lastPinchDist) * 0.003;
      lastPinchDist = dist;
      const rect = viewport.getBoundingClientRect();
      const cx = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
      const cy = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top;
      zoomCrop(delta, cx, cy);
      slider.value = Math.round(((s.scale - s.minScale) / (s.maxScale - s.minScale)) * 300 + 100);
    }
  }, { passive: false });

  // ── Slider ──
  slider.addEventListener('input', () => {
    const pct = (slider.value - 100) / 300; // 0 to 1
    const oldScale = s.scale;
    s.scale = s.minScale + pct * (s.maxScale - s.minScale);
    // Zoom toward center
    const cx = s.vw / 2;
    const cy = s.vw / 2;
    s.x = cx - (cx - s.x) * (s.scale / oldScale);
    s.y = cy - (cy - s.y) * (s.scale / oldScale);
    clampCropPosition();
    applyCropTransform();
  });

  // Cleanup on modal close
  s._cleanup = () => {
    window.removeEventListener('mousemove', onPointerMove);
    window.removeEventListener('mouseup', onPointerUp);
    window.removeEventListener('touchmove', onPointerMove);
    window.removeEventListener('touchend', onPointerUp);
  };
}

function zoomCrop(delta, cx, cy) {
  const s = _cropState;
  if (!s) return;
  const oldScale = s.scale;
  s.scale = Math.min(s.maxScale, Math.max(s.minScale, s.scale * (1 + delta)));
  // Zoom toward pointer position
  s.x = cx - (cx - s.x) * (s.scale / oldScale);
  s.y = cy - (cy - s.y) * (s.scale / oldScale);
  clampCropPosition();
  applyCropTransform();
}

function closeAvatarCropper() {
  _cropState?._cleanup?.();
  _cropState = null;
  $('avatarCropModal')?.remove();
  // Reset file input so same file can be re-selected
  const fi = $('avatarFileInput');
  if (fi) fi.value = '';
}

async function saveAvatarCrop() {
  const s = _cropState;
  if (!s || !_currentUser) return;

  // Draw cropped region to canvas
  const canvas = document.createElement('canvas');
  const size = 512; // output avatar size
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Calculate source rectangle from crop state
  // The viewport shows a vw x vw area; the image is at (s.x, s.y) with size (nat.w*scale, nat.h*scale)
  // The visible region in image coordinates: top-left = (-s.x/s.scale, -s.y/s.scale), size = vw/scale x vw/scale
  const srcX = -s.x / s.scale;
  const srcY = -s.y / s.scale;
  const srcSize = s.vw / s.scale;

  const img = $('avatarCropImg');
  ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, size, size);

  // Convert to blob and upload
  canvas.toBlob(async (blob) => {
    if (!blob) { showToast('Failed to crop image'); closeAvatarCropper(); return; }
    const form = new FormData();
    form.append('avatar', blob, s.file.name);

    try {
      const res = await fetch(`/api/users/${_currentUser.id}/avatar`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Upload failed'); closeAvatarCropper(); return; }
      _currentUser.avatar = data.avatar;
      refreshAvatarEverywhere();
      renderAvatarPicker($('avatarPickerContainer'));
      showToast('Avatar updated');
    } catch (e) { showToast('Upload failed'); }
    closeAvatarCropper();
  }, 'image/jpeg', 0.92);
}

async function removeAvatar() {
  if (!_currentUser) return;
  try {
    await fetch(`/api/users/${_currentUser.id}/avatar`, { method: 'DELETE' });
    delete _currentUser.avatar;
    refreshAvatarEverywhere();
    renderAvatarPicker($('avatarPickerContainer'));
    showToast('Photo removed');
  } catch {}
}

async function selectEmojiAvatar(emoji) {
  if (!_currentUser) return;
  if (hasCustomAvatar(_currentUser)) {
    await fetch(`/api/users/${_currentUser.id}/avatar`, { method: 'DELETE' }).catch(() => {});
    delete _currentUser.avatar;
  }
  await fetch(`/api/users/${_currentUser.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji }),
  }).catch(() => {});
  _currentUser.emoji = emoji;
  refreshAvatarEverywhere();
  renderAvatarPicker($('avatarPickerContainer'));
}

function refreshAvatarEverywhere() {
  const user = _currentUser;
  if (!user) return;
  const btn = $('stripUserBtn');
  const emojiEl = $('stripUserEmoji');
  if (hasCustomAvatar(user)) {
    emojiEl.innerHTML = `<img src="${user.avatar}?t=${Date.now()}" alt="">`;
    btn.style.background = 'transparent';
  } else {
    emojiEl.textContent = user.emoji ?? '🧑';
    btn.style.background = user.color ?? 'var(--bg3)';
  }
}
