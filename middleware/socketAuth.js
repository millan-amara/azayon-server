const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Tiny cookie-header parser so we don't take a direct dep on the `cookie`
// package (it ships transitively under cookie-parser, but we can't rely on it).
function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// Authenticate every Socket.io connection using the same JWT the HTTP API uses.
// Without this, the previous `socket.on('join_org', orgId => socket.join(...))`
// handler let any unauthenticated client subscribe to any org's notifications,
// deal updates, etc. — leaking real-time data across tenants.
//
// Token sources (first match wins):
//   1. socket.handshake.auth.token        (recommended — set by client `io({ auth: { token } })`)
//   2. socket.handshake.headers.authorization 'Bearer <token>'
//   3. accessToken cookie (auto-sent for browser clients on the same origin)
function attachSocketAuth(io) {
  io.use(async (socket, next) => {
    try {
      let token = socket.handshake.auth?.token;

      if (!token) {
        const authHeader = socket.handshake.headers?.authorization;
        if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
      }

      if (!token) {
        const parsed = parseCookieHeader(socket.handshake.headers?.cookie);
        token = parsed.accessToken;
      }

      if (!token || typeof token !== 'string') {
        return next(new Error('Unauthorised'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('_id orgId isActive');
      if (!user || !user.isActive) return next(new Error('Unauthorised'));

      socket.user = { _id: user._id.toString(), orgId: user.orgId.toString() };
      next();
    } catch (err) {
      next(new Error('Unauthorised'));
    }
  });
}

module.exports = { attachSocketAuth };
