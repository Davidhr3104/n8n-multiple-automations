// Determinístico: decide si una llamada HTTP fallida se reintenta y cuánto esperar (backoff exponencial con jitter).
// n8n solo trae espera fija por nodo; el crecimiento exponencial lo da el bucle Check → Wait → reintento.
function statusOf(error) {
  const raw = error.httpCode ?? error.status ?? (error.cause && error.cause.status) ?? (error.response && error.response.status);
  if (raw !== undefined && raw !== null && !Number.isNaN(Number(raw))) return Number(raw);
  const m = /^\s*(\d{3})\b/.exec(String(error.message || ''));
  return m ? Number(m[1]) : null;
}

// attempt = número (1-based) del intento que acaba de terminar.
function retryDecision(resp, attempt, opts = {}) {
  const { maxAttempts = 4, baseSeconds = 2, capSeconds = 60, random = Math.random } = opts;

  const isNil = resp === undefined || resp === null;
  if (!isNil && !resp.error) return { retry: false, failed: false, exhausted: false, status: null, delay_s: 0, attempt, reason: 'ok' };

  const error = isNil ? { message: 'empty response' } : (typeof resp.error === 'object' ? resp.error : { message: String(resp.error) });
  const status = statusOf(error);
  const retryable = status === null || status === 408 || status === 425 || status === 429 || status >= 500;

  if (!retryable) return { retry: false, failed: true, exhausted: false, status, delay_s: 0, attempt, reason: `non-retryable status ${status}` };
  if (attempt >= maxAttempts) return { retry: false, failed: true, exhausted: true, status, delay_s: 0, attempt, reason: `retries exhausted after ${attempt} attempts (status ${status ?? 'network'})` };

  const exp = Math.min(capSeconds, baseSeconds * 2 ** (attempt - 1));
  const delay_s = Math.round(exp * (0.5 + 0.5 * random()) * 10) / 10;
  return { retry: true, failed: false, exhausted: false, status, delay_s, attempt, reason: `retryable status ${status ?? 'network'}` };
}

module.exports = { retryDecision };
