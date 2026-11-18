'use strict';

// Credentials, setup keys and recovery codes live only in the current page.
// No enrollment URI is sent to a QR service or stored in browser storage.
(() => {
  const byId = id => document.getElementById(id);
  const base = '/api/admin/owner';
  const authPanel = byId('ownerSignIn'), nav = byId('ownerNavigation');
  const account = byId('ownerAccountPanel'), audit = byId('ownerAuditPanel');
  const codesPanel = byId('ownerRecoveryCodesPanel');
  const login = byId('ownerLoginForm'), verify = byId('ownerVerifyForm');
  const enroll = byId('ownerEnrollment'), recovery = byId('ownerRecoveryForm');
  const actions = {
    dispatch_sign_in: 'Dispatch sign-in', dispatch_logout: 'Dispatch sign-out',
    reservation_status_update: 'Trip status changed', driver_assignment_update: 'Driver assignment changed',
    reservation_cancellation: 'Reservation cancelled', payment_recheck: 'Payment recheck',
    financial_csv_export: 'Financial CSV export', owner_provisioned: 'Owner account provisioned',
    owner_mfa_enrollment: 'Authenticator enrolled', owner_recovery: 'Account recovery',
    owner_sessions_revoked: 'Other sessions signed out', owner_emergency_recovery: 'Emergency recovery',
    owner_recovery_codes: 'Recovery codes replaced'
  };
  const outcomes = {succeeded: 'Succeeded', completed: 'Completed', unchanged: 'Unchanged',
    denied: 'Denied', failed: 'Failed', interrupted: 'Interrupted'};
  const dateFormat = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York',
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'});
  let enabled = false, owner = null, bridge, serial = 0, view = 'reservations', completingSignIn = false;
  let auditCursor = null, auditQuery = '', auditBusy = false, savedHidden = null, afterCodes;
  const operational = () => ['businessAnalytics', 'tvPanel', 'adminReviews', 'reservationRequestsPanel',
    'reservationFilters', 'bookings', 'moreBookings'].map(byId);
  const formatDate = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? dateFormat.format(date) : 'Not available';
  };
  function status(id, message, error = false) {
    const element = byId(id);element.textContent = message;element.dataset.error = String(error);
  }
  function clearSecrets() {
    for (const element of document.querySelectorAll('#ownerSignIn input, #ownerSecurityForm input')) element.value = '';
    byId('ownerSetupKey').textContent = '';
    byId('ownerRecoveryCodes').textContent = '';
    codesPanel.hidden = true;afterCodes = null;
  }
  function authStep(step) {
    login.hidden = step !== 'login';verify.hidden = step !== 'mfa';
    enroll.hidden = step !== 'enroll';recovery.hidden = step !== 'recover';
    byId('ownerShowRecovery').hidden = step === 'recover' || step === 'enroll';
    status('ownerAuthStatus', '');
  }
  async function request(path, body, authenticatedCall = false) {
    const response = await fetch(base + path, {method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', headers: {'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    let data;
    try {data = await response.json();} catch (_) {throw new Error('Dispatch is temporarily unavailable. Please try again.');}
    if (!response.ok) {
      if (response.status === 401 && authenticatedCall) bridge?.onSignedOut();
      throw new Error(typeof data.error === 'string' ? data.error : 'The request could not be completed.');
    }
    return data;
  }
  async function busy(form, statusId, work) {
    const generation = serial;
    const buttons = [...form.querySelectorAll('button')];buttons.forEach(button => button.disabled = true);
    status(statusId, 'Working…');
    try {await work(generation);} catch (error) {if (generation === serial) status(statusId, error.message, true);}
    finally {buttons.forEach(button => button.disabled = false);}
  }
  function showCodes(codes, next) {
    byId('ownerRecoveryCodes').textContent = codes.join('\n');
    codesPanel.hidden = false;afterCodes = next;
    account.hidden = true;audit.hidden = true;authPanel.hidden = true;
    operational().forEach(element => element.hidden = true);
    byId('ownerRecoveryCodesHeading').focus();
  }
  async function authenticated(profile) {
    owner = profile;
    clearSecrets();authPanel.hidden = true;
    completingSignIn = true;
    try {await bridge.onAuthenticated(profile);} finally {completingSignIn = false;}
    setAuthenticated(true);
    selectView('reservations', false);
  }
  async function beginEnrollment(generation) {
    const data = await request('/enrollment/start', {});
    if (generation !== serial) return;
    authStep('enroll');byId('ownerSetupKey').textContent = data.secret;
    byId('ownerEnrollCode').focus();
  }
  function setAuthenticated(value) {
    if (!enabled) return;
    if (!value) {
      serial++;owner = null;savedHidden = null;auditCursor = null;auditBusy = false;
      clearSecrets();byId('ownerAuditList').replaceChildren();byId('ownerSessionList').replaceChildren();
      byId('ownerIdentity').textContent = '';byId('ownerAccountIdentity').textContent = '';
      status('ownerGlobalStatus', '');
      nav.hidden = true;account.hidden = true;audit.hidden = true;authPanel.hidden = false;
      byId('ownerAuditFilters').reset();byId('ownerAuditMore').hidden = true;
      document.querySelector('main > .wrap').classList.remove('owner-layout');
      authStep('login');return;
    }
    if (!owner || completingSignIn) return;
    authPanel.hidden = true;nav.hidden = false;
    byId('ownerIdentity').textContent = owner.name + ' · Owner';
    byId('ownerAccountIdentity').textContent = owner.name + ' · ' + owner.email;
    document.querySelector('main > .wrap').classList.add('owner-layout');
  }
  async function selectView(next, focus = true) {
    if (!owner) return;
    if (view === 'reservations' && next !== 'reservations') savedHidden = operational().map(element => element.hidden);
    view = next;clearSecrets();authPanel.hidden = true;
    document.querySelector('main > .wrap').dataset.ownerView = next;
    account.hidden = next !== 'account';audit.hidden = next !== 'audit';
    operational().forEach((element, index) => {element.hidden = next === 'reservations' ? (savedHidden?.[index] ?? element.hidden) : true;});
    if (next === 'reports') {byId('businessAnalytics').hidden = false;byId('businessAnalytics').open = true;}
    for (const button of nav.querySelectorAll('[data-owner-view]')) {
      if (button.dataset.ownerView === next) button.setAttribute('aria-current', 'page');else button.removeAttribute('aria-current');
    }
    if (next === 'account') {if (focus) byId('ownerAccountHeading').focus();await sessions();}
    if (next === 'audit') {if (focus) byId('ownerAuditHeading').focus();await loadAudit(false);}
  }
  async function sessions() {
    const generation = serial;status('ownerAccountStatus', 'Loading sessions…');
    try {
      const data = await request('/sessions', undefined, true);
      if (generation !== serial || !owner) return;
      const entries = data.sessions.map(session => {
        const item = document.createElement('li'), title = document.createElement('strong'), dates = document.createElement('small');
        title.textContent = session.current ? 'This session' : 'Other signed-in session';
        dates.textContent = 'Signed in ' + formatDate(session.createdAt) + ' · Last active ' + formatDate(session.lastSeenAt) + ' · Expires ' + formatDate(session.expiresAt);
        item.append(title, dates);return item;
      });
      byId('ownerSessionList').replaceChildren(...entries);status('ownerAccountStatus', 'Showing ' + entries.length + ' active session' + (entries.length === 1 ? '' : 's') + ' (up to 50).');
    } catch (error) {if (generation === serial) status('ownerAccountStatus', error.message, true);}
  }
  function label(value) {return String(value || '').replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());}
  function renderAudit(events, append) {
    const list = byId('ownerAuditList');
    if (!append) list.replaceChildren();
    let table = list.querySelector('table');
    if (!table && events.length) {
      table = document.createElement('table');table.className = 'owner-audit-table';
      const caption = document.createElement('caption');caption.className = 'owner-muted';caption.textContent = 'Dispatch security activity';
      const head = document.createElement('thead'), row = document.createElement('tr');
      for (const text of ['Time', 'Staff member', 'Action', 'Result']) {const th = document.createElement('th');th.scope = 'col';th.textContent = text;row.append(th);}
      head.append(row);table.append(caption, head, document.createElement('tbody'));list.append(table);
    }
    for (const entry of events) {
      const row = document.createElement('tr');row.dataset.auditEventId = entry.id;
      const values = [formatDate(entry.timestamp), entry.staffName || (entry.staffId ? 'Owner account' : entry.actorId ? 'Shared-credential session' : 'Unidentified'), actions[entry.action] || label(entry.action), outcomes[entry.outcome] || label(entry.outcome)];
      values.forEach((text, index) => {
        const cell = document.createElement('td');cell.dataset.label = ['Time', 'Staff member', 'Action', 'Result'][index];
        const content = document.createElement(index === 3 ? 'span' : 'div');content.textContent = text;
        if (index === 3) {content.className = 'owner-result';content.dataset.outcome = entry.outcome;}
        cell.append(content);
        if (index === 2 && (entry.recordId || entry.referenceId)) {
          const details = document.createElement('details'), summary = document.createElement('summary');
          details.className = 'owner-audit-details';summary.textContent = 'References';details.append(summary);
          for (const [name, value] of [['Record', entry.recordId], ['Request', entry.referenceId]]) if (value) {
            const reference = document.createElement('p');reference.textContent = name + ': ' + value;details.append(reference);
          }
          cell.append(details);
        }
        row.append(cell);
      });table.querySelector('tbody').append(row);
    }
    if (!table) list.textContent = 'No activity matches these filters.';
  }
  async function loadAudit(more) {
    if (auditBusy || !owner) return;
    auditBusy = true;const generation = serial;
    const controls = [...byId('ownerAuditFilters').elements];controls.forEach(control => control.disabled = true);
    byId('ownerAuditMore').disabled = true;status('ownerAuditStatus', 'Loading activity…');
    try {
      if (!more) {
        byId('ownerAuditList').replaceChildren();
        const query = new URLSearchParams({limit: '25'});
        const staff = byId('ownerAuditStaff').value;
        if (staff === 'owner') query.set('staffId', owner.id);
        for (const [key, id] of [['action', 'ownerAuditAction'], ['from', 'ownerAuditFrom'], ['to', 'ownerAuditTo']]) {
          const value = byId(id).value;if (value) query.set(key, value);
        }
        auditQuery = query.toString();auditCursor = null;
      }
      const data = await request('/audit?' + auditQuery + (more && auditCursor ? '&cursor=' + encodeURIComponent(auditCursor) : ''), undefined, true);
      if (generation !== serial || !owner) return;
      renderAudit(data.events, more);auditCursor = data.nextCursor || null;
      byId('ownerAuditMore').hidden = !auditCursor;
      byId('ownerAuditCoverage').textContent = data.coverageStartedAt ? 'Stored activity begins ' + formatDate(data.coverageStartedAt) + '. Earlier operational logs are not imported.' : 'No stored activity is available yet. Earlier operational logs are not imported.';
      status('ownerAuditStatus', 'Activity loaded.');
    } catch (error) {if (generation === serial) status('ownerAuditStatus', error.message, true);}
    finally {auditBusy = false;byId('ownerAuditMore').disabled = false;controls.forEach(control => control.disabled = false);}
  }
  login.addEventListener('submit', event => {
    event.preventDefault();const body = {email: byId('ownerEmail').value, password: byId('ownerPassword').value};
    byId('ownerPassword').value = '';
    busy(login, 'ownerAuthStatus', async generation => {
      const data = await request('/login', body);if (generation !== serial) return;
      if (data.step === 'enroll') await beginEnrollment(generation);
      else {authStep('mfa');byId('ownerCode').focus();}
    });
  });
  verify.addEventListener('submit', event => {
    event.preventDefault();const code = byId('ownerCode').value;byId('ownerCode').value = '';
    busy(verify, 'ownerAuthStatus', async generation => {
      const data = await request('/verify', {code});if (generation === serial) await authenticated(data.owner);
    });
  });
  byId('ownerEnrollForm').addEventListener('submit', event => {
    event.preventDefault();const code = byId('ownerEnrollCode').value;byId('ownerEnrollCode').value = '';
    busy(event.currentTarget, 'ownerAuthStatus', async generation => {
      const data = await request('/enrollment/confirm', {code});if (generation !== serial) return;
      owner = data.owner;byId('ownerSetupKey').textContent = '';
      showCodes(data.recoveryCodes, () => authenticated(data.owner));
    });
  });
  recovery.addEventListener('submit', event => {
    event.preventDefault();const body = {email: byId('ownerRecoveryEmail').value,
      password: byId('ownerRecoveryPassword').value, recoveryCode: byId('ownerRecoveryCode').value};
    byId('ownerRecoveryPassword').value = '';byId('ownerRecoveryCode').value = '';
    busy(recovery, 'ownerAuthStatus', async generation => {await request('/recover', body);if (generation === serial) await beginEnrollment(generation);});
  });
  byId('ownerShowRecovery').addEventListener('click', () => {clearSecrets();authStep('recover');byId('ownerRecoveryEmail').focus();});
  for (const id of ['ownerCancelRecovery', 'ownerRestartLogin']) byId(id).addEventListener('click', () => {
    clearSecrets();
    void busy(authPanel, 'ownerAuthStatus', async () => {
      try {await request('/logout', {});} catch (_) {throw new Error('Could not cancel sign-in. Please try again.');}
      authStep('login');byId('ownerEmail').focus();
    });
  });
  byId('ownerSecurityForm').addEventListener('submit', event => {
    event.preventDefault();const action = event.submitter?.value;
    const body = {password: byId('ownerCurrentPassword').value, code: byId('ownerCurrentCode').value};
    byId('ownerCurrentPassword').value = '';byId('ownerCurrentCode').value = '';
    busy(event.currentTarget, 'ownerAccountStatus', async generation => {
      const data = await request(action === 'codes' ? '/recovery-codes' : '/sessions/revoke-others', body, true);
      if (generation !== serial) return;
      if (action === 'codes') showCodes(data.recoveryCodes, () => selectView('account'));
      else {await sessions();status('ownerAccountStatus', 'Other sessions have been signed out. This session remains active.');}
    });
  });
  byId('ownerDismissCodes').addEventListener('click', () => {
    const next = afterCodes;byId('ownerRecoveryCodes').textContent = '';codesPanel.hidden = true;afterCodes = null;
    if (next) void next();
  });
  byId('ownerRefreshSessions').addEventListener('click', sessions);
  nav.addEventListener('click', event => {const button = event.target.closest('[data-owner-view]');if (button) void selectView(button.dataset.ownerView);});
  byId('ownerAuditFilters').addEventListener('submit', event => {event.preventDefault();void loadAudit(false);});
  byId('ownerAuditMore').addEventListener('click', () => loadAudit(true));
  byId('ownerSignOut').addEventListener('click', () => bridge?.onLogout());
  for (const [value, text] of Object.entries(actions)) {
    const option = document.createElement('option');option.value = value;option.textContent = text;byId('ownerAuditAction').append(option);
  }
  window.addEventListener('pagehide', () => {serial++;clearSecrets();byId('ownerAuditList').replaceChildren();byId('ownerSessionList').replaceChildren();});
  window.erDispatchOwner = {
    get enabled() {return enabled;}, setAuthenticated,
    async initialize(options) {
      bridge = options;
      try {
        const config = await request('/config');enabled = config.enabled === true;
        byId('legacyAdminCard').hidden = enabled;
        if (!enabled) return false;
        setAuthenticated(false);
        try {const data = await request('/session');await authenticated(data.owner);} catch (_) {authStep('login');}
      } catch (_) {
        // Do not silently fall back to the shared credential if mode lookup fails.
        byId('legacyAdminCard').hidden = true;authPanel.hidden = false;
        login.hidden = true;byId('ownerShowRecovery').hidden = true;
        status('ownerAuthStatus', 'Sign-in is temporarily unavailable. Reload to try again.', true);
      }
      return true;
    },
    async logout() {
      clearSecrets();
      try {await request('/logout', {}, false);setAuthenticated(false);}
      catch (error) {status('ownerGlobalStatus', 'Sign-out could not be confirmed. Please try again.', true);throw error;}
    }
  };
})();
