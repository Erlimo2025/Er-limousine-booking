'use strict';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const outcomes = Object.freeze({
  dispatch_sign_in: ['succeeded', 'failed', 'denied'],
  dispatch_logout: ['succeeded', 'unchanged', 'failed', 'denied'],
  reservation_status_update: ['succeeded', 'unchanged', 'failed', 'denied'],
  driver_assignment_update: ['succeeded', 'unchanged', 'failed', 'denied'],
  reservation_cancellation: ['succeeded', 'unchanged', 'failed', 'denied'],
  payment_recheck: ['completed', 'failed', 'denied'],
  financial_csv_export: ['completed', 'failed', 'interrupted', 'denied'],
  owner_mfa_enrollment: ['succeeded', 'failed', 'denied'],
  owner_recovery: ['succeeded', 'failed', 'denied'],
  owner_recovery_codes: ['succeeded', 'failed', 'denied'],
  owner_sessions_revoked: ['succeeded', 'failed', 'denied'],
  owner_emergency_recovery: ['succeeded', 'failed', 'denied'],
  owner_provisioned: ['succeeded', 'failed', 'denied']
});

// The actor is a server-owned login-session UUID, not a named staff identity or
// a bearer credential. Never serialize request bodies, URLs or error objects.
function createDispatchSecurityLogger({write = line => console.error(line), now = Date.now} = {}) {
  return function emit(req, action, outcome, options = {}) {
    try {
      if (typeof action !== 'string' || typeof outcome !== 'string' ||
          !Object.hasOwn(outcomes, action) || !outcomes[action].includes(outcome) ||
          typeof req?.referenceId !== 'string' || req.referenceId.length !== 36 || !uuid.test(req.referenceId)) return false;
      const entry = {timestamp: new Date(now()).toISOString(), referenceId: req.referenceId.toLowerCase(),
        operation: 'admin', category: 'dispatch_security', action, outcome};
      const actorId = options.actorId ?? req.adminArchiveAuthority?.actorId;
      const staffId = options.staffId ?? req.adminArchiveAuthority?.staffId ?? req.dispatchOwner?.id;
      if (typeof staffId === 'string' && staffId.length === 36 && uuid.test(staffId)) entry.staffId = staffId.toLowerCase();
      if (typeof actorId === 'string' && actorId.length === 36 && uuid.test(actorId)) entry.actorId = actorId.toLowerCase();
      if (typeof options.recordId === 'string' && options.recordId.length === 36 && uuid.test(options.recordId)) entry.recordId = options.recordId.toLowerCase();
      const result = write(JSON.stringify(entry));
      // A logging sink must not change an already persisted business action.
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  };
}

module.exports = {createDispatchSecurityLogger};
