// Classification alone never authorizes replaying tools or other side effects.
export function isTransientProviderError(error) {
  if (!error || error.retryable === false || error.providerUpdateNoReplay === true || error.name === 'AbortError') return false;
  const codes = [error.code, error.providerCode, error.cause?.code].filter(Boolean).map(String);
  const message = String(error.message || '');
  if (codes.some(code => /^(?:ENOSPC|EACCES|EROFS|EIO|SESSION_CLEARED)$/i.test(code))
      || /persist|storage|session.*(?:clear|write|save)|(?:write|save).*session/i.test(`${codes.join(' ')} ${message}`)) return false;
  const status = Number(error.status ?? error.statusCode);
  if ([400, 401, 403, 404, 422].includes(status)
      || /\b(?:400|401|403|404|422|unauthorized|forbidden|invalid[_ ](?:api[_ ]?key|model)|insufficient_quota)\b/i.test(`${codes.join(' ')} ${message}`)) return false;
  return error.retryable === true
    || status === 408 || status === 429 || status >= 500 && status <= 599
    || codes.some(code => /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_.*|server_is_overloaded|server_error|service_unavailable|rate_limit_exceeded)$/i.test(code))
    || /\b(?:408|429|5\d{2}|timeout|timed out|rate[_ ]limit|overloaded(?:_error)?|fetch failed|network error|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_\w+)\b/i.test(message);
}
