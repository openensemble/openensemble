/** Canonical values for Cortex soft-delete and restore transitions. */
export function softForgetValues(at = new Date()) {
  const forgottenAt = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(forgottenAt.getTime())) throw new Error('Invalid forgotten timestamp');
  return { forgotten: true, forgotten_at: forgottenAt.toISOString() };
}

export function restoreForgottenValues() {
  return { forgotten: false, forgotten_at: '' };
}
