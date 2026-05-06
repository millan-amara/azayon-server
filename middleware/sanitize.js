// Strip MongoDB operator keys ($-prefixed) and dotted keys from incoming
// request bodies / query strings / params. Without this, a payload like
// `{ email: { $gt: "" } }` to /login would bypass authentication, and
// `{ token: { $ne: null } }` to /reset-password would let an attacker
// claim any user with a non-null reset token.
//
// We mutate in place rather than reassigning req.query (Express 5 makes
// req.query a getter on some routes), and recurse through arrays + objects
// so nested payloads (e.g. import rows) are also scrubbed.
function sanitizeInPlace(obj) {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) sanitizeInPlace(item);
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
      continue;
    }
    sanitizeInPlace(obj[key]);
  }
}

const sanitizeRequest = (req, _res, next) => {
  if (req.body) sanitizeInPlace(req.body);
  if (req.params) sanitizeInPlace(req.params);
  // req.query in Express 5 is a getter — mutate keys without reassigning the object
  if (req.query) sanitizeInPlace(req.query);
  next();
};

module.exports = { sanitizeRequest, sanitizeInPlace };
