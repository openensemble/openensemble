import { loadOwnedInputImage } from '../skills/image_generator/execute.mjs';

export function isImageEditRequest(text) {
  return /\b(?:edit|modify|change|expand|extend|outpaint|recolor|retouch|resize|make|turn)\b/i.test(text)
    && /\b(?:images?|pictures?|photos?|portrait|illustration|full.body|head.to.toe|background|foreground|outfit|hair|lighting|colors?|blue|red|green|black|white)\b/i.test(text);
}

/** Restore one exact source image only for an authorized edit continuation. */
export function imageEditContext(userId, userText, rows) {
  if (!isImageEditRequest(userText)) return null;
  const explicit = userText.match(/\bimages:([^\s/\\<>"'`]+\.(?:png|jpe?g|webp|gif))\b/i)?.[0];
  let id = explicit;
  if (!id) {
    for (const row of [...rows].reverse()) {
      const images = [row?.image, ...(Array.isArray(row?.images) ? row.images : []),
        ...(Array.isArray(row?.attachments) ? row.attachments : [])].filter(Boolean);
      for (const image of [...images].reverse()) {
        const saved = image.savedPath ?? image.file_id;
        if (typeof saved === 'string' && saved.startsWith('images:')) id = saved;
        else if (typeof image.filename === 'string') id = `images:${image.filename}`;
        if (id) break;
      }
      if (id) break;
    }
  }
  if (!id) return null;
  try {
    const dataUrl = loadOwnedInputImage(userId, id);
    const comma = dataUrl.indexOf(',');
    return {
      attachment: { file_id: id, name: id, mimeType: dataUrl.slice(5, dataUrl.indexOf(';')),
        base64: dataUrl.slice(comma + 1) },
      note: `Source image for this edit: ${id}. Edit the attached original and preserve its identity.`,
    };
  } catch {
    return { attachment: null, note: `The source image ${id} could not be loaded for this edit. Ask the user to attach it again; do not claim a new image is an edit of that original.` };
  }
}
