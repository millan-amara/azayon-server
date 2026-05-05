// Broadcast a realtime event to everyone in the current org's socket room.
// Safe to call without io being available (no-ops during tests / missing setup).
//
// Payload always carries `actor` (the userId that caused the event) so clients
// can skip self-invalidation and avoid clobbering optimistic updates.
function emitToOrg(req, event, payload = {}) {
  const io = req.app?.get('io');
  if (!io || !req.orgId) return;
  io.to(`org_${req.orgId}`).emit(event, {
    ...payload,
    actor: req.user?._id?.toString() || null,
    at: Date.now(),
  });
}

module.exports = { emitToOrg };
