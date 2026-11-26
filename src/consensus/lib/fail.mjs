export function refuse(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.refusal = true;
  err.extra = extra;
  throw err;
}

export function internal(message, cause) {
  const err = new Error(message);
  err.internal = true;
  if (cause) err.cause = cause;
  throw err;
}

export function isRefuse(err) {
  return Boolean(err && err.refusal);
}
