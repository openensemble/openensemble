export const REASON_TASK_TOKENS = Object.freeze({
  salience: '<salience>', contradiction: '<contradiction>', signals: '<signals>',
  friction: '<friction>', summary: '<summary>', relevance: '<relevance>',
});

export function reasonTaskInput(user, task) {
  const text = String(user ?? '');
  const token = REASON_TASK_TOKENS[task];
  return token && !text.startsWith(token) ? `${token} ${text}` : text;
}

export function isTrainedReasonModel(model) {
  return /^openensemble-reason-v\d+(?:[.\w-]*)?(?::[\w.-]+)?$/i.test(String(model || ''));
}
