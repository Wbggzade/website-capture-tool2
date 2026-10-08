export class CaptureError extends Error {
  constructor(code, message, status = 'failed', details = {}) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

export function normalizeOperationError(error) {
  if (error instanceof CaptureError) return error;
  if (error?.name === 'TimeoutError') return new CaptureError('OPERATION_TIMEOUT', 'A browser operation timed out.');
  if (error?.name === 'TargetClosedError' || error?.name === 'BrowserClosedError') {
    return new CaptureError('BROWSER_CRASHED', 'The capture browser closed unexpectedly.');
  }
  return new CaptureError('JOB_ITEM_FAILED', 'The capture item failed; sensitive exception details were not recorded.');
}

export function isRetryableFailure(code) {
  return code === 'NAVIGATION_FAILED' || code === 'CONTENT_NOT_READY' ||
    code === 'OPERATION_TIMEOUT' || code === 'BROWSER_CRASHED' || code === 'HTTP_408' ||
    code === 'HTTP_429' || /^HTTP_5\d\d$/.test(code) || code === 'CAPTURE_EXPLORATION_FAILED';
}

// Do not serialize browser/network exception text: it may contain secret URLs.
export function publicError(error) {
  return error instanceof CaptureError
    ? { code: error.code, message: error.message, status: error.status, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) }
    : { code: 'UNEXPECTED_ERROR', message: 'Unexpected operation failure; no sensitive exception text was recorded.', status: 'failed' };
}
