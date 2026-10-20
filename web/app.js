/* knode-os web UI — vanilla JS, no build step */
'use strict';

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  // X-Knode-CSRF: a page on another site cannot send it, so the server knows a write came from this one
  const headers = { 'content-type': 'application/json', 'x-knode-csrf': '1', ...workspaceRequestHeaders(), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.reason === 'auth') sessionEnded(data.error);
    const error = new Error(data.error || res.statusText);
    // the machine-readable cause, when a route sends one: a screen can act on
    // it instead of parsing the prose
    if (data.reason) error.reason = data.reason;
    throw error;
  }
  return data;
};
const toast = (msg, ms = 2600) => {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Markdown someone else wrote, as HTML that carries formatting only: no raw HTML, no script links (web/markdown.js). */
const renderMd = (s) => (window.knodeMarkdown ? window.knodeMarkdown.render(s) : `<pre>${esc(s)}</pre>`);

/* --------------------------- auth & workspaces ------------------------- */

/**
 * Sign-in belongs to the server (src/auth): a browser holds an HttpOnly
 * session cookie, so nothing secret lives in this page. Storage keeps only
 * which workspaces you had open (`authState`); who you are and what you may
 * use (`serverAuth`) comes from the server on every load.
 */
const AUTH_KEY = 'knode-os.auth.v1';
let authState = null;
/** The server's view of the session: account, groups usable here, teams, gateways. */
let serverAuth = null;
/** Sign-in is off on this server (development): any username, no password. */
let authDisabled = false;
let pendingUser = null;
let pendingPersistence = 'local';
let statsTimer = null;
let sessionEndedShown = false;

const initials = (value) => {
  const parts = String(value || 'You').trim().split(/[\s@._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0].slice(0, 2)).toUpperCase();
};

const nameFromUsername = (username) => String(username)
  .split(/[._-]+/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ') || 'Your account';

const normalizeUsername = (username) => String(username || '').trim().toLowerCase();

function readAuthState() {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const parsed = JSON.parse(storage.getItem(AUTH_KEY) || 'null');
      if ((parsed?.user?.username || parsed?.user?.email) && Array.isArray(parsed.workspaces) && parsed.activeWorkspaceId) return parsed;
    } catch { /* storage may be unavailable or stale */ }
  }
  return null;
}

function saveAuthState() {
  if (!authState) return;
  const target = authState.persistence === 'session' ? sessionStorage : localStorage;
  const other = target === localStorage ? sessionStorage : localStorage;
  try {
    target.setItem(AUTH_KEY, JSON.stringify(authState));
    other.removeItem(AUTH_KEY);
  } catch { /* keep the current in-memory session */ }
}

function forgetAuthState() {
  try { localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY); } catch { /* no-op */ }
}

function showAuthStep(step) {
  document.querySelectorAll('.auth-step').forEach((el) => el.classList.remove('active'));
  $(`#auth-${step}`).classList.add('active');
}

function teamFromCode(rawCode) {
  let code = String(rawCode || '').trim();
  if (/^https?:\/\//i.test(code)) {
    try { code = new URL(code).pathname.split('/').filter(Boolean).pop() || ''; } catch { /* use raw input */ }
  }
  code = code.replace(/[^a-z0-9-]/gi, '').toUpperCase();
  if (code.replace(/-/g, '').length < 3) return null;
  const words = code.split('-').filter(Boolean);
  const name = words.map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ') || 'Shared Team';
  return { id: `team-${code.toLowerCase()}`, name, kind: 'team', code };
}

function personalWorkspace() {
  return { id: 'default', name: 'Default', kind: 'personal' };
}

function workspaceLabel(workspace) {
  return workspace?.name || 'Workspace';
}

/** The Teams the server says this account may open. */
function serverTeams() {
  return (serverAuth?.teams || []).map((team) => ({ id: team.id, name: team.name, kind: 'team', code: String(team.slug || '').toUpperCase() }));
}

/** Members keep only the Teams they were given; an administrator may keep any Team joined by code. */
function allowedTeams(teams) {
  const account = serverAuth?.account;
  const given = serverTeams();
  const open = authDisabled || !account || account.role === 'admin' || account.teams?.includes('*');
  const kept = open ? teams : teams.filter((team) => given.some((g) => g.id === team.id));
  return [...kept, ...given].filter((team, i, all) => all.findIndex((t) => t.id === team.id) === i);
}

function completeLogin(activeWorkspace, extraWorkspaces = []) {
  const user = pendingUser;
  if (!user) return;
  const personal = personalWorkspace();
  authState = {
    user,
    persistence: pendingPersistence,
    workspaces: [personal, ...allowedTeams(extraWorkspaces)],
    activeWorkspaceId: activeWorkspace.id,
  };
  saveAuthState();
  $('#login-password').value = '';
  pendingUser = null;
  enterApp();
}

function activeWorkspace() {
  return authState?.workspaces.find((workspace) => workspace.id === authState.activeWorkspaceId) || authState?.workspaces[0];
}

function workspaceRequestHeaders() {
  if (!authState?.user) return {};
  const workspace = activeWorkspace();
  const username = normalizeUsername(authState.user.username || authState.user.email);
  if (!username || !workspace) return {};
  // the server acts for the signed-in account; the user header only matters with sign-in off
  return {
    'x-knode-user': username,
    'x-knode-workspace-kind': workspace.kind,
    'x-knode-workspace-id': workspace.id,
    'x-knode-workspace-name': workspace.name,
  };
}

async function syncUserWorkspaces() {
  if (!authState?.user) return;
  const previous = activeWorkspace();
  const owned = await api('/api/workspaces');
  const teams = allowedTeams(authState.workspaces.filter((workspace) => workspace.kind === 'team'));
  authState.workspaces = [...owned, ...teams];
  if (!authState.workspaces.some((workspace) => workspace.id === authState.activeWorkspaceId)) {
    authState.activeWorkspaceId = owned[0]?.id || teams[0]?.id;
  }
  saveAuthState();
  if (previous?.id !== activeWorkspace()?.id) renderWorkspaceUI();
}

function renderWorkspaceUI() {
  if (!authState) return;
  const workspace = activeWorkspace();
  const user = authState.user;
  const userInitials = initials(user.name || user.username || user.email);
  const workspaceInitials = workspace.kind === 'personal' ? userInitials : initials(workspace.name);
  const personal = workspace.kind === 'personal';

  $('#workspace-avatar').textContent = workspaceInitials;
  $('#workspace-avatar').classList.toggle('team', !personal);
  $('#workspace-name').textContent = workspaceLabel(workspace);
  $('#workspace-kind').textContent = personal ? 'Private workspace' : 'Team workspace';
  $('#context-name').textContent = workspaceLabel(workspace);
  $('#context-description').textContent = personal
    ? 'Only you can access this knowledge.'
    : 'Knowledge in this view is shared with your Team.';
  $('#cfg-workspace-name').textContent = personal ? workspace.name : `${workspace.name} Team workspace`;
  $('#clear-workspace-name').textContent = workspaceLabel(workspace);
  $('#workspace-context').classList.toggle('team', !personal);
  $('#account-avatar').textContent = userInitials;
  $('#account-name').textContent = user.name;
  const role = serverAuth?.account?.role === 'admin' ? ' · administrator' : '';
  $('#account-email').textContent = user.username ? `@${user.username}${role}` : user.email;
  document.body.dataset.workspace = workspace.kind;
  document.body.dataset.role = serverAuth?.account?.role || 'member';

  const options = $('#workspace-options');
  options.innerHTML = '';
  for (const item of authState.workspaces) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `workspace-option${item.id === workspace.id ? ' active' : ''}`;
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `<span>${esc(initials(item.name))}</span><span><b>${esc(workspaceLabel(item))}</b><small>${item.kind === 'personal' ? 'Private to you' : 'Shared Team knowledge'}</small></span>`;
    button.addEventListener('click', () => switchWorkspace(item.id));
    options.appendChild(button);
  }
}

function closeWorkspaceMenu() {
  $('#workspace-menu').hidden = true;
  $('#workspace-trigger').setAttribute('aria-expanded', 'false');
}

function switchWorkspace(id) {
  if (!authState || !authState.workspaces.some((workspace) => workspace.id === id)) return;
  authState.activeWorkspaceId = id;
  saveAuthState();
  renderWorkspaceUI();
  closeWorkspaceMenu();
  loadWorkspaceData();
  toast(`Switched to ${workspaceLabel(activeWorkspace())}`);
}

function joinTeam(code, fromOnboarding = false) {
  const team = teamFromCode(code);
  if (!team) return { error: 'Enter a valid Team code or invite link.' };
  const account = serverAuth?.account;
  if (!authDisabled && account && account.role !== 'admin' && !account.teams?.includes('*') && !serverTeams().some((t) => t.id === team.id)) {
    return { error: `Your account has not been given ${team.name} — ask an administrator.` };
  }
  if (fromOnboarding) {
    completeLogin(team, [team]);
    return { team };
  }
  const existing = authState.workspaces.find((workspace) => workspace.id === team.id);
  if (!existing) authState.workspaces.push(team);
  authState.activeWorkspaceId = (existing || team).id;
  saveAuthState();
  renderWorkspaceUI();
  loadWorkspaceData();
  toast(`Joined ${team.name}`);
  return { team: existing || team };
}

function loadWorkspaceData() {
  currentFile = null;
  editing = false;
  treeData = null;
  selectedDir = null;
  expandedDirs.clear();
  expandedDirs.add('wiki');
  loadedConfig = null;
  resetGraph();
  $('#filetree').innerHTML = '';
  $('#file-path').textContent = '';
  $('#file-view').hidden = false;
  $('#file-view').innerHTML = '';
  $('#file-editor').hidden = true;
  $('#file-editor').value = '';
  $('#btn-edit').textContent = 'edit';
  $('#btn-edit').disabled = true;
  $('#btn-save').disabled = true;
  $('#btn-delete').disabled = true;
  $('#search-results').innerHTML = '';
  $('#graph-side').innerHTML = '';
  resetEntities();
  $('#traces-table tbody').innerHTML = '';
  $('#suggestions').innerHTML = '';
  $('#cfg-status').innerHTML = '';
  loadStats();
  loadTree().then(() => openFile('wiki/index.md')).catch(() => {});

  // reload whatever the current host view shows — one list, so it cannot drift
  // out of sync with what navigate() loads on arrival
  TAB_LOAD[hostOf(currentTab)]?.();
}

function startAppData() {
  if (!statsTimer) statsTimer = setInterval(loadStats, 15000);
  loadWorkspaceData();
}

function stopAppData() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  stopChatPolling();
}

function enterApp() {
  sessionEndedShown = false;
  $('#auth-view').hidden = true;
  $('#app-shell').hidden = false;
  // paints the header, the strip and the visible section from one source
  navigate(restoreNav());
  renderWorkspaceUI();
  syncUserWorkspaces()
    .catch((error) => toast(`Could not sync workspaces: ${error.message}`, 5000))
    .finally(() => {
      renderWorkspaceUI();
      startAppData();
    });
}

function showAuthView() {
  stopAppData();
  closeWorkspaceMenu();
  $('#app-shell').hidden = true;
  $('#auth-view').hidden = false;
}

function showLogin(note = '') {
  showAuthView();
  showAuthStep('login');
  $('#login-form').reset();
  $('#login-remember').checked = true;
  $('#login-password').type = 'password';
  $('#btn-toggle-password').textContent = 'Show';
  $('#login-error').textContent = '';
  const message = note || (authDisabled ? 'Sign-in is off on this server (development): any username works, no password.' : '');
  $('#login-note').textContent = message;
  $('#login-note').hidden = !message;
  const last = readAuthState()?.user?.username;
  if (last) $('#login-username').value = last;
  setTimeout(() => (last ? $('#login-password') : $('#login-username')).focus(), 0);
}

/** A request came back 401: the session is over (expired, signed out elsewhere, password changed). */
function sessionEnded(message) {
  if (sessionEndedShown || authDisabled) return;
  sessionEndedShown = true;
  serverAuth = null;
  showLogin(message && !/^sign in first$/i.test(message) ? `${message.charAt(0).toUpperCase()}${message.slice(1)}.` : 'Your session ended — sign in again.');
}

function continueToWorkspaceChoice(user, persistence) {
  pendingUser = user;
  pendingPersistence = persistence;
  $('#personal-choice-avatar').textContent = initials(user.name || user.username);
  $('#onboarding-team-form').reset();
  $('#onboarding-team-error').textContent = '';
  showAuthStep('workspaces');
}

/** The server accepted us: back to the workspaces this browser had open for the same user, or choose. */
function signedIn(view, persistence) {
  serverAuth = view;
  const account = view.account;
  const user = { username: account.username, name: account.name || nameFromUsername(account.username) };
  const stored = readAuthState();
  if (stored && normalizeUsername(stored.user?.username) === account.username) {
    authState = { ...stored, user, persistence };
    authState.workspaces = [
      ...authState.workspaces.filter((workspace) => workspace.kind === 'personal'),
      ...allowedTeams(authState.workspaces.filter((workspace) => workspace.kind === 'team')),
    ];
    if (!authState.workspaces.some((workspace) => workspace.id === authState.activeWorkspaceId)) authState.activeWorkspaceId = personalWorkspace().id;
    saveAuthState();
    enterApp();
    return;
  }
  // someone else signed in on this browser: their workspaces are not ours
  forgetAuthState();
  continueToWorkspaceChoice(user, persistence);
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = normalizeUsername($('#login-username').value);
  const password = $('#login-password').value;
  const remember = $('#login-remember').checked;
  if (!username) {
    $('#login-error').textContent = 'Enter your username.';
    $('#login-username').focus();
    return;
  }
  if (authDisabled) {
    signedIn({ account: { username, name: nameFromUsername(username), role: 'admin', teams: ['*'] }, teams: [] }, remember ? 'local' : 'session');
    return;
  }
  if (!password) {
    $('#login-error').textContent = 'Enter your password.';
    $('#login-password').focus();
    return;
  }
  const button = $('#btn-login');
  button.disabled = true;
  try {
    const view = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, remember }) });
    $('#login-error').textContent = '';
    $('#login-note').hidden = true;
    signedIn(view, remember ? 'local' : 'session');
  } catch (error) {
    $('#login-error').textContent = error.reason === 'setup' ? 'This server has no accounts yet.' : `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`;
    $('#login-password').select();
  } finally {
    button.disabled = false;
  }
});

$('#btn-toggle-password').addEventListener('click', () => {
  const password = $('#login-password');
  const reveal = password.type === 'password';
  password.type = reveal ? 'text' : 'password';
  $('#btn-toggle-password').textContent = reveal ? 'Hide' : 'Show';
});

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = normalizeUsername($('#setup-username').value);
  const password = $('#setup-password').value;
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(username)) {
    $('#setup-error').textContent = 'Use up to 32 lower-case letters, digits, dots, dashes or underscores.';
    $('#setup-username').focus();
    return;
  }
  if (password.length < 8) {
    $('#setup-error').textContent = 'Passwords need at least 8 characters.';
    $('#setup-password').focus();
    return;
  }
  if (password !== $('#setup-confirm').value) {
    $('#setup-error').textContent = 'The passwords do not match.';
    $('#setup-confirm').focus();
    return;
  }
  try {
    const view = await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username, password, name: nameFromUsername(username) }) });
    $('#setup-error').textContent = '';
    $('#setup-form').reset();
    signedIn(view, 'local');
  } catch (error) {
    $('#setup-error').textContent = error.message;
  }
});

$('#btn-nosetup-retry').addEventListener('click', () => bootAuth());

$('#btn-auth-back').addEventListener('click', () => showAuthStep('login'));
$('#btn-use-personal').addEventListener('click', () => pendingUser && completeLogin(personalWorkspace()));

$('#onboarding-team-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const result = joinTeam($('#onboarding-team-code').value, true);
  $('#onboarding-team-error').textContent = result.error || '';
});

$('#workspace-trigger').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = $('#workspace-menu');
  menu.hidden = !menu.hidden;
  $('#workspace-trigger').setAttribute('aria-expanded', String(!menu.hidden));
});

$('#workspace-menu').addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', closeWorkspaceMenu);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeWorkspaceMenu();
    if ($('#join-team-dialog').open) $('#join-team-dialog').close();
    if ($('#create-workspace-dialog').open) $('#create-workspace-dialog').close();
    if ($('#clear-workspace-dialog').open) $('#clear-workspace-dialog').close();
    if ($('#user-dialog').open) $('#user-dialog').close();
  }
});

$('#btn-open-create-workspace').addEventListener('click', () => {
  closeWorkspaceMenu();
  $('#create-workspace-form').reset();
  $('#create-workspace-error').textContent = '';
  $('#create-workspace-dialog').showModal();
  setTimeout(() => $('#create-workspace-name').focus(), 0);
});

$('#btn-cancel-create-workspace').addEventListener('click', () => $('#create-workspace-dialog').close());
$('#create-workspace-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#create-workspace-name').value.trim();
  if (!name) {
    $('#create-workspace-error').textContent = 'Enter a workspace name.';
    return;
  }
  try {
    const workspace = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    authState.workspaces = [
      ...authState.workspaces.filter((item) => item.id !== workspace.id),
      workspace,
    ];
    authState.activeWorkspaceId = workspace.id;
    saveAuthState();
    $('#create-workspace-dialog').close();
    renderWorkspaceUI();
    loadWorkspaceData();
    toast(`Created ${workspace.name}`);
  } catch (error) {
    $('#create-workspace-error').textContent = error.message;
  }
});

$('#btn-open-join-team').addEventListener('click', () => {
  closeWorkspaceMenu();
  $('#join-team-form').reset();
  $('#join-team-error').textContent = '';
  $('#join-team-dialog').showModal();
  setTimeout(() => $('#join-team-code').focus(), 0);
});

$('#btn-cancel-join-team').addEventListener('click', () => $('#join-team-dialog').close());
$('#join-team-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const result = joinTeam($('#join-team-code').value);
  $('#join-team-error').textContent = result.error || '';
  if (!result.error) $('#join-team-dialog').close();
});

$('#btn-open-access').addEventListener('click', () => {
  closeWorkspaceMenu();
  navigate('access');
});

$('#btn-sign-out').addEventListener('click', async () => {
  closeWorkspaceMenu();
  if (!authDisabled) {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* signed out here either way */ }
  }
  forgetAuthState();
  authState = null;
  serverAuth = null;
  pendingUser = null;
  showLogin();
});

async function bootAuth() {
  let state;
  try {
    state = await api('/api/auth/state');
  } catch (error) {
    showLogin(`The server did not answer: ${error.message}`);
    return;
  }
  authDisabled = state.auth === false;
  if (authDisabled) {
    const stored = readAuthState();
    if (stored) {
      authState = stored;
      serverAuth = { account: { username: stored.user.username, name: stored.user.name, role: 'admin', teams: ['*'] }, teams: [] };
      enterApp();
    } else showLogin();
    return;
  }
  if (state.signedIn) {
    signedIn(state, readAuthState()?.persistence || 'local');
    return;
  }
  if (state.setupRequired) {
    showAuthView();
    showAuthStep(state.canSetup ? 'setup' : 'nosetup');
    if (state.canSetup) setTimeout(() => $('#setup-username').focus(), 0);
    return;
  }
  showLogin();
}

/* ----------------------------- navigation ------------------------------- */

/**
 * Two levels: a section in the header, its tabs in the strip below. The
 * grouping follows what you do with a file rather than what the service
 * implements — material comes in (Library), you ask about it (Ask), knowledge
 * grows out of it (Knowledge).
 */
const NAV = [
  { id: 'library', title: 'Library', tabs: [
    { id: 'files', title: 'Files', hint: 'Browse and edit knowledge' },
    { id: 'search', title: 'Search', hint: 'Hybrid, vector, and keyword recall' },
    { id: 'traces', title: 'Traces', hint: 'Claude Code and Codex sessions' },
  ] },
  { id: 'ask', title: 'Ask', tabs: [{ id: 'ask', title: 'Ask', hint: 'An agent that answers from your workspace' }] },
  { id: 'knowledge', title: 'Knowledge', tabs: [
    { id: 'graph', title: 'Graph', hint: 'Entities, relations, and claims' },
    { id: 'entities', title: 'Entities', hint: 'Every entity, filtered and sorted' },
    { id: 'wiki', title: 'Wiki', hint: 'Pages researched by agent CLIs' },
    { id: 'dream', title: 'Dream', hint: 'Review agent improvement ideas' },
  ] },
  // Settings in the order knowledge moves: processed as it comes in (Ingest),
  // researched into the wiki (Research), used to answer (Ask). Ids keep their
  // first names, so `pipeline` is titled Ingest; Ask's settings are `chat`, the
  // config block they edit, because `ask` is the Ask view itself.
  { id: 'settings', title: 'Settings', tabs: [
    { id: 'providers', title: 'Providers & Agents', hint: 'Endpoints, credentials, and who does the work' },
    { id: 'pipeline', title: 'Ingest', hint: 'How documents get processed' },
    { id: 'research', title: 'Research', hint: 'How the wiki gets written' },
    { id: 'chat', title: 'Ask', hint: 'How questions get answered' },
    { id: 'workspace', title: 'Workspace', hint: 'Clear this workspace' },
    { id: 'access', title: 'Access', hint: 'Your account; users and gateways of this server' },
  ] },
];

/**
 * Which `<section class="tab">` shows a tab. Settings' five tabs share one
 * host: keying identity and loaders on the leaf instead would re-run
 * `loadConfigForm()` on every sub-tab click and throw away unsaved routes.
 */
const TAB_HOST = { providers: 'settings', pipeline: 'settings', research: 'settings', chat: 'settings', workspace: 'settings' };
const hostOf = (tab) => TAB_HOST[tab] ?? tab;

/**
 * Tabs that used to exist, so a stored navigation still lands somewhere.
 * `agents` was folded into `providers`: an agent runs on a provider from the
 * table above it, and the two were never separable but in the tab strip.
 */
const NAV_ALIAS = { agents: 'providers' };
const aliasOf = (tab) => NAV_ALIAS[tab] ?? tab;

/** What a host view loads when you arrive at it. */
const TAB_LOAD = {
  search: () => paintSearchScope(),
  traces: () => loadTraces(),
  dream: () => loadSuggestions(),
  wiki: () => loadResearch(),
  ask: () => loadChat(),
  settings: () => loadConfigForm(),
  access: () => loadAccess(),
  // the box may hold a name another view put there (exploreEntity): arrival runs it
  graph: () => { if (!graphState.loaded) loadGraph($('#graph-q').value.trim()); },
  entities: () => loadEntities(),
};

const NAV_KEY = 'knode-os.nav.v1';
const sectionOf = (tab) => NAV.find((s) => s.tabs.some((t) => t.id === tab));
let currentTab = 'files';
const lastTab = Object.fromEntries(NAV.map((s) => [s.id, s.tabs[0].id]));

function restoreNav() {
  try {
    const saved = JSON.parse(localStorage.getItem(NAV_KEY) ?? '{}');
    for (const [section, raw] of Object.entries(saved.lastTab ?? {})) {
      const tab = aliasOf(raw);
      if (sectionOf(tab)?.id === section) lastTab[section] = tab;
    }
    // these ids will move again; an unknown one just means the default
    const tab = aliasOf(saved.tab);
    return sectionOf(tab) ? tab : currentTab;
  } catch {
    return currentTab;
  }
}

function persistNav() {
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify({ tab: currentTab, lastTab }));
  } catch {
    /* private window, blocked storage — navigation still works, it just forgets */
  }
}

function renderSubtabs(section) {
  const el = $('#subtabs');
  // one tab is not a choice: Ask renders no strip at all
  el.innerHTML = section.tabs.length < 2 ? '' : section.tabs
    .map((t) => `<button type="button" data-tab="${t.id}" title="${esc(t.hint)}"${t.id === currentTab ? ' class="active"' : ''}>${esc(t.title)}</button>`)
    .join('');
}

/**
 * Search's scope follows the folder picked in the file tree — the reason the
 * two live in the same section. `sources` is a path prefix the API already
 * takes, so this is a filter, not a second kind of search.
 */
function paintSearchScope() {
  const select = $('#search-scope');
  const dir = selectedDir;
  const previous = select.value;
  select.innerHTML = '<option value="">whole base</option>'
    + ['raw/docs', 'raw/traces', 'wiki', ...(dir && !['raw/docs', 'raw/traces', 'wiki'].includes(dir) ? [dir] : [])]
      .map((d) => `<option value="${esc(d)}">${esc(d)}/</option>`).join('');
  select.value = [...select.options].some((o) => o.value === previous) ? previous : '';
}

/** The only way to change tabs. */
function navigate(tab) {
  const section = sectionOf(tab);
  if (!section) return;
  const previousHost = hostOf(currentTab);
  const host = hostOf(tab);
  currentTab = tab;
  lastTab[section.id] = tab;
  persistNav();

  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.section === section.id);
  renderSubtabs(section);
  for (const el of document.querySelectorAll('.tab')) el.classList.toggle('active', el.id === `tab-${host}`);
  for (const el of document.querySelectorAll('.settings-section[data-subtab]')) el.hidden = el.dataset.subtab !== tab;

  // leaving Ask stops its polling — as its own statement, not as the `else` of
  // an unrelated `if`, which is how this used to silently fire everywhere
  if (previousHost === 'ask' && host !== 'ask') stopChatPolling();
  if (host !== previousHost) TAB_LOAD[host]?.();
}

/** Picking a section returns to the tab it was left at, not to its first one. */
function navigateSection(id) {
  navigate(lastTab[id] ?? NAV.find((s) => s.id === id)?.tabs[0].id);
}

$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-section]');
  if (button) navigateSection(button.dataset.section);
});
$('#subtabs').addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-tab]');
  if (button) navigate(button.dataset.tab);
});

/* ------------------------------- access -------------------------------- */

/**
 * Account & access: your password and sessions, and — for an administrator —
 * the users of this server and the local services it publishes under /gw.
 * Everything goes through /api/auth, and the server enforces all of it; this
 * page only draws what it is told.
 */

const API_GROUP_LABELS = {
  files: 'Files', search: 'Search', ask: 'Ask', knowledge: 'Knowledge', ingest: 'Ingest',
  traces: 'Traces', datasources: 'Datasources', settings: 'Settings', gateway: 'Gateways',
};
const MEMBER_REMOTE_DEFAULT = ['files', 'search', 'ask', 'knowledge', 'ingest', 'traces'];
let accessUsers = null;
let editingUser = null;

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const csvList = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);

async function loadAccess() {
  const admin = document.querySelectorAll('.admin-only');
  if (authDisabled) {
    $('#access-summary').textContent = 'Sign-in is off on this server (development): there are no accounts here.';
    admin.forEach((el) => { el.hidden = true; });
    return;
  }
  try {
    const me = await api('/api/auth/me');
    serverAuth = { ...serverAuth, ...me };
    renderAccount(me);
    renderSessions(await api('/api/auth/sessions'));
    const isAdmin = me.account.role === 'admin' && me.groups?.settings;
    admin.forEach((el) => { el.hidden = !isAdmin; });
    if (isAdmin) await loadAdmin();
  } catch (error) {
    toast(`Could not load access: ${error.message}`, 5000);
  }
}

function renderAccount(me) {
  const a = me.account;
  $('#access-summary').textContent = `Signed in as ${a.name || a.username} (@${a.username}), ${me.local ? 'on this machine' : 'from another machine'}.`;
  $('#access-role').textContent = a.role === 'admin' ? 'administrator' : 'member';
  $('#access-groups').innerHTML = Object.entries(me.groups || {})
    .map(([group, ok]) => `<span class="access-chip${ok ? ' ok' : ''}" title="${esc(me.apiGroups?.[group] || '')}">${ok ? '✓' : '✕'} ${esc(API_GROUP_LABELS[group] || group)}</span>`)
    .join('');
  const gateways = me.gateways || [];
  $('#access-gateways-mine').innerHTML = gateways.length
    ? `<div class="cfg-card-title"><b>Gateways you may use</b></div>${gateways.map((g) => `<p class="hint"><a href="${esc(g.path)}" target="_blank" rel="noopener">${esc(g.path)}</a> ${esc(g.description)}</p>`).join('')}`
    : '';
}

function renderSessions(list) {
  $('#access-sessions').innerHTML = list.map((s) => `<div class="access-row">
      <span><b>${esc(s.label)}</b>${s.current ? ' <span class="section-badge">this one</span>' : ''}<small>${esc(s.kind)} · since ${esc(when(s.createdAt))} · last used ${esc(when(s.lastSeenAt))}${s.ip ? ` · ${esc(s.ip)}` : ''}</small></span>
      ${s.current ? '' : `<button type="button" class="ghost" data-end-session="${esc(s.id)}">End</button>`}
    </div>`).join('') || '<p class="hint">No sessions.</p>';
}

$('#access-sessions').addEventListener('click', async (event) => {
  const id = event.target.closest?.('[data-end-session]')?.dataset.endSession;
  if (!id) return;
  try {
    await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    loadAccess();
  } catch (error) {
    toast(error.message);
  }
});

$('#btn-signout-others').addEventListener('click', async () => {
  try {
    await api('/api/auth/signout-others', { method: 'POST', body: '{}' });
    toast('Signed out everywhere else');
    loadAccess();
  } catch (error) {
    toast(error.message);
  }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const current = $('#password-current').value;
  const password = $('#password-new').value;
  if (password.length < 8) {
    $('#password-error').textContent = 'Passwords need at least 8 characters.';
    return;
  }
  if (password !== $('#password-confirm').value) {
    $('#password-error').textContent = 'The new passwords do not match.';
    return;
  }
  try {
    // the answer carries a new session cookie: this browser stays signed in, every other session ends
    await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current, password }) });
    $('#password-form').reset();
    $('#password-error').textContent = '';
    toast('Password changed — your other sessions have ended');
    loadAccess();
  } catch (error) {
    $('#password-error').textContent = error.message;
  }
});

async function loadAdmin() {
  const [users, gateways] = await Promise.all([api('/api/auth/users'), api('/api/auth/gateways')]);
  accessUsers = users;
  renderUsers(users);
  renderGateways(gateways);
}

function renderUsers(data) {
  const me = serverAuth?.account?.username;
  $('#access-users').innerHTML = data.users.map((u) => `<tr${u.disabled ? ' class="disabled"' : ''}>
      <td><b>${esc(u.username)}</b>${u.name && u.name !== u.username ? `<small>${esc(u.name)}</small>` : ''}${u.disabled ? '<small class="bad">disabled</small>' : ''}</td>
      <td>${u.role === 'admin' ? 'administrator' : 'member'}</td>
      <td>${u.role === 'admin' ? 'all' : esc(u.teams.join(', ') || '—')}</td>
      <td>${u.remoteApis.includes('*') ? 'everything' : esc(u.remoteApis.map((g) => API_GROUP_LABELS[g] || g).join(', ') || 'nothing')}</td>
      <td>${u.role === 'admin' ? 'all' : esc(u.gateways.join(', ') || '—')}</td>
      <td>${u.sessions.count}${u.sessions.lastSeenAt ? `<small>${esc(when(u.sessions.lastSeenAt))}</small>` : ''}</td>
      <td class="row-actions"><button type="button" class="ghost" data-edit-user="${esc(u.username)}">Edit</button>${u.username === me || !u.sessions.count ? '' : `<button type="button" class="ghost" data-signout-user="${esc(u.username)}">Sign out</button>`}</td>
    </tr>`).join('');
}

function renderRemoteChecks(selected, groups) {
  const all = selected.includes('*');
  $('#user-remote-apis').innerHTML = `<label class="check-row"><input type="checkbox" id="user-remote-all"${all ? ' checked' : ''} /> Everything the role allows</label>`
    + Object.entries(groups).map(([group, description]) => `<label class="check-row" title="${esc(description)}"><input type="checkbox" data-group="${esc(group)}"${all || selected.includes(group) ? ' checked' : ''}${all ? ' disabled' : ''} /> ${esc(API_GROUP_LABELS[group] || group)}</label>`).join('');
}

$('#user-remote-apis').addEventListener('change', (event) => {
  if (event.target.id !== 'user-remote-all') return;
  for (const box of document.querySelectorAll('#user-remote-apis input[data-group]')) {
    box.disabled = event.target.checked;
    if (event.target.checked) box.checked = true;
  }
});

function openUserDialog(username) {
  const u = username ? accessUsers?.users.find((x) => x.username === username) : null;
  editingUser = u?.username || null;
  const self = Boolean(u && u.username === serverAuth?.account?.username);
  $('#user-dialog-title').textContent = u ? `Edit ${u.username}` : 'Add a user';
  $('#user-dialog-hint').textContent = self
    ? 'Your own password, role and sign-in are changed under Account, or by another administrator.'
    : 'They sign in with this username and password, here or from the other machines you allow.';
  $('#user-username').value = u?.username || '';
  $('#user-username').disabled = Boolean(u);
  $('#user-name').value = u?.name || '';
  $('#user-password').value = '';
  $('#user-password-label').textContent = u ? 'New password (empty keeps the current one)' : 'Password';
  $('#user-password').disabled = self;
  $('#user-role').value = u?.role || 'member';
  $('#user-role').disabled = self;
  $('#user-teams').value = (u?.teams || []).join(', ');
  $('#user-gateways').value = (u?.gateways || []).join(', ');
  $('#user-disabled').checked = Boolean(u?.disabled);
  $('#user-disabled-row').hidden = !u || self;
  renderRemoteChecks(u ? u.remoteApis : MEMBER_REMOTE_DEFAULT, accessUsers?.apiGroups || {});
  $('#btn-delete-user').hidden = !u || self;
  $('#user-error').textContent = '';
  $('#user-dialog').showModal();
  setTimeout(() => (u ? $('#user-name') : $('#user-username')).focus(), 0);
}

$('#btn-add-user').addEventListener('click', () => openUserDialog(null));
$('#btn-cancel-user').addEventListener('click', () => $('#user-dialog').close());

$('#access-users').addEventListener('click', async (event) => {
  const edit = event.target.closest?.('[data-edit-user]')?.dataset.editUser;
  if (edit) {
    openUserDialog(edit);
    return;
  }
  const signout = event.target.closest?.('[data-signout-user]')?.dataset.signoutUser;
  if (!signout || !confirm(`End every session of ${signout}? They sign in again with their password.`)) return;
  try {
    const { ended } = await api(`/api/auth/users/${encodeURIComponent(signout)}/signout`, { method: 'POST', body: '{}' });
    toast(`${signout}: ${ended} session${ended === 1 ? '' : 's'} ended`);
    loadAdmin();
  } catch (error) {
    toast(error.message);
  }
});

$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const all = $('#user-remote-all')?.checked;
  const remoteApis = all ? ['*'] : [...document.querySelectorAll('#user-remote-apis input[data-group]:checked')].map((box) => box.dataset.group);
  const body = {
    name: $('#user-name').value.trim(),
    role: $('#user-role').value,
    teams: csvList($('#user-teams').value),
    gateways: csvList($('#user-gateways').value),
    remoteApis,
  };
  const password = $('#user-password').value;
  try {
    if (editingUser) {
      const self = editingUser === serverAuth?.account?.username;
      if (self) delete body.role;
      else body.disabled = $('#user-disabled').checked;
      if (password && !self) {
        if (password.length < 8) throw new Error('Passwords need at least 8 characters.');
        body.password = password;
      }
      await api(`/api/auth/users/${encodeURIComponent(editingUser)}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast(`Saved ${editingUser}${body.password || body.disabled ? ' — their sessions ended' : ''}`);
    } else {
      if (password.length < 8) throw new Error('Passwords need at least 8 characters.');
      const created = await api('/api/auth/users', { method: 'POST', body: JSON.stringify({ ...body, username: normalizeUsername($('#user-username').value), password }) });
      toast(`Created ${created.username}`);
    }
    $('#user-dialog').close();
    loadAdmin();
  } catch (error) {
    $('#user-error').textContent = error.message;
  }
});

$('#btn-delete-user').addEventListener('click', async () => {
  if (!editingUser || !confirm(`Remove ${editingUser}? Their workspaces stay on disk under users/${editingUser}.`)) return;
  try {
    await api(`/api/auth/users/${encodeURIComponent(editingUser)}`, { method: 'DELETE' });
    $('#user-dialog').close();
    toast(`Removed ${editingUser}`);
    loadAdmin();
  } catch (error) {
    $('#user-error').textContent = error.message;
  }
});

function renderGateways(list) {
  $('#access-gateways').innerHTML = list.map((g) => `<tr>
      <td class="mono">${esc(g.id)}</td>
      <td class="mono">${esc(g.target)}${g.sandbox === false ? ' <small class="bad">unsandboxed</small>' : ''}</td>
      <td>${esc(g.description || '')}</td>
      <td class="row-actions"><a class="ghost" href="/gw/${encodeURIComponent(g.id)}/" target="_blank" rel="noopener">Open</a><button type="button" class="ghost" data-remove-gateway="${esc(g.id)}">Remove</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">No gateways yet.</td></tr>';
}

$('#gateway-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    id: $('#gateway-id').value.trim().toLowerCase(),
    target: $('#gateway-target').value.trim(),
    description: $('#gateway-description').value.trim(),
    sandbox: $('#gateway-sandbox').checked,
  };
  try {
    await api('/api/auth/gateways', { method: 'POST', body: JSON.stringify(body) });
    $('#gateway-form').reset();
    $('#gateway-sandbox').checked = true;
    $('#gateway-error').textContent = '';
    toast(`Published /gw/${body.id}/`);
    loadAdmin();
  } catch (error) {
    $('#gateway-error').textContent = error.message;
  }
});

$('#access-gateways').addEventListener('click', async (event) => {
  const id = event.target.closest?.('[data-remove-gateway]')?.dataset.removeGateway;
  if (!id || !confirm(`Stop publishing /gw/${id}/?`)) return;
  try {
    await api(`/api/auth/gateways/${encodeURIComponent(id)}`, { method: 'DELETE' });
    loadAdmin();
  } catch (error) {
    toast(error.message);
  }
});

/* ------------------------------- stats --------------------------------- */

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#statsbar').textContent =
      `${s.documents} docs · ${s.chunks} chunks · ${s.entities} entities · ${s.relations} rels · ${s.traces} traces` +
      (s.pending_suggestions ? ` · ☾${s.pending_suggestions}` : '');
  } catch { /* server still starting */ }
  loadProcessing();
}

/* ----------------------------- processing ------------------------------ */

/**
 * Extraction, reviews and summaries spend model calls, so the service never
 * starts them on its own, not even after a restart: someone starts them here
 * (or in the app) and they run until stopped. An administrator's switch.
 */
let processingStatus = null;

async function loadProcessing() {
  try {
    processingStatus = await api('/api/labeling/status');
  } catch {
    processingStatus = null;
  }
  paintProcessing();
}

function paintProcessing() {
  const button = $('#processing-toggle');
  const state = processingStatus?.processing;
  button.hidden = !state;
  if (!state) return;
  const mayChange = authDisabled || serverAuth?.groups?.settings === true;
  const queued = processingStatus.scheduler?.queued;
  const due = processingStatus.summaries?.due;
  button.classList.toggle('running', state.running);
  button.textContent = state.running ? '● Processing' : '▶ Start processing';
  button.disabled = !mayChange;
  button.title = [
    state.running ? 'Extraction, reviews and summaries are running — click to stop' : 'Extraction, reviews and summaries wait until someone starts them',
    queued === undefined ? '' : `${queued} documents waiting`,
    due ? `${due} summaries due` : '',
    state.by && state.since ? `${state.running ? 'started' : 'stopped'} by ${state.by} at ${new Date(state.since).toLocaleTimeString()}` : '',
    mayChange ? '' : 'an administrator starts and stops processing',
  ].filter(Boolean).join(' · ');
}

$('#processing-toggle').addEventListener('click', async () => {
  const running = processingStatus?.processing?.running === true;
  if (running && !confirm('Stop processing? Calls in flight finish; nothing new starts until someone starts it again.')) return;
  try {
    await api(running ? '/api/labeling/stop' : '/api/labeling/start', { method: 'POST', body: '{}' });
    toast(running ? 'Processing stopped — calls in flight finish' : 'Processing started: extraction, reviews and summaries');
  } catch (error) {
    toast(error.message, 5000);
  }
  loadProcessing();
});

/* ------------------------------- menus --------------------------------- */

/** One floating menu at a time — the tree's right-click and the pane's own buttons share it. */
function showMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'popup-menu';
  // a click inside must reach its own button, never the dismisser on document
  menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
  for (const item of items) {
    if (item === '-') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    if (item.danger) button.classList.add('danger');
    if (item.disabled) button.disabled = true;
    else button.addEventListener('click', () => { closeMenu(); item.run(); });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - box.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - box.height - 6))}px`;
  // registered a tick later, so the click that opened the menu cannot close it
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('contextmenu', closeMenu);
    window.addEventListener('keydown', onMenuKey);
    window.addEventListener('resize', closeMenu);
  }, 0);
}

function closeMenu() {
  document.querySelector('.popup-menu')?.remove();
  document.removeEventListener('click', closeMenu);
  document.removeEventListener('contextmenu', closeMenu);
  window.removeEventListener('keydown', onMenuKey);
  window.removeEventListener('resize', closeMenu);
}

function onMenuKey(ev) {
  if (ev.key === 'Escape') closeMenu();
}

function showMenuUnder(anchor, items) {
  const box = anchor.getBoundingClientRect();
  showMenu(box.left, box.bottom + 4, items);
}

/* ------------------------------- files --------------------------------- */

let currentFile = null;
let editing = false;
let treeData = null;
/** The folder clicked in the tree — where new items and uploads land. */
let selectedDir = null;
/** Folders left open, kept across reloads so something just created stays in view. */
const expandedDirs = new Set(['wiki']);
/** Linked folders in the tree: mirror path → the folder on this Mac it is mirrored from. Filled by loadTree. */
const linkedDests = new Map();
/** The folder on this Mac a path is mirrored from, or null — everything under a linked mirror is. */
function mirroredSource(path) {
  for (const [dest, source] of linkedDests) if (path === dest || path.startsWith(`${dest}/`)) return source;
  return null;
}
/** The last path typed into an import, offered again next time. */
let lastImportSource = '';

/** How many files and bytes go into one upload request — a folder can hold thousands. */
const UPLOAD_BATCH_FILES = 40;
const UPLOAD_BATCH_BYTES = 24 * 1024 * 1024;

const isWritable = (path) => /^(wiki|raw\/docs)(\/|$)/.test(path);
const parentDir = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseName = (path) => path.split('/').pop();

/** Where a create or an upload goes: the picked folder, else the open file's folder, else wiki. */
function targetDir() {
  if (selectedDir) return selectedDir;
  if (currentFile && parentDir(currentFile)) return parentDir(currentFile);
  return 'wiki';
}

/** The same folder, kept to one an upload may actually land in. */
const uploadTarget = () => (isWritable(targetDir()) ? targetDir() : 'raw/docs');

function nodeAt(path) {
  const find = (node) => {
    if (node.path === path) return node;
    if (node.path && !path.startsWith(`${node.path}/`)) return null;
    for (const child of node.children || []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  return treeData ? find(treeData) : null;
}

/** A default name nothing in the folder uses yet, so two creates cannot collide. */
function freeName(dir, base, ext = '') {
  const taken = new Set((nodeAt(dir)?.children || []).map((c) => c.name));
  let name = base + ext;
  for (let i = 2; taken.has(name); i += 1) name = `${base}-${i}${ext}`;
  return name;
}

const fileCount = (node) => (node.kind === 'file' ? 1 : (node.children || []).reduce((n, c) => n + fileCount(c), 0));

/** Reveal a path by opening it and every folder above it. */
function reveal(path) {
  const parts = path.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i += 1) expandedDirs.add(parts.slice(0, i).join('/'));
}

function renderTree(node, container) {
  if (!node.children) return;
  for (const child of node.children) {
    const div = document.createElement('div');
    div.className = child.kind === 'dir' ? 'tree-dir' : 'tree-file';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.dataset.path = child.path;
    div.appendChild(label);
    if (child.kind === 'dir') {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      renderTree(child, kids);
      div.appendChild(kids);
      if (!expandedDirs.has(child.path)) div.classList.add('collapsed');
      if (child.path === selectedDir) label.classList.add('picked');
      const paint = () => {
        label.textContent = `${div.classList.contains('collapsed') ? '▸' : '▾'} ${child.name}${child.linked ? ' 🔗' : ''}`;
      };
      if (child.linked) label.title = `linked to ${child.linked} — mirrored from there and kept in sync; edit the originals, not these copies`;
      paint();
      label.addEventListener('click', () => {
        // one click both picks the folder new items go into and opens it
        pickDir(child.path);
        div.classList.toggle('collapsed');
        if (div.classList.contains('collapsed')) expandedDirs.delete(child.path);
        else expandedDirs.add(child.path);
        paint();
      });
    } else {
      label.textContent = `· ${child.name}`;
      if (child.path === currentFile) label.classList.add('selected');
      label.addEventListener('click', () => openFile(child.path, label));
    }
    label.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      // the dismisser on document would otherwise close the menu we just opened
      ev.stopPropagation();
      showMenu(ev.clientX, ev.clientY, nodeMenu(child));
    });
    container.appendChild(div);
  }
}

/** What a right-click on a row offers, for that row — never for what is selected elsewhere. */
function nodeMenu(node) {
  const dir = node.kind === 'dir';
  // a linked folder's mirror is written by the link alone: nothing is created,
  // renamed, moved or deleted inside it from here
  const mirrored = mirroredSource(node.path);
  const linkRoot = dir && linkedDests.has(node.path);
  const movable = isWritable(node.path) && node.path !== 'wiki' && node.path !== 'raw/docs' && !mirrored;
  const items = [];
  if (dir && isWritable(node.path) && !mirrored) {
    items.push({ label: 'New file here…', run: () => { pickDir(node.path); newFile(node.path); } });
    items.push({ label: 'New folder here…', run: () => { pickDir(node.path); newFolder(node.path); } });
    items.push('-');
    items.push({ label: 'Upload files here…', run: () => { pickDir(node.path); pickUpload('files', node.path); } });
    items.push({ label: 'Upload folder here…', run: () => { pickDir(node.path); pickUpload('folder', node.path); } });
    if (/^raw\/docs(\/|$)/.test(node.path) && mayImportFolders()) {
      items.push('-');
      items.push({ label: 'Import folder from this Mac here…', run: () => { pickDir(node.path); importLocalFolder('copy', node.path); } });
      items.push({ label: 'Link folder from this Mac here…', run: () => { pickDir(node.path); importLocalFolder('link', node.path); } });
    }
    items.push('-');
  }
  if (linkRoot) {
    items.push({ label: 'Sync linked folder now', run: () => syncLinkedFolder(node.path) });
    items.push({ label: 'Unlink (keep the copies)…', run: () => unlinkFolderNode(node, false) });
    items.push({ label: 'Unlink and remove the copies…', danger: true, run: () => unlinkFolderNode(node, true) });
    items.push('-');
  }
  if (!dir) items.push({ label: 'Open', run: () => openFile(node.path) });
  items.push({ label: 'Copy path', run: () => copyPath(node.path) });
  if (movable) {
    items.push('-');
    items.push({ label: dir ? 'Rename folder…' : 'Rename…', run: () => renameNode(node) });
    items.push({ label: dir ? 'Move folder to…' : 'Move to…', run: () => moveNode(node) });
    items.push({ label: dir ? 'Delete folder…' : 'Delete…', danger: true, run: () => deleteNode(node) });
  }
  return items;
}

function pickDir(path) {
  selectedDir = path;
  paintSearchScope();
  document.querySelectorAll('#filetree .tree-label').forEach((el) => {
    el.classList.toggle('picked', el.parentElement.classList.contains('tree-dir') && el.dataset.path === path);
  });
  paintDestination();
}

function paintDestination() {
  const dir = targetDir();
  $('#tree-destination-path').textContent = `${dir}/`;
  $('#tree-destination-lock').hidden = isWritable(dir);
  $('#btn-clear-dir').hidden = !selectedDir;
}

async function loadTree() {
  treeData = await api('/api/tree');
  linkedDests.clear();
  const collect = (node) => {
    if (node.linked) linkedDests.set(node.path, node.linked);
    for (const child of node.children || []) collect(child);
  };
  collect(treeData);
  const el = $('#filetree');
  el.innerHTML = '';
  renderTree(treeData, el);
  paintDestination();
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    toast(`copied ${path}`);
  } catch {
    toast(path);
  }
}

async function newFile(dir) {
  const folder = isWritable(dir) ? dir : 'wiki';
  const suggested = `${folder}/${freeName(folder, 'new-note', '.md')}`;
  const path = prompt('New file path (under wiki/ or raw/docs/):', suggested);
  if (!path) return;
  if (!isWritable(path)) {
    toast('only wiki/ and raw/docs/ take new files');
    return;
  }
  try {
    const title = baseName(path).replace(/\.md$/, '').replace(/-/g, ' ');
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path, content: `# ${title}\n\n` }) });
    reveal(parentDir(path));
    await loadTree();
    openFile(path);
  } catch (e) {
    toast(`create failed: ${e.message}`);
  }
}

async function newFolder(dir) {
  const folder = isWritable(dir) ? dir : 'wiki';
  const suggested = `${folder}/${freeName(folder, 'new-folder')}`;
  const path = prompt('New folder path (under wiki/ or raw/docs/):', suggested);
  if (!path) return;
  if (!isWritable(path)) {
    toast('only wiki/ and raw/docs/ take new folders');
    return;
  }
  try {
    const created = await api('/api/mkdir', { method: 'POST', body: JSON.stringify({ path }) });
    reveal(created.path);
    await loadTree();
    pickDir(created.path);
    toast(`created ${created.path}/`);
  } catch (e) {
    toast(`create folder failed: ${e.message}`);
  }
}

async function renameNode(node) {
  const name = prompt(`Rename ${node.kind === 'dir' ? 'folder' : 'file'}:`, baseName(node.path));
  if (name === null) return;
  const clean = name.trim();
  if (!clean || clean === baseName(node.path)) return;
  if (clean.includes('/')) {
    toast('a name cannot contain "/" — use "move to…" instead');
    return;
  }
  const parent = parentDir(node.path);
  await moveSubtree(node.path, parent ? `${parent}/${clean}` : clean);
}

async function moveNode(node) {
  const answer = prompt(`Move ${baseName(node.path)} into which folder? (under wiki/ or raw/docs/)`, parentDir(node.path));
  if (answer === null) return;
  const dest = answer.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!isWritable(dest)) {
    toast('moves land under wiki/ or raw/docs/');
    return;
  }
  if (dest === parentDir(node.path)) {
    toast(`${baseName(node.path)} is already in ${dest}`);
    return;
  }
  // rename would fail halfway through a folder moved into itself
  if (node.kind === 'dir' && (dest === node.path || dest.startsWith(`${node.path}/`))) {
    toast('a folder cannot move inside itself');
    return;
  }
  await moveSubtree(node.path, `${dest}/${baseName(node.path)}`);
}

/**
 * The one path change behind rename and move.
 *
 * A path is the document's identity in the graph, so the knowledge only
 * catches up on the ingest that follows.
 */
async function moveSubtree(from, to) {
  try {
    await api('/api/mv', { method: 'POST', body: JSON.stringify({ from, to }) });
    const moved = (path) => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    if (currentFile) {
      currentFile = moved(currentFile);
      $('#file-path').textContent = currentFile;
    }
    if (selectedDir) selectedDir = moved(selectedDir);
    for (const dir of [...expandedDirs]) {
      if (dir !== moved(dir)) {
        expandedDirs.delete(dir);
        expandedDirs.add(moved(dir));
      }
    }
    reveal(parentDir(to));
    await loadTree();
  } catch (e) {
    toast(`move failed: ${e.message}`);
    return;
  }
  // the files are already where they belong — a failed re-index must not read
  // as a failed move
  toast(`moved to ${to} — re-indexing…`, 60000);
  try {
    const stats = await api('/api/ingest', { method: 'POST' });
    await loadTree();
    loadStats();
    toast(`move complete — ${stats.indexed} docs · ${stats.chunks} chunks re-indexed`);
  } catch (e) {
    toast(`moved to ${to}, re-index failed: ${e.message}`);
  }
}

async function deleteNode(node) {
  const files = fileCount(node);
  const question = node.kind === 'dir'
    ? `Delete ${node.path}/ and the ${files} file${files === 1 ? '' : 's'} inside it?`
    : `Delete ${node.path}?`;
  if (!confirm(question)) return;
  try {
    await api(`/api/file?path=${encodeURIComponent(node.path)}`, { method: 'DELETE' });
    forget(node.path);
    await loadTree();
    loadStats();
    toast(node.kind === 'dir' ? `deleted ${node.path}/ — ${files} file${files === 1 ? '' : 's'}` : `deleted ${node.path}`);
  } catch (e) {
    toast(`delete failed: ${e.message}`);
  }
}

/** Drop every reference to a path that is no longer on disk. */
function forget(path) {
  const gone = (candidate) => candidate === path || candidate.startsWith(`${path}/`);
  if (currentFile && gone(currentFile)) clearOpenFile();
  if (selectedDir && gone(selectedDir)) selectedDir = null;
  for (const dir of [...expandedDirs]) if (gone(dir)) expandedDirs.delete(dir);
}

function clearOpenFile() {
  currentFile = null;
  editing = false;
  $('#file-path').textContent = '';
  $('#file-view').innerHTML = '';
  $('#file-view').hidden = false;
  $('#file-editor').value = '';
  $('#file-editor').hidden = true;
  setFileNotice(null);
  $('#btn-edit').textContent = 'edit';
  $('#btn-edit').disabled = true;
  $('#btn-save').disabled = true;
  $('#btn-delete').disabled = true;
}

/** Mirrors MAX_PREVIEW_BYTES in the service — the cap on an unqualified read. */
const PREVIEW_BYTE_CAP = 256 * 1024;
/** Mirrors MAX_FILE_BYTES: the largest read the service serves, so the largest editable file. */
const EDIT_BYTE_CAP = 4 * 1024 * 1024;

/** Decimal units, matching what the macOS app's ByteCountFormatter prints. */
const fmtBytes = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);

/**
 * Why the open file cannot be edited — `{ text, canLoadFull }`, or null when it
 * can. A truncated preview must stay read-only: PUT /api/file overwrites the
 * whole file, so saving what the editor holds would silently drop everything
 * past the cap. `canLoadFull` says the whole file still fits in one read, so
 * the user can promote the preview to a real edit.
 */
function readOnlyNotice(derived, truncated, bytes, path = currentFile) {
  // The mirror of a linked folder follows its source: a save here would be
  // undone by the next sync (and the service refuses it).
  const mirrored = path ? mirroredSource(path) : null;
  if (mirrored) {
    return {
      text: `Mirrored from ${mirrored} — kept in sync with the original there, so it is read-only here. Edit the original instead.`,
      canLoadFull: false,
    };
  }
  // Derived text is knode-os's rendering of a PDF or image. It is read-only
  // whatever its size: writing it back would replace the original's bytes, so
  // this is checked before the size rule and never offers a full load.
  if (derived) {
    return {
      text: 'Derived Markdown — knode-os produced this from the original, so it is read-only. Replace the original by uploading a new copy.',
      canLoadFull: false,
    };
  }
  if (truncated) {
    const total = Number.isFinite(bytes) ? ` of ${fmtBytes(bytes)}` : '';
    const head = `Preview only — showing the first ${fmtBytes(PREVIEW_BYTE_CAP)}${total}.`;
    if (Number.isFinite(bytes) && bytes <= EDIT_BYTE_CAP) {
      return { text: `${head} Load the full file to edit it.`, canLoadFull: true };
    }
    return { text: `${head} Files over ${fmtBytes(EDIT_BYTE_CAP)} cannot be edited here.`, canLoadFull: false };
  }
  return null;
}

function setFileNotice(notice) {
  $('#file-notice').hidden = !notice;
  $('#file-notice-text').textContent = notice?.text ?? '';
  $('#btn-load-full').hidden = !notice?.canLoadFull;
}

/**
 * Re-read the open file without the preview cap so it can be edited. The
 * editor only ever holds a complete file — that is what makes a save safe.
 */
async function loadFullFile() {
  if (!currentFile) return;
  const path = currentFile;
  try {
    const { content, derived, truncated, bytes } = await api(`/api/file?path=${encodeURIComponent(path)}&maxBytes=${EDIT_BYTE_CAP}`);
    if (currentFile !== path) return; // the user moved on while this was in flight
    renderFileContent(path, content, derived, truncated, bytes);
    if (truncated) toast(`${path} is too large to edit here`);
  } catch (e) {
    toast(`load failed: ${e.message}`);
  }
}

/** Paint the file pane and decide, from this read alone, whether editing is allowed. */
function renderFileContent(path, content, derived, truncated, bytes) {
  // derived text (a PDF / image's Markdown) is knode-os's, not the user's: readable, never editable here
  $('#file-view').innerHTML = path.endsWith('.md') || derived ? renderMd(content) : `<pre>${esc(content)}</pre>`;
  $('#file-editor').value = content;
  const notice = readOnlyNotice(derived, truncated, bytes, path);
  setFileNotice(notice);
  $('#btn-edit').textContent = 'edit';
  $('#btn-edit').disabled = Boolean(notice);
  $('#btn-save').disabled = true;
}

async function openFile(path, labelEl) {
  try {
    const { content, derived, truncated, bytes } = await api(`/api/file?path=${encodeURIComponent(path)}`);
    currentFile = path;
    editing = false;
    // the create target follows the last thing clicked: a file hands it back
    // to the file's own folder
    selectedDir = null;
    document.querySelectorAll('.tree-label.selected, .tree-label.picked').forEach((x) => x.classList.remove('selected', 'picked'));
    (labelEl || document.querySelector(`#filetree .tree-file > .tree-label[data-path="${CSS.escape(path)}"]`))?.classList.add('selected');
    paintDestination();
    $('#file-path').textContent = path;
    $('#file-view').hidden = false;
    $('#file-editor').hidden = true;
    renderFileContent(path, content, derived, truncated, bytes);
    $('#btn-delete').disabled = Boolean(mirroredSource(path));
  } catch (e) {
    toast(`open failed: ${e.message}`);
  }
}

$('#file-view').addEventListener('click', async (event) => {
  const anchor = event.target.closest('a');
  if (!anchor || !currentFile) return;
  const wikiTarget = anchor.dataset.wikilink;
  const href = anchor.getAttribute('href') || '';
  const target = wikiTarget || href;
  if (!target || (!wikiTarget && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target))) return;

  event.preventDefault();
  try {
    const resolved = await api(`/api/link/resolve?target=${encodeURIComponent(target)}&from=${encodeURIComponent(currentFile)}`);
    reveal(parentDir(resolved.path));
    await loadTree();
    await openFile(resolved.path);
  } catch (e) {
    toast(`link unavailable: ${e.message}`);
  }
});

$('#btn-load-full').addEventListener('click', loadFullFile);

$('#btn-edit').addEventListener('click', () => {
  editing = !editing;
  $('#file-view').hidden = editing;
  $('#file-editor').hidden = !editing;
  $('#btn-edit').textContent = editing ? 'preview' : 'edit';
  $('#btn-save').disabled = !editing;
  if (!editing) $('#file-view').innerHTML = currentFile.endsWith('.md') ? renderMd($('#file-editor').value) : `<pre>${esc($('#file-editor').value)}</pre>`;
});

$('#btn-save').addEventListener('click', async () => {
  try {
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: currentFile, content: $('#file-editor').value }) });
    toast(`saved ${currentFile}`);
    $('#file-view').innerHTML = currentFile.endsWith('.md') ? renderMd($('#file-editor').value) : `<pre>${esc($('#file-editor').value)}</pre>`;
  } catch (e) {
    toast(`save failed: ${e.message}`);
  }
});

$('#btn-delete').addEventListener('click', () => {
  if (currentFile) deleteNode({ path: currentFile, kind: 'file' });
});

// creating and uploading are the same intent — "put something in this folder"
// — so they share one menu instead of two buttons
$('#btn-add').addEventListener('click', (ev) => {
  const dir = targetDir();
  showMenuUnder(ev.currentTarget, [
    { label: 'New file…', run: () => newFile(dir) },
    { label: 'New folder…', run: () => newFolder(dir) },
    '-',
    { label: 'Upload files…', run: () => pickUpload('files') },
    { label: 'Upload folder…', run: () => pickUpload('folder') },
    ...(mayImportFolders() ? [
      '-',
      { label: 'Import folder from this Mac…', run: () => importLocalFolder('copy', dir) },
      { label: 'Link folder from this Mac (keep in sync)…', run: () => importLocalFolder('link', dir) },
    ] : []),
  ]);
});

/* ------------------------ folders from this Mac -------------------------- */

/** Importing reads this Mac's own disk, so it is an administrator's call (the server puts it under `settings`). */
const mayImportFolders = () => authDisabled || serverAuth?.groups?.settings === true;

const fmtCount = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Import a folder that lives on this Mac, by its absolute path: copied once
 * (`copy`) or mirrored and kept in sync (`link`). The browser cannot hand over
 * a local path, so it is typed; the service reads the folder and says what it
 * would carry before anything is written.
 */
async function importLocalFolder(mode, dir) {
  const verb = mode === 'link' ? 'link' : 'import';
  const source = prompt(
    mode === 'link'
      ? 'Absolute path of the folder on this Mac to link.\nIts files are mirrored into raw/docs and kept in sync: every change there is indexed, and the copies are read-only here.'
      : 'Absolute path of the folder on this Mac to import.\nIts files are copied once into raw/docs with the folder structure kept.',
    lastImportSource || '/Users/',
  );
  if (source === null) return;
  const trimmed = source.trim();
  if (!trimmed) return;
  lastImportSource = trimmed;
  // the picked folder when it can take the mirror, else the root of raw/docs
  const base = isWritable(dir) && /^raw\/docs(\/|$)/.test(dir) && !mirroredSource(dir) ? dir : 'raw/docs';
  const name = trimmed.replace(/\/+$/, '').split('/').pop();
  toast('reading the folder…', 60000);
  let plan;
  try {
    plan = await api('/api/folders/preview', { method: 'POST', body: JSON.stringify({ source: trimmed, dest: `${base}/${name}` }) });
  } catch (e) {
    toast(`${verb} failed: ${e.message}`, 6000);
    return;
  }
  if (plan.linked) {
    toast(`${plan.linked.dest} is already linked to ${plan.linked.source}`, 6000);
    return;
  }
  const lines = [
    `${mode === 'link' ? 'Link' : 'Import'} ${plan.source}`,
    `→ ${plan.dest}`,
    '',
    `${fmtCount(plan.files, 'file')}, ${fmtBytes(plan.bytes)}${plan.sample.length ? ` — e.g. ${plan.sample.slice(0, 3).join(', ')}` : ''}.`,
  ];
  if (plan.tooLarge) lines.push(`${fmtCount(plan.tooLarge, 'file')} over ${fmtBytes(EDIT_BYTE_CAP)} will be copied but not indexed.`);
  if (plan.skippedByType) lines.push(`${fmtCount(plan.skippedByType, 'file')} of types knode-os cannot index stay behind.`);
  if (plan.exists) lines.push('', `${plan.dest} already exists: it becomes a mirror of this folder, and files only it has are removed.`);
  if (mode === 'link') lines.push('', 'The copies are kept in sync while knode-os runs. Edit the originals, not the copies.');
  lines.push('', 'Continue?');
  if (!confirm(lines.join('\n'))) return;
  toast(`${mode === 'link' ? 'linking' : 'importing'} ${fmtCount(plan.files, 'file')} — copying and indexing…`, 600000);
  try {
    const res = await api('/api/folders/import', { method: 'POST', body: JSON.stringify({ source: trimmed, dest: plan.dest, mode, replace: plan.exists }) });
    reveal(res.dest);
    await loadTree();
    loadStats();
    const indexed = res.sync ? ` · ${res.sync.indexed} indexed${res.sync.skipped ? `, ${res.sync.skipped} skipped` : ''}` : res.indexing ? ' · indexing in the background' : '';
    toast(`${mode === 'link' ? 'linked' : 'imported'} ${res.dest}: ${fmtCount(res.copied.length, 'file')} copied${indexed}`, 6000);
  } catch (e) {
    toast(`${verb} failed: ${e.message}`, 6000);
  }
}

async function syncLinkedFolder(dest) {
  toast(`syncing ${dest} from its source…`, 600000);
  try {
    const { results } = await api('/api/folders/sync', { method: 'POST', body: JSON.stringify({ dest }) });
    const r = results[0];
    await loadTree();
    loadStats();
    if (!r) toast('nothing to sync');
    else if (r.sourceMissing) toast(`${dest}: its source folder is not there — nothing changed`, 5000);
    else toast(`${dest}: ${r.copied} copied, ${r.removed} removed${r.sync ? ` · ${r.sync.indexed} indexed, ${r.sync.disposed} disposed` : ' · already up to date'}`, 5000);
  } catch (e) {
    toast(`sync failed: ${e.message}`, 5000);
  }
}

async function unlinkFolderNode(node, removeFiles) {
  const source = linkedDests.get(node.path);
  const question = removeFiles
    ? `Unlink ${node.path} from ${source} and delete the ${fmtCount(fileCount(node), 'copied file')}?\n\nTheir knowledge is disposed (history stays in the ledger). The originals are not touched.`
    : `Unlink ${node.path} from ${source}?\n\nThe copies stay as ordinary documents and stop following the source.`;
  if (!confirm(question)) return;
  toast(removeFiles ? `unlinking and removing ${node.path}…` : `unlinking ${node.path}…`, 600000);
  try {
    await api(`/api/folders?dest=${encodeURIComponent(node.path)}&removeFiles=${removeFiles ? 1 : 0}`, { method: 'DELETE' });
    if (removeFiles && currentFile && (currentFile === node.path || currentFile.startsWith(`${node.path}/`))) {
      currentFile = null;
      $('#file-path').textContent = '';
      $('#file-view').innerHTML = '';
      setFileNotice(null);
      $('#btn-edit').disabled = true;
      $('#btn-delete').disabled = true;
    }
    await loadTree();
    loadStats();
    toast(removeFiles ? `unlinked and removed ${node.path}` : `unlinked ${node.path} — its files stay as ordinary documents`, 5000);
  } catch (e) {
    toast(`unlink failed: ${e.message}`, 5000);
  }
}

$('#btn-clear-dir').addEventListener('click', () => {
  selectedDir = null;
  document.querySelectorAll('#filetree .tree-label.picked').forEach((x) => x.classList.remove('picked'));
  paintDestination();
});

$('#btn-refresh-tree').addEventListener('click', loadTree);

function pickUpload(kind, dir) {
  const input = kind === 'folder' ? $('#folder-upload') : $('#file-upload');
  input.dataset.dir = dir || uploadTarget();
  input.click();
}

for (const id of ['#file-upload', '#folder-upload']) {
  $(id).addEventListener('change', async (ev) => {
    const dir = ev.target.dataset.dir || uploadTarget();
    // a picked folder carries its whole subtree, dot-directories included
    const files = [...ev.target.files].filter((f) => !(f.webkitRelativePath || f.name).split('/').some((seg) => seg.startsWith('.')));
    ev.target.value = '';
    await uploadFiles(files, dir);
  });
}

/** Split an import into requests small enough for the service to hold in memory. */
function uploadBatches(files) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length && (current.length >= UPLOAD_BATCH_FILES || bytes + file.size > UPLOAD_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function uploadFiles(files, dir) {
  if (!files.length) {
    toast('nothing to upload — no readable files there');
    return;
  }
  try {
    let saved = 0;
    for (const batch of uploadBatches(files)) {
      const form = new FormData();
      form.set('dir', dir);
      // a folder upload sends each file's path inside it, so the subtree is recreated
      for (const file of batch) form.append('files', file, file.webkitRelativePath || file.name);
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-knode-csrf': '1', ...workspaceRequestHeaders() }, body: form, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.reason === 'auth') sessionEnded(data.error);
      if (!res.ok) throw new Error(data.error || res.statusText);
      saved += data.saved.length;
      toast(`uploading ${saved}/${files.length} files into ${dir}…`, 60000);
    }
    toast(`uploaded ${saved} file${saved === 1 ? '' : 's'} into ${dir} — indexing…`, 60000);
    await api('/api/ingest', { method: 'POST' });
    reveal(dir);
    await loadTree();
    loadStats();
    toast('upload and index complete');
  } catch (e) {
    toast(`upload failed: ${e.message}`);
  }
}

$('#btn-ingest').addEventListener('click', async () => {
  toast('indexing…', 60000);
  try {
    const s = await api('/api/ingest', { method: 'POST' });
    toast(`indexed ${s.indexed} docs, ${s.unchanged} unchanged, ${s.chunks} chunks`);
    await loadTree();
    loadStats();
  } catch (e) {
    toast(`index failed: ${e.message}`);
  }
});

/* ------------------------------- search -------------------------------- */

async function doSearch() {
  const q = $('#search-q').value.trim();
  if (!q) return;
  const mode = $('#search-mode').value;
  const el = $('#search-results');
  el.innerHTML = '<p class="hint">searching…</p>';
  try {
    const scope = $('#search-scope').value;
    const results = await api(`/api/search?q=${encodeURIComponent(q)}&mode=${mode}&k=12${scope ? `&sources=${encodeURIComponent(scope)}` : ''}`);
    el.innerHTML = results.length ? '' : '<p class="hint">no results — upload docs and index them first.</p>';
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'result';
      const route = r.trace?.bridgeEntities?.length
        ? ` · ${r.trace.bridgeEntities.join(' → ')}`
        : (r.trace?.route ? ` · ${r.trace.route}` : '');
      div.innerHTML = `<span class="rscore">${r.score.toFixed(4)} ${Object.keys(r.signals).join('+')}${esc(route)}</span>
        <div class="rpath">${esc(r.path)}</div>
        <div class="rsnippet">${esc(r.content.slice(0, 360))}</div>`;
      div.addEventListener('click', () => {
        navigate('files');
        openFile(r.path);
      });
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">search failed: ${esc(e.message)}</p>`;
  }
}
$('#btn-search').addEventListener('click', doSearch);
$('#search-q').addEventListener('keydown', (e) => e.key === 'Enter' && doSearch());

/* ------------------------------- graph --------------------------------- */

/**
 * One colour per entity type, shared by the graph canvas and the entity table's type pills (set through
 * element.style, as the page policy allows) — the same set as the Mac app's. The four common types
 * (organization, product, concept, person) stay apart under red-green colour blindness.
 */
const ENTITY_COLORS = {
  organization: '#ba7f02', product: '#e5657b', concept: '#9581ef', person: '#09a0a0', location: '#4b99d7', event: '#c158ae',
  technology: '#3db6cf', project: '#d76549', component: '#627ace', datasource: '#7d8ea1', dataset: '#8ca2ae', other: '#7c8088',
};
const entityColor = (type) => ENTITY_COLORS[type] ?? ENTITY_COLORS.other;

const GRAPH_KEY = 'knode-os.graph.v1';

/** Display preferences for the graph (web/graph.js draws by them), kept across workspaces and reloads. */
function restoreGraphSettings() {
  const defaults = window.KnodeGraph?.DEFAULTS ?? {};
  let saved = {};
  try {
    const raw = JSON.parse(localStorage.getItem(GRAPH_KEY) ?? 'null');
    if (raw && raw.v === 1) saved = raw;
  } catch {
    /* storage may be off, or hold something older */
  }
  const settings = { ...defaults };
  for (const key of Object.keys(defaults)) if (key in saved) settings[key] = saved[key];
  return settings;
}

function saveGraphSettings() {
  try {
    localStorage.setItem(GRAPH_KEY, JSON.stringify({ v: 1, ...graphState.settings }));
  } catch {
    /* storage may be off */
  }
}

const graphState = { graph: null, res: null, mode: 'overview', query: '', loaded: false, settings: restoreGraphSettings() };

function resetGraph() {
  graphState.graph?.clear();
  graphState.res = null;
  graphState.query = '';
  graphState.loaded = false;
  $('#graph-caption').textContent = '';
  $('#graph-legend').innerHTML = '';
  $('#graph-side').innerHTML = '';
}

/** The canvas controller, built on first use; without d3 the stage says so instead of breaking. */
function ensureGraph() {
  if (graphState.graph) return graphState.graph;
  if (!window.KnodeGraph?.available) {
    const stage = $('#graph-stage');
    if (!stage.querySelector('.graph-empty')) {
      const p = document.createElement('p');
      p.className = 'hint graph-empty';
      p.textContent = 'the graph view needs the d3 package: run pnpm install where the service runs, then restart it';
      stage.appendChild(p);
    }
    return null;
  }
  const g = new KnodeGraph($('#graph-canvas'), { colors: ENTITY_COLORS, settings: graphState.settings });
  g.on('select', (n) => renderGraphSide(n));
  g.on('open', (n) => loadGraph(n.name));
  g.on('stats', (s) => paintGraphCaption(s));
  graphState.graph = g;
  paintGraphSettings();
  return g;
}

/** Empty query: the overview, the top entities by mentions. A name: the local graph around it. */
async function loadGraph(q) {
  const g = ensureGraph();
  if (!g) return;
  const s = graphState.settings;
  const params = new URLSearchParams({ limit: String(s.limit) });
  if (q) {
    params.set('q', q);
    params.set('depth', $('#graph-depth').value);
  } else if (!s.cooccur) {
    // the co-occurrence join is the slow part of an overview: skip it when it will not be drawn
    params.set('edges', 'typed');
  }
  try {
    const res = await api(`/api/graph?${params}`);
    graphState.res = res;
    graphState.mode = q ? 'search' : 'overview';
    graphState.query = q;
    graphState.loaded = true;
    $('#graph-q').value = q;
    g.load(res.nodes, res.edges, { mode: graphState.mode });
    paintGraphLegend(res);
    renderGraphSide(null);
  } catch (e) {
    toast(`graph failed: ${e.message}`);
  }
}

function paintGraphCaption({ nodes, edges }) {
  const what = graphState.mode === 'search'
    ? `local graph · “${graphState.query}” · ${$('#graph-depth').value} hops · ranked by relevance`
    : `overview · top ${graphState.settings.limit} by mentions`;
  $('#graph-caption').textContent = `${what} · ${nodes} nodes · ${edges} edges`;
}

/** A short line in a relation family's colour and pattern, built as SVG nodes (the page allows no inline style). */
function relationSample(family) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '8');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'line');
  for (const [k, v] of Object.entries({ x1: 1, y1: 4, x2: 17, y2: 4, stroke: family.color, 'stroke-width': 2, 'stroke-linecap': family.dash.length ? 'round' : 'butt' })) line.setAttribute(k, String(v));
  if (family.dash.length) line.setAttribute('stroke-dasharray', family.dash.join(' '));
  svg.appendChild(line);
  return svg;
}

/**
 * Two rows of chips. Entity types in the result, with their counts; a click hides or shows that type.
 * Relation families, with their counts; a click hides or shows that family, and the co-occurrence chip
 * is the same switch as the settings checkbox.
 */
function paintGraphLegend(res) {
  const s = graphState.settings;
  const legend = $('#graph-legend');
  legend.textContent = '';

  const counts = new Map();
  for (const n of res.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const hidden = new Set(s.hiddenTypes);
  const types = document.createElement('div');
  types.className = 'legend-row';
  for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const chip = document.createElement('button');
    chip.className = `chip${hidden.has(type) ? ' off' : ''}`;
    chip.dataset.type = type;
    chip.title = 'hide or show this type';
    const dot = document.createElement('span');
    dot.className = 'dot ring';
    const color = entityColor(type);
    dot.style.borderColor = color;
    if (s.glow) dot.style.boxShadow = `0 0 6px 1px ${color}`;
    chip.append(dot, `${type} · ${n}`);
    types.appendChild(chip);
  }

  const families = new Map();
  for (const e of res.edges) {
    const id = KnodeGraph.family(e.type).id;
    families.set(id, (families.get(id) ?? 0) + 1);
  }
  const relations = document.createElement('div');
  relations.className = 'legend-row';
  for (const family of KnodeGraph.FAMILIES) {
    const n = families.get(family.id) ?? 0;
    // co-occurrence stays listed when switched off: an overview then does not even fetch it
    if (!n && family.id !== 'cooccur') continue;
    const off = family.id === 'cooccur' ? !s.cooccur : (s.hiddenRelations ?? []).includes(family.id);
    const chip = document.createElement('button');
    chip.className = `chip${off ? ' off' : ''}`;
    chip.dataset.family = family.id;
    chip.title = 'hide or show this relation family';
    chip.append(relationSample(family), n ? `${family.label} · ${n}` : family.label);
    relations.appendChild(chip);
  }
  legend.append(types, relations);
}

$('#graph-legend').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  const family = chip.dataset.family;
  if (family === 'cooccur') {
    // the settings checkbox owns this switch, refetch included
    const box = $('#gs-cooccur');
    box.checked = !graphState.settings.cooccur;
    chip.classList.toggle('off', !box.checked);
    box.dispatchEvent(new Event('change'));
    return;
  }
  if (family) {
    const off = new Set(graphState.settings.hiddenRelations ?? []);
    if (off.has(family)) off.delete(family);
    else off.add(family);
    chip.classList.toggle('off', off.has(family));
    graphState.settings.hiddenRelations = [...off];
    graphState.graph?.setSettings({ hiddenRelations: graphState.settings.hiddenRelations });
    saveGraphSettings();
    return;
  }
  const hidden = new Set(graphState.settings.hiddenTypes);
  if (hidden.has(chip.dataset.type)) hidden.delete(chip.dataset.type);
  else hidden.add(chip.dataset.type);
  chip.classList.toggle('off', hidden.has(chip.dataset.type));
  graphState.settings.hiddenTypes = [...hidden];
  graphState.graph?.setSettings({ hiddenTypes: graphState.settings.hiddenTypes });
  saveGraphSettings();
});

/** The settings panel shows the current values; every control writes straight back. */
function paintGraphSettings() {
  const s = graphState.settings;
  for (const key of Object.keys(window.KnodeGraph?.DEFAULTS ?? {})) {
    const el = document.getElementById(`gs-${key}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(s[key]);
    else el.value = String(s[key]);
    const out = el.nextElementSibling;
    if (out && out.tagName === 'OUTPUT') out.textContent = String(s[key]);
  }
}

for (const key of Object.keys(window.KnodeGraph?.DEFAULTS ?? {})) {
  const el = document.getElementById(`gs-${key}`);
  if (!el) continue;
  const apply = () => {
    const value = el.type === 'checkbox' ? el.checked : Number(el.value);
    graphState.settings[key] = value;
    const out = el.nextElementSibling;
    if (out && out.tagName === 'OUTPUT') out.textContent = String(value);
    saveGraphSettings();
    // the node count, and co-occurrence in an overview, change what the server sends
    if (key === 'limit' || (key === 'cooccur' && graphState.mode === 'overview')) {
      if (graphState.loaded) loadGraph(graphState.query);
      return;
    }
    graphState.graph?.setSettings({ [key]: value });
    // the legend shows co-occurrence's switch, and glow on the type swatches
    if ((key === 'glow' || key === 'cooccur') && graphState.res) paintGraphLegend(graphState.res);
  };
  el.addEventListener(el.type === 'range' ? 'input' : 'change', apply);
}
$('#gs-query').addEventListener('input', () => graphState.graph?.setQuery($('#gs-query').value));
$('#gs-fit').addEventListener('click', () => graphState.graph?.fit());
$('#gs-reset').addEventListener('click', () => {
  const defaults = window.KnodeGraph?.DEFAULTS ?? {};
  const refetch = graphState.settings.limit !== defaults.limit || graphState.settings.cooccur !== defaults.cooccur;
  graphState.settings = { ...defaults };
  saveGraphSettings();
  paintGraphSettings();
  $('#gs-query').value = '';
  graphState.graph?.setQuery('');
  graphState.graph?.setSettings(graphState.settings);
  if (refetch && graphState.loaded) loadGraph(graphState.query);
  else if (graphState.res) paintGraphLegend(graphState.res);
});

/**
 * The panel beside the canvas: the selected node with its neighbours and
 * claims, or, with nothing selected, the top of the result.
 */
function renderGraphSide(node) {
  const side = $('#graph-side');
  const res = graphState.res;
  const g = graphState.graph;
  if (!res || !g) {
    side.innerHTML = '';
    return;
  }
  if (!res.nodes.length) {
    side.innerHTML = '<p class="hint">graph is empty — index docs first (entities come from [[wikilinks]], frontmatter and extraction).</p>';
    return;
  }
  const claimsBySubject = new Map();
  for (const cl of res.claims ?? []) (claimsBySubject.get(cl.subject) ?? claimsBySubject.set(cl.subject, []).get(cl.subject)).push(cl);
  // the number means mentions in an overview and relevance to the query in a search: say which
  const numbers = (n) => {
    const parts = [`${n.mentionCount} mentions`, `degree ${typeof n.degree === 'number' ? n.degree : '?'}`];
    if (graphState.mode === 'search') parts.unshift(`relevance ${(n.score ?? 0).toFixed(2)}`);
    return parts.join(' · ');
  };
  const facts = (n, max) => (claimsBySubject.get(n.name) ?? []).slice(0, max)
    .map((cl) => `<div class="hint">◈ ${esc(cl.statement.slice(0, 120))} <span class="mono">[${esc(cl.status)}]</span></div>`)
    .join('');
  const pill = (type) => `<span class="tpill" data-type="${esc(type)}">${esc(type)}</span>`;

  if (node) {
    const neighbours = g.neighbours(node.id);
    side.innerHTML = `<div class="entity-card selected">
        ${pill(node.type)} <span class="ename">${esc(node.name)}</span>
        <div class="hint">${esc((node.description || '').slice(0, 240))}</div>
        <div class="hint mono">${esc(numbers(node))}</div>
        ${facts(node, 5)}
        <div class="actions">
          <button data-local>local graph</button>
          <button data-wiki${node.wikiPath ? '' : ' disabled title="no wiki page yet"'}>open wiki page</button>
        </div>
      </div>
      <div class="entity-card"><b>${neighbours.length ? `${neighbours.length} neighbours in view` : 'no neighbours in view'}</b>
        ${neighbours.slice(0, 24).map((x) => `<div class="nb" data-id="${esc(x.node.id)}">${pill(x.node.type)}<span>${esc(x.node.name)}</span><span class="hint mono"><span class="rel-swatch" data-family="${esc(x.fam.id)}"></span>${x.co ? 'co-occurs' : esc(x.type)} ${x.weight.toFixed(1)}</span></div>`).join('')}
      </div>`;
    for (const sw of side.querySelectorAll('.rel-swatch')) sw.style.background = KnodeGraph.FAMILIES.find((f) => f.id === sw.dataset.family)?.color ?? '';
    side.querySelector('[data-local]').addEventListener('click', () => loadGraph(node.name));
    if (node.wikiPath) side.querySelector('[data-wiki]').addEventListener('click', () => { navigate('files'); openFile(node.wikiPath); });
    for (const nb of side.querySelectorAll('.nb')) {
      nb.addEventListener('click', () => { g.select(nb.dataset.id); g.focus(nb.dataset.id); });
      nb.addEventListener('mouseenter', () => g.setHover(nb.dataset.id));
      nb.addEventListener('mouseleave', () => g.setHover(null));
    }
  } else {
    side.innerHTML = res.nodes.slice(0, 30).map((n) => `<div class="entity-card pick" data-id="${esc(n.id)}">
        ${pill(n.type)} <span class="ename">${esc(n.name)}</span>
        <div class="hint">${esc((n.description || '').slice(0, 140))}</div>
        <div class="hint mono">${esc(numbers(n))}</div>${facts(n, 3)}
      </div>`).join('');
    if (res.chunks?.length) {
      side.insertAdjacentHTML('beforeend', `<p class="hint">grounded in: ${[...new Set(res.chunks.map((c) => c.path))].slice(0, 5).map(pageLink).join(', ')}</p>`);
      wireOpenLinks(side);
    }
    for (const card of side.querySelectorAll('.entity-card.pick')) card.addEventListener('click', () => { g.select(card.dataset.id); g.focus(card.dataset.id); });
  }
  for (const p of side.querySelectorAll('.tpill')) p.style.color = entityColor(p.dataset.type);
}

$('#btn-graph').addEventListener('click', () => loadGraph($('#graph-q').value.trim()));
$('#graph-q').addEventListener('keydown', (e) => e.key === 'Enter' && loadGraph($('#graph-q').value.trim()));
$('#btn-graph-insights').addEventListener('click', async () => {
  try {
    const ins = await api('/api/graph/insights');
    const side = $('#graph-side');
    side.innerHTML = `<div class="entity-card"><b>totals</b><div class="hint mono">${ins.totals.entities} entities · ${ins.totals.relations} relations · ${ins.totals.mentions} mentions</div></div>`;
    if (ins.hubs.length) {
      side.innerHTML += `<div class="entity-card"><b>hubs</b>${ins.hubs.map((h) => `<div class="hint">${esc(h.name)} — degree ${h.degree}</div>`).join('')}</div>`;
    }
    if (ins.isolated.length) {
      side.innerHTML += `<div class="entity-card"><b>isolated</b>${ins.isolated.map((h) => `<div class="hint">${esc(h.name)}</div>`).join('')}</div>`;
    }
    side.innerHTML += `<div class="entity-card"><b>types</b>${ins.typeCounts.map((t) => `<div class="hint">${esc(t.type)}: ${t.n}</div>`).join('')}</div>`;
  } catch (e) {
    toast(`insights failed: ${e.message}`);
  }
});

/* ------------------------------ entities ------------------------------- */

/**
 * Knowledge → Entities: one page of GET /api/entities at a time. The server
 * filters, sorts and counts; this keeps the query and paints what comes back.
 */
const entState = { q: '', type: '', merged: false, sort: 'mentions', order: 'desc', offset: 0, limit: 50, total: 0, seq: 0 };
/** The order a column reads best in when it is first chosen. */
const ENT_FIRST_ORDER = { name: 'asc', type: 'asc', mentions: 'desc', evidence: 'desc', updated: 'desc' };
let entTimer = null;

function resetEntities() {
  Object.assign(entState, { q: '', type: '', merged: false, offset: 0, total: 0 });
  entState.seq++;
  $('#ent-q').value = '';
  $('#ent-merged').checked = false;
  $('#ent-type').innerHTML = '<option value="">all types</option>';
  delete $('#ent-type').dataset.sig;
  $('#ent-count').textContent = '';
  $('#ent-page').textContent = '';
  $('#entities-table tbody').innerHTML = '';
}

async function loadEntities() {
  // boot runs a loader twice and a slow page may arrive after a fast one: the latest request wins
  const seq = ++entState.seq;
  const params = new URLSearchParams({ sort: entState.sort, order: entState.order, offset: String(entState.offset), limit: String(entState.limit) });
  if (entState.q) params.set('q', entState.q);
  if (entState.type) params.set('type', entState.type);
  if (entState.merged) params.set('merged', '1');
  try {
    const page = await api(`/api/entities?${params}`);
    if (seq === entState.seq) renderEntities(page);
  } catch (e) {
    if (seq === entState.seq) $('#entities-table tbody').innerHTML = `<tr><td colspan="11" class="hint">entities failed: ${esc(e.message)}</td></tr>`;
  }
}

function renderEntities(page) {
  entState.total = page.total;
  entState.offset = page.offset;
  entState.limit = page.limit;
  const tbody = $('#entities-table tbody');
  tbody.innerHTML = page.items.map((e) => {
    const aliases = e.aliases.slice(0, 3).join(', ') + (e.aliases.length > 3 ? ` +${e.aliases.length - 3}` : '');
    const sources = Object.entries(e.sources).sort((a, b) => b[1] - a[1]).map(([family, n]) => `<span class="spill">${esc(family)} ${n}</span>`).join(' ');
    return `<tr>
      <td><a href="#" class="ename" data-explore="${esc(e.name)}" title="explore in the graph">${esc(e.name)}</a>${e.canonicalId ? ' <span class="hint">merged</span>' : ''}</td>
      <td><span class="tpill" data-type="${esc(e.type)}">${esc(e.type)}</span></td>
      <td class="hint" title="${esc(e.aliases.join(', '))}">${esc(aliases)}</td>
      <td class="hint ent-desc" title="${esc(e.description)}">${esc(e.description.slice(0, 120))}</td>
      <td class="num mono">${e.mentions}</td>
      <td class="num mono">${e.documents}</td>
      <td class="num mono">${e.relations}</td>
      <td class="num mono">${e.evidence}</td>
      <td>${sources}</td>
      <td>${e.wikiPath ? pageLink(e.wikiPath) : '<span class="hint">—</span>'}</td>
      <td class="mono hint">${e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : '—'}</td>
    </tr>`;
  }).join('');
  if (!page.items.length) {
    const filtered = entState.q || entState.type;
    tbody.innerHTML = `<tr><td colspan="11" class="hint">${filtered ? 'no entities match' : 'no entities yet — index documents first (entities come from frontmatter, [[wikilinks]] and extraction)'}</td></tr>`;
  }
  for (const pill of tbody.querySelectorAll('.tpill')) pill.style.color = entityColor(pill.dataset.type);
  wireOpenLinks(tbody);

  // the type filter keeps its options, and the selection, while the types hold still
  const sel = $('#ent-type');
  const sig = page.typeCounts.map((t) => `${t.type}:${t.n}`).join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = `<option value="">all types</option>${page.typeCounts.map((t) => `<option value="${esc(t.type)}">${esc(t.type)} (${t.n.toLocaleString()})</option>`).join('')}`;
    sel.value = entState.type;
    if (sel.value !== entState.type) entState.type = '';
  }

  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.total, page.offset + page.items.length);
  $('#ent-count').textContent = `${page.total.toLocaleString()} ${page.total === 1 ? 'entity' : 'entities'}`;
  $('#ent-page').textContent = page.total ? `${from.toLocaleString()}–${to.toLocaleString()} of ${page.total.toLocaleString()}` : '';
  $('#ent-prev').disabled = page.offset <= 0;
  $('#ent-next').disabled = to >= page.total;
  $('#ent-size').value = String(page.limit);
  for (const th of document.querySelectorAll('#entities-table th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === entState.sort);
    th.classList.toggle('asc', th.dataset.sort === entState.sort && entState.order === 'asc');
  }
}

/** Open the graph on an entity: the box holds the name, and arrival (or a view already loaded) runs it once. */
function exploreEntity(name) {
  $('#graph-q').value = name;
  if (graphState.loaded) loadGraph(name);
  navigate('graph');
}

$('#ent-q').addEventListener('input', () => {
  clearTimeout(entTimer);
  entTimer = setTimeout(() => {
    entState.q = $('#ent-q').value.trim();
    entState.offset = 0;
    loadEntities();
  }, 250);
});
$('#ent-type').addEventListener('change', () => {
  entState.type = $('#ent-type').value;
  entState.offset = 0;
  loadEntities();
});
$('#ent-merged').addEventListener('change', () => {
  entState.merged = $('#ent-merged').checked;
  entState.offset = 0;
  loadEntities();
});
$('#ent-size').addEventListener('change', () => {
  const limit = Number($('#ent-size').value) || 50;
  // the first row on screen stays on screen, on whichever page now holds it
  entState.offset = Math.floor(entState.offset / limit) * limit;
  entState.limit = limit;
  loadEntities();
});
$('#ent-prev').addEventListener('click', () => {
  entState.offset = Math.max(0, entState.offset - entState.limit);
  loadEntities();
});
$('#ent-next').addEventListener('click', () => {
  entState.offset += entState.limit;
  loadEntities();
});
$('#entities-table thead').addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-sort]');
  if (!th) return;
  const col = th.dataset.sort;
  entState.order = col === entState.sort ? (entState.order === 'asc' ? 'desc' : 'asc') : ENT_FIRST_ORDER[col];
  entState.sort = col;
  entState.offset = 0;
  loadEntities();
});
$('#entities-table tbody').addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-explore]');
  if (!a) return;
  ev.preventDefault();
  exploreEntity(a.dataset.explore);
});

/* ------------------------------- traces -------------------------------- */

async function loadTraces() {
  const tbody = $('#traces-table tbody');
  tbody.innerHTML = '';
  try {
    const traces = await api('/api/traces');
    for (const t of traces) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(t.source)}</td><td class="mono">${esc(t.project ?? '-')}</td>
        <td class="mono">${esc((t.session_id ?? '').slice(0, 24))}</td>
        <td class="mono">${t.started_at ? new Date(t.started_at).toLocaleString() : '-'}</td>
        <td class="mono">${(t.bytes / 1024).toFixed(0)} KB</td>
        <td>${t.analyzed_at ? '✓' : ''}</td>`;
      // a trace is a file under raw/, so it opens where every other file does
      tr.title = `open ${t.path}`;
      tr.addEventListener('click', () => { navigate('files'); openFile(t.path); });
      tbody.appendChild(tr);
    }
    if (!traces.length) tbody.innerHTML = '<tr><td colspan="6" class="hint">no traces yet — run a Claude Code / Codex session, then sync.</td></tr>';
  } catch (e) {
    toast(`traces failed: ${e.message}`);
  }
}

$('#btn-trace-sync').addEventListener('click', async () => {
  toast('syncing traces…', 30000);
  try {
    const s = await api('/api/traces/sync', { method: 'POST' });
    toast(`synced: ${s.copied} traces, ${s.skills} skill files`);
    loadTraces();
    loadStats();
  } catch (e) {
    toast(`sync failed: ${e.message}`);
  }
});

/* -------------------------------- dream -------------------------------- */

async function loadSuggestions() {
  const el = $('#suggestions');
  el.innerHTML = '';
  try {
    const [stats, suggestions] = await Promise.all([api('/api/stats'), api('/api/suggestions')]);
    if (stats.lastDream) {
      $('#dream-info').textContent = `last dream: ${new Date(stats.lastDream.at).toLocaleString()} over ${stats.lastDream.sessions} sessions → ${stats.lastDream.report}`;
    }
    if (!suggestions.length) {
      el.innerHTML = '<p class="hint">no suggestions yet — press “dream now” after a few agent sessions.</p>';
      return;
    }
    for (const s of suggestions) {
      const div = document.createElement('div');
      div.className = `suggestion ${s.status}`;
      const evidence = (s.evidence ?? []).map((e) => `<div>${esc(e)}</div>`).join('');
      div.innerHTML = `<span class="skind ${esc(s.kind)}">${esc(s.kind)}</span> <span class="hint mono">${esc(s.status)} · ${new Date(s.created_at).toLocaleDateString()}</span>
        <div class="stitle">${esc(s.title)}</div>
        <div class="sbody markdown">${renderMd(s.body)}</div>
        ${evidence ? `<div class="evidence">${evidence}</div>` : ''}
        <div class="sactions">
          ${s.status === 'pending' ? `<button data-act="accepted">accept</button><button data-act="rejected">reject</button>` : ''}
          ${s.report_path ? `<button data-report="${esc(s.report_path)}">report</button>` : ''}
        </div>`;
      div.querySelectorAll('button[data-act]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/suggestions/${s.id}/status`, { method: 'POST', body: JSON.stringify({ status: b.dataset.act }) });
          loadSuggestions();
        }),
      );
      const rb = div.querySelector('button[data-report]');
      if (rb) rb.addEventListener('click', () => {
        navigate('files');
        openFile(rb.dataset.report);
      });
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

/* -------------------------------- wiki (research) ---------------------- */

const pageLink = (p) => `<a href="#" data-open="${esc(p)}" class="mono">${esc(p)}</a>`;

function wireOpenLinks(root) {
  root.querySelectorAll('a[data-open]').forEach((a) =>
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('files');
      openFile(a.dataset.open);
    }),
  );
}

async function loadResearch() {
  await Promise.all([loadInitCard(), loadResearchJobs(), loadResearchPages(), loadResearchRecommendations()]);
}

async function loadResearchJobs() {
  const el = $('#research-jobs');
  try {
    const jobs = await api('/api/research/jobs?limit=40');
    if (!jobs.length) {
      el.innerHTML = '<p class="hint">no research jobs yet — queue one above, or accept a recommendation.</p>';
      return;
    }
    el.innerHTML = '';
    for (const j of jobs) {
      const div = document.createElement('div');
      div.className = 'job';
      const what = `${esc(j.kind)} · ${esc(j.target ?? j.query ?? '')}`;
      const when = new Date(j.finishedAt ?? j.startedAt ?? j.createdAt).toLocaleString();
      const actions = [];
      if (j.status === 'queued' || j.status === 'running') actions.push(`<button data-cancel="${esc(j.id)}">cancel</button>`);
      if (j.status === 'failed' || j.status === 'cancelled') actions.push(`<button data-retry="${esc(j.id)}">retry</button>`);
      actions.push(`<button data-log="${esc(j.id)}">log</button>`);
      div.innerHTML = `<span class="jstatus ${esc(j.status)}">${esc(j.status)}</span>
        <span>${what}${j.outputPath ? ` → ${pageLink(j.outputPath)}` : ''} <span class="hint mono">${when}${j.turns ? ` · ${j.turns} turns` : ''}${j.agent ? ` · ${esc(j.agent)}` : ''}</span></span>
        <span class="jactions">${actions.join('')}</span>
        ${j.error ? `<div class="jerr">${esc(j.error)}</div>` : ''}`;
      div.querySelector('button[data-cancel]')?.addEventListener('click', async () => { await api(`/api/research/jobs/${j.id}/cancel`, { method: 'POST' }); loadResearchJobs(); });
      div.querySelector('button[data-retry]')?.addEventListener('click', async () => { await api(`/api/research/jobs/${j.id}/retry`, { method: 'POST' }); loadResearchJobs(); });
      div.querySelector('button[data-log]')?.addEventListener('click', async () => {
        const full = await api(`/api/research/jobs/${j.id}?log=1`);
        const pre = document.createElement('pre');
        pre.className = 'mono';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.maxHeight = '320px';
        pre.style.overflow = 'auto';
        pre.textContent = full.log ?? '(no transcript yet)';
        const old = div.querySelector('pre');
        if (old) old.remove(); else div.appendChild(pre);
      });
      wireOpenLinks(div);
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

async function loadResearchPages() {
  const el = $('#research-pages');
  try {
    const pages = await api('/api/research/pages');
    if (!pages.length) {
      el.innerHTML = '<p class="hint">no research pages yet.</p>';
      return;
    }
    el.innerHTML = '';
    for (const p of pages) {
      const div = document.createElement('div');
      div.className = 'rpage';
      const trust = p.trust ?? (p.exists ? 'unsynced' : 'missing');
      div.innerHTML = `<span>${pageLink(p.path)} <span class="hint">${esc(p.kind)} · ${esc(p.target ?? '')}${p.warnings?.length ? ` · ${p.warnings.length} warnings` : ''}</span></span>
        <span class="trust ${trust}">${trust}</span>
        <span class="ractions">
          ${p.trust === 'quarantined' ? `<button data-trust="trusted">promote</button>` : ''}
          ${p.trust === 'trusted' ? `<button data-trust="quarantined">demote</button>` : ''}
          <button data-refresh="${esc(p.path)}">refresh</button>
        </span>`;
      div.querySelector('button[data-trust]')?.addEventListener('click', async (ev) => {
        try {
          await api('/api/trust', { method: 'POST', body: JSON.stringify({ path: p.path, to: ev.target.dataset.trust }) });
          toast(`${p.path}: ${ev.target.dataset.trust}`);
          loadResearchPages();
        } catch (e) {
          toast(`trust change failed: ${e.message}`);
        }
      });
      div.querySelector('button[data-refresh]')?.addEventListener('click', async () => {
        await api('/api/research/jobs', { method: 'POST', body: JSON.stringify({ kind: 'refresh', target: p.path }) });
        toast('refresh queued');
        loadResearchJobs();
      });
      wireOpenLinks(div);
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

async function loadResearchRecommendations() {
  const el = $('#research-recommendations');
  try {
    const recs = await api('/api/research/recommendations');
    if (!recs.length) {
      el.innerHTML = '<p class="hint">nothing to recommend yet — recommendations come from hot entities, repeated questions and pages whose facts changed.</p>';
      return;
    }
    el.innerHTML = '';
    for (const r of recs) {
      const div = document.createElement('div');
      div.className = 'rec';
      div.innerHTML = `<div><b>${esc(r.kind)}</b> · ${esc(r.target)} <span class="hint mono">score ${Number(r.score).toFixed(2)}</span></div>
        <div class="recwhy">${(r.reasons ?? []).map(esc).join(' · ')}</div>
        <div class="recactions"><button data-queue>queue</button>${r.suggestionId ? `<button data-dismiss>dismiss</button>` : ''}</div>`;
      div.querySelector('button[data-queue]').addEventListener('click', async () => {
        if (r.suggestionId) await api(`/api/suggestions/${r.suggestionId}/status`, { method: 'POST', body: JSON.stringify({ status: 'accepted' }) });
        else await api('/api/research/jobs', { method: 'POST', body: JSON.stringify({ kind: r.kind, target: r.kind === 'question' ? undefined : r.target, query: r.kind === 'question' ? r.target : undefined }) });
        toast('research queued');
        loadResearch();
      });
      div.querySelector('button[data-dismiss]')?.addEventListener('click', async () => {
        await api(`/api/suggestions/${r.suggestionId}/status`, { method: 'POST', body: JSON.stringify({ status: 'rejected' }) });
        loadResearchRecommendations();
      });
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

$('#btn-research-queue').addEventListener('click', async () => {
  const kind = $('#research-kind').value;
  const text = $('#research-target').value.trim();
  if (!text) return toast('type an entity, concept, question or page path first');
  try {
    const body = kind === 'question' ? { kind, query: text } : { kind, target: text };
    const res = await api('/api/research/jobs', { method: 'POST', body: JSON.stringify(body) });
    toast(res.created ? `queued ${res.job.id}` : `already queued: ${res.job.id}`);
    $('#research-target').value = '';
    loadResearchJobs();
  } catch (e) {
    toast(`queue failed: ${e.message}`);
  }
});
$('#btn-research-refresh').addEventListener('click', loadResearch);

$('#btn-dream').addEventListener('click', async () => {
  toast('dreaming… this can take a minute', 90000);
  try {
    const res = await api('/api/dream', { method: 'POST' });
    toast(`dream complete: ${res.suggestions.length} suggestions (${res.sessions} sessions)`);
    loadSuggestions();
    loadStats();
  } catch (e) {
    toast(`dream failed: ${e.message}`);
  }
});

/* --------------------- wiki · initialize the knowledge base ------------- */

const STEP_LABELS = { sync: 'Index the files', extract: 'Extract entities & claims', views: 'Regenerate stub pages', survey: 'Survey the base' };
let initJobTimer = null;
let initJobId = null;

function stopInitPolling() {
  clearTimeout(initJobTimer);
  initJobTimer = null;
}

const jobIsLive = (status) => status === 'queued' || status === 'running' || status === 'validating';

async function loadInitCard() {
  const summary = $('#init-summary');
  const button = $('#btn-init-kb');
  try {
    const { survey, guide, job } = await api('/api/research/init');
    const s = survey.stats;
    summary.textContent = `${s.documents} docs · ${survey.entities.total} entities · ${survey.relations.total} relations · ${s.claims} claims`
      + (survey.extraction.queued ? ` · ${survey.extraction.queued} awaiting extraction` : '');
    $('#init-guide').innerHTML = guide.exists
      ? `guide <a href="#" data-open="AGENTS.md" class="mono">AGENTS.md</a>${guide.stamp?.at ? ` · ${esc(guide.stamp.at.slice(0, 10))}` : ''}`
      : '<span class="muted">no guide yet</span>';
    wireOpenLinks($('#init-guide'));
    $('#init-title').textContent = guide.exists ? 'Re-initialize knowledge base' : 'Initialize knowledge base';
    button.textContent = guide.exists ? '⟳ re-initialize' : '⚙ initialize';
    button.disabled = Boolean(job && jobIsLive(job.status));
    if (job) renderInitJob(job);
    else $('#init-progress').hidden = true;
    if (job && jobIsLive(job.status)) watchInitJob(job.id);
    else stopInitPolling();
    if (s.documents === 0) summary.textContent += ' — add documents under raw/docs first';
  } catch (e) {
    summary.textContent = `unavailable: ${e.message}`;
  }
}

function renderInitJob(job) {
  $('#init-progress').hidden = false;
  const steps = job.steps ?? job.payload?.steps ?? [];
  $('#init-steps').innerHTML = steps.map((s) => `<li data-status="${esc(s.status)}"><b>${esc(STEP_LABELS[s.name] ?? s.name)}</b><span>${esc(s.detail ?? s.status)}</span></li>`).join('')
    || `<li data-status="running"><b>Starting…</b><span>${esc(job.status)}</span></li>`;
  const phases = job.phases?.length ? job.phases : job.payload?.phases ?? [];
  $('#init-phases').innerHTML = phases.length
    ? `<span class="hint">agent</span>${phases.map((p) => `<span class="jstatus ${p.error ? 'failed' : 'done'}" title="${esc(p.role ?? '')}${p.error ? ` · ${esc(p.error)}` : ''}">${esc(p.label)}${p.turns ? ` · ${p.turns}t` : ''}</span>`).join('')}`
    : '';
  const topics = job.payload?.topics ?? [];
  $('#init-topics').innerHTML = topics.length
    ? `<span class="hint">follow-up pages</span>${topics.map((t) => `<span class="chat-chip">${esc(t.kind)} · ${esc(t.target)}${t.queued ? '' : ' (not queued)'}</span>`).join('')}`
    : '';
  $('#init-error').textContent = job.error ?? '';
}

function watchInitJob(id) {
  stopInitPolling();
  initJobId = id;
  const tick = async () => {
    if (initJobId !== id || currentTab !== 'wiki') return;
    try {
      const job = await api(`/api/research/jobs/${id}`);
      renderInitJob(job);
      if (jobIsLive(job.status)) {
        initJobTimer = setTimeout(tick, 3000);
      } else {
        $('#btn-init-kb').disabled = false;
        toast(job.status === 'done' ? 'knowledge base initialized' : `initialization ${job.status}`);
        loadInitCard();
        loadResearchJobs();
        loadResearchPages();
      }
    } catch {
      initJobTimer = setTimeout(tick, 5000);
    }
  };
  initJobTimer = setTimeout(tick, 1500);
}

$('#btn-init-kb').addEventListener('click', async () => {
  const button = $('#btn-init-kb');
  button.disabled = true;
  try {
    const res = await api('/api/research/init', { method: 'POST' });
    toast(res.created ? 'initialization queued' : `already queued: ${res.job.id}`);
    $('#init-progress').hidden = false;
    renderInitJob(res.job);
    watchInitJob(res.job.id);
    loadResearchJobs();
  } catch (e) {
    button.disabled = false;
    toast(`could not start: ${e.message}`);
  }
});

/* --------------------------------- chat -------------------------------- */

let chatConversations = [];
let chatActiveId = null;
let chatPollTimer = null;

function stopChatPolling() {
  clearTimeout(chatPollTimer);
  chatPollTimer = null;
}

/** Whether a question asked now would be answered, and if not, what to fix. */
let chatReadiness = null;

async function loadChat() {
  chatReadiness = await api('/api/chat/readiness').catch(() => null);
  paintChatReadiness();
  try {
    chatConversations = await api('/api/chat/conversations?limit=50');
  } catch (e) {
    $('#chat-list').innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
    return;
  }
  renderChatList();
  if (!chatActiveId || !chatConversations.some((c) => c.id === chatActiveId)) {
    if (chatConversations.length) await openConversation(chatConversations[0].id);
    else renderChatThread(null);
  } else {
    await openConversation(chatActiveId);
  }
}

function renderChatList() {
  const el = $('#chat-list');
  if (!chatConversations.length) {
    el.innerHTML = '<p class="hint">no conversations yet</p>';
    return;
  }
  el.innerHTML = '';
  for (const c of chatConversations) {
    const div = document.createElement('div');
    div.className = `chat-item${c.id === chatActiveId ? ' active' : ''}`;
    div.innerHTML = `<span class="chat-item-title">${esc(c.title || '(untitled)')}</span>
      <span class="hint">${esc(new Date(c.updatedAt).toLocaleString())}</span>
      <button data-del title="Delete this conversation">✕</button>`;
    div.addEventListener('click', (ev) => { if (!ev.target.hasAttribute('data-del')) openConversation(c.id); });
    div.querySelector('button[data-del]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await api(`/api/chat/conversations/${c.id}`, { method: 'DELETE' });
        if (chatActiveId === c.id) chatActiveId = null;
        loadChat();
      } catch (e) {
        toast(`delete failed: ${e.message}`);
      }
    });
    el.appendChild(div);
  }
}

async function openConversation(id) {
  chatActiveId = id;
  renderChatList();
  try {
    const conversation = await api(`/api/chat/conversations/${id}`);
    renderChatThread(conversation);
    // the turn may have finished while another tab was open: the composer follows the server, not the last poll
    if (conversation.running) startChatPolling();
    else setChatBusy(false);
  } catch (e) {
    $('#chat-thread').innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

function renderChatThread(conversation) {
  const el = $('#chat-thread');
  if (!conversation) {
    el.innerHTML = chatReadiness && chatReadiness.ready === false
      ? `<p class="hint"><b>Ask has nothing to run on.</b> ${esc(chatReadiness.hint ?? '')}
         <button type="button" class="hint-action" data-open-providers>open Providers &amp; Agents</button></p>`
      : '<p class="hint">Ask a question. An agent answers over your files, graph and wiki — it can follow leads across several turns, and writes what you teach it as a quarantined note you can adopt.</p>';
    el.querySelector('[data-open-providers]')?.addEventListener('click', () => navigate('providers'));
    return;
  }
  el.innerHTML = '';
  for (const m of conversation.messages ?? []) {
    const div = document.createElement('div');
    div.className = `chat-msg ${m.role}`;
    const body = m.content ? renderMd(m.content) : `<p class="hint">${esc(m.error ? `(${m.error})` : '(empty reply)')}</p>`;
    div.innerHTML = `<div class="markdown">${body}</div>`;
    if (m.role === 'assistant') {
      const chips = document.createElement('div');
      chips.className = 'chat-chips';
      for (const ev of m.events ?? []) {
        const chip = document.createElement('span');
        chip.className = `chat-chip${ev.ok === false ? ' bad' : ''}`;
        chip.textContent = ev.tool === 'wrote' ? `wrote ${ev.summary}` : `${ev.tool}${ev.summary ? `: ${ev.summary}` : ''}`;
        chips.appendChild(chip);
        if (ev.tool === 'wrote' && ev.path) {
          const open = document.createElement('button');
          open.textContent = 'open';
          open.addEventListener('click', () => {
            navigate('files');
            openFile(ev.path);
          });
          const promote = document.createElement('button');
          promote.textContent = 'adopt';
          promote.title = 'Promote this note from quarantined to trusted';
          promote.addEventListener('click', async () => {
            try {
              await api('/api/trust', { method: 'POST', body: JSON.stringify({ path: ev.path, to: 'trusted' }) });
              toast(`${ev.path}: trusted`);
            } catch (e) {
              toast(`adopt failed: ${e.message}`);
            }
          });
          chips.append(open, promote);
        }
      }
      if (m.error && m.content) chips.insertAdjacentHTML('beforeend', `<span class="chat-chip bad">${esc(m.error)}</span>`);
      if (chips.childElementCount) div.appendChild(chips);
    }
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

function renderChatActivity(activity) {
  const el = $('#chat-activity');
  el.hidden = false;
  el.innerHTML = `<span class="chat-chip working">answering…</span>${(activity ?? []).map((ev) => `<span class="chat-chip${ev.ok === false ? ' bad' : ''}">${esc(ev.tool)}${ev.summary ? `: ${esc(ev.summary)}` : ''}</span>`).join('')}`;
}

function setChatBusy(busy) {
  // an unready composer stays disabled when the turn ends
  $('#btn-chat-send').disabled = busy || Boolean(chatReadiness && chatReadiness.ready === false);
  $('#btn-chat-cancel').hidden = !busy;
  $('#chat-activity').hidden = !busy;
}

function startChatPolling() {
  stopChatPolling();
  setChatBusy(true);
  renderChatActivity([]);
  const id = chatActiveId;
  const tick = async () => {
    if (chatActiveId !== id) return;
    try {
      const status = await api(`/api/chat/conversations/${id}/status`);
      if (status.status === 'running') {
        renderChatActivity(status.activity);
        chatPollTimer = setTimeout(tick, 1500);
        return;
      }
    } catch {
      /* transient */
    }
    setChatBusy(false);
    stopChatPolling();
    if (chatActiveId === id) {
      await openConversation(id);
      loadChat();
    }
  };
  chatPollTimer = setTimeout(tick, 900);
}

async function newConversation() {
  const conversation = await api('/api/chat/conversations', { method: 'POST', body: JSON.stringify({}) });
  chatConversations.unshift(conversation);
  chatActiveId = conversation.id;
  renderChatList();
  renderChatThread(conversation);
  return conversation;
}

async function askQuestion(text) {
  const thread = $('#chat-thread');
  const mine = document.createElement('div');
  mine.className = 'chat-msg user';
  mine.innerHTML = `<div class="markdown">${renderMd(text)}</div>`;
  thread.appendChild(mine);
  thread.scrollTop = thread.scrollHeight;
  const res = await api(`/api/chat/conversations/${chatActiveId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
  if (res.status === 'running') {
    startChatPolling();
  } else {
    $('#chat-activity').hidden = true;
    await openConversation(chatActiveId);
    chatConversations = await api('/api/chat/conversations?limit=50');
    renderChatList();
  }
}

async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    if (!chatActiveId) await newConversation();
  } catch (e) {
    input.value = text;
    toast(`could not start a conversation: ${e.message}`);
    return;
  }
  try {
    await askQuestion(text);
  } catch (e) {
    // a 503 is a configuration answer, not a failed send: show the screen that
    // says what to fix rather than a toast that scrolls away
    if (e.reason) {
      chatReadiness = { ready: false, reason: e.reason, hint: e.message };
      paintChatReadiness();
      renderChatThread(null);
      return;
    }
    toast(`send failed: ${e.message}`);
    // 409 means another client is already answering — resync and follow that turn instead
    await openConversation(chatActiveId);
  }
}

$('#btn-chat-new').addEventListener('click', async () => {
  try {
    await newConversation();
    $('#chat-input').focus();
  } catch (e) {
    toast(`could not start a conversation: ${e.message}`);
  }
});

/** A composer that cannot answer says so on the button rather than on send. */
function paintChatReadiness() {
  const blocked = Boolean(chatReadiness && chatReadiness.ready === false);
  $('#btn-chat-send').disabled = blocked;
  $('#btn-chat-send').title = blocked ? (chatReadiness.hint ?? '') : 'a reply runs an agent session, which can take minutes';
}

$('#chat-composer').addEventListener('submit', (ev) => { ev.preventDefault(); sendChat(); });
$('#chat-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendChat();
  }
});
$('#btn-chat-cancel').addEventListener('click', async () => {
  if (!chatActiveId) return;
  try {
    await api(`/api/chat/conversations/${chatActiveId}/cancel`, { method: 'POST' });
    toast('stopping…');
  } catch (e) {
    toast(`cancel failed: ${e.message}`);
  }
});

/* ------------------------------ settings ------------------------------- */

let loadedConfig = null;

const providerNames = {
  inherit: 'Default model',
  openai: 'OpenAI-compatible API',
  'codex-cli': 'Codex CLI',
  'claude-cli': 'Claude Code CLI',
  'cursor-cli': 'Cursor Agent CLI',
};

const cliMeta = {
  'codex-cli': { command: 'codex exec', path: 'codex', note: 'Uses your existing Codex login in read-only one-shot mode.' },
  'claude-cli': { command: 'claude -p', path: 'claude', note: 'Uses your existing Claude Code login for one non-interactive turn.' },
  'cursor-cli': { command: 'cursor-agent -p', path: 'cursor-agent', note: 'Uses your existing Cursor Agent login in headless print mode.' },
};

/**
 * GET /api/config/providers: what `provider` may name on this service — the
 * built-ins plus whatever its loaded plugins registered, each with the config
 * fields it reads. The names above are the fallback for a service that does
 * not answer it.
 */
let providerCatalog = { llm: [], embedding: [], storage: [], converters: [] };
const LLM_FIELDS_DEFAULT = ['baseUrl', 'apiKey', 'protocol', 'model'];

function applyProviderCatalog(catalog) {
  providerCatalog = { llm: [], embedding: [], storage: [], converters: [], ...(catalog || {}) };
  for (const p of providerCatalog.llm) {
    providerNames[p.id] = p.label;
    if (p.note && !LLM_NOTES[p.id]) LLM_NOTES[p.id] = p.note;
  }
  for (const p of providerCatalog.embedding) {
    if (!EMBEDDING_PROVIDER_OPTIONS.some(([id]) => id === p.id)) EMBEDDING_PROVIDER_OPTIONS.push([p.id, p.label]);
    if (p.note && !EMB_NOTES[p.id]) EMB_NOTES[p.id] = p.note;
  }
}

/** The providers a connection row may pick: endpoints and other non-agent kinds (the coding-agent CLIs are agents, in the table below). */
function connectionProviderOptions(selected) {
  const listed = providerCatalog.llm.filter((p) => p.kind !== 'cli').map((p) => [p.id, p.label]);
  const pairs = listed.length ? listed : [['openai', providerNames.openai]];
  if (selected && !pairs.some(([id]) => id === selected)) pairs.push([selected, providerNames[selected] ?? selected]);
  return pairs;
}

/** Which fields a connection's provider reads; the OpenAI-compatible set when the service did not say. */
function llmProviderFields(provider) {
  return providerCatalog.llm.find((p) => p.id === provider)?.fields ?? LLM_FIELDS_DEFAULT;
}

/* ---------- the model picker, shared by every model field ---------- */

/**
 * Model lists the settings screen has already fetched, keyed by route. The
 * service caches by endpoint underneath, so this only saves the round trip —
 * but that is what makes reopening a dropdown instant.
 */
const modelLists = new Map();

function closeModelPicker() {
  document.querySelector('.model-picker')?.remove();
  document.removeEventListener('click', onModelPickerOutside, true);
  window.removeEventListener('keydown', onModelPickerKey);
  window.removeEventListener('resize', closeModelPicker);
}

function onModelPickerOutside(event) {
  const picker = document.querySelector('.model-picker');
  if (picker && !picker.contains(event.target) && !event.target.closest('.model-chevron')) closeModelPicker();
}

function onModelPickerKey(event) {
  if (event.key === 'Escape') closeModelPicker();
}

function renderModelPicker(picker, spec, input) {
  const state = modelLists.get(modelListKey(spec));
  const filter = picker.querySelector('.model-filter')?.value?.trim().toLowerCase() ?? '';
  const models = state?.result?.models ?? [];
  const shown = filter
    ? models.filter((m) => m.id.toLowerCase().includes(filter) || (m.label ?? '').toLowerCase().includes(filter))
    : models;
  const sourceLabel = { api: 'from the endpoint', cli: 'from the CLI' }[state?.result?.source] ?? 'suggestions';

  picker.innerHTML = `
    <div class="model-picker-head">
      <b>Models</b>
      ${state?.result ? `<span class="section-badge${state.result.source === 'builtin' ? ' accent2' : ''}">${esc(sourceLabel)}</span>` : ''}
      ${state?.loading ? '<span class="hint">asking…</span>' : ''}
      <button type="button" class="ghost model-refresh" title="Ask the provider again">⟳</button>
    </div>
    ${models.length ? `<input class="model-filter" placeholder="Filter ${models.length} models" value="${esc(filter)}" />` : ''}
    ${models.length ? `<div class="model-list">${shown
      .map((m) => `<button type="button" class="model-option${m.id === input.value ? ' selected' : ''}" data-model="${esc(m.id)}"><span class="mono">${esc(m.id)}</span>${m.label ? `<small>${esc(m.label)}</small>` : ''}</button>`)
      .join('') || '<p class="hint">Nothing matches.</p>'}</div>` : ''}
    ${!models.length && state?.loading ? '<p class="hint">Asking the provider…</p>' : ''}
    ${!models.length && state?.result && !state.result.error ? '<p class="hint">This provider lists no models — type the id you want.</p>' : ''}
    ${state?.error || state?.result?.error ? `<p class="jerr">${esc(state.error ?? state.result.error)}</p>` : ''}
    ${state?.result?.note ? `<p class="hint">${esc(state.result.note)}</p>` : ''}
    ${state?.result?.cached && state.result.cachedAt ? `<p class="hint">Cached — the service last asked at ${esc(new Date(state.result.cachedAt).toLocaleTimeString())}.</p>` : ''}
    <p class="model-picker-foot">Picking one fills the field — Save &amp; apply writes it to the workspace config.</p>`;
}

async function loadModelList(spec, picker, input, refresh = false) {
  const key = modelListKey(spec);
  const state = modelLists.get(key) ?? {};
  if (state.loading) return;
  if (state.result && !refresh) return;
  modelLists.set(key, { ...state, loading: true, error: null });
  renderModelPicker(picker, spec, input);
  try {
    const config = gatherConfig();
    // a provider override asks the default route as if that CLI — at that
    // path — were selected
    if (spec.provider) config.llm = { ...config.llm, provider: spec.provider, baseUrl: '', apiKey: '', model: '', cliPath: spec.cliPath || '' };
    const result = await api('/api/config/models', {
      method: 'POST',
      body: JSON.stringify({ route: spec.route, refresh, config }),
    });
    modelLists.set(key, { loading: false, result, error: result.error ?? null });
  } catch (e) {
    modelLists.set(key, { loading: false, result: state.result, error: e.message });
  }
  if (document.body.contains(picker)) renderModelPicker(picker, spec, input);
}

function openModelPicker(anchor, input, spec) {
  closeModelPicker();
  const picker = document.createElement('div');
  picker.className = 'model-picker';
  document.body.appendChild(picker);
  renderModelPicker(picker, spec, input);

  const box = anchor.getBoundingClientRect();
  const size = picker.getBoundingClientRect();
  picker.style.left = `${Math.max(6, Math.min(box.right - 430, window.innerWidth - 436))}px`;
  picker.style.top = `${Math.min(box.bottom + 4, window.innerHeight - size.height - 6)}px`;

  picker.addEventListener('click', (event) => {
    const option = event.target.closest('.model-option');
    if (option) {
      input.value = option.dataset.model;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      closeModelPicker();
      return;
    }
    if (event.target.closest('.model-refresh')) loadModelList(spec, picker, input, true);
  });
  picker.addEventListener('input', (event) => {
    if (event.target.classList.contains('model-filter')) renderModelPicker(picker, spec, input);
  });

  setTimeout(() => {
    document.addEventListener('click', onModelPickerOutside, true);
    window.addEventListener('keydown', onModelPickerKey);
    window.addEventListener('resize', closeModelPicker);
  }, 0);

  loadModelList(spec, picker, input);
}

/** A model input keeps its free text and gains a chevron that lists what the provider offers. */
/**
 * Which `/api/config/models` route lists what a spec offers, and the draft to
 * list it against.
 *
 * An agent lists through its runtime: a deepagents agent on the model it runs
 * on, a CLI agent as that CLI at its own path. A CLI is not an endpoint, so
 * ask the default route with it swapped into the draft instead — the same
 * thing the macOS client does.
 */
function executorModelRoute(spec) {
  const agent = agentDrafts.find((a) => a.name === spec);
  if (agent) {
    if (CLI_PROVIDERS.includes(agent.executor)) return { route: 'llm', provider: agent.executor, cliPath: agent.cliPath || '' };
    const endpoint = modelEndpoint(agent);
    return endpoint ? { route: `connection:${endpoint.id}` } : { route: 'llm' };
  }
  if (!spec || spec === 'default') return { route: 'llm' };
  if (connectionById(spec)) return { route: `connection:${spec}` };
  // a bare CLI borrows the path of a CLI agent running it, as it runs
  return { route: 'llm', provider: spec, cliPath: llmTargets().find((t) => t.provider === spec)?.cliPath || '' };
}

/** The cache key: two chevrons on one route but different CLIs or paths are two lists. */
const modelListKey = ({ route, provider, cliPath }) => `${route}|${provider ?? ''}|${cliPath ?? ''}`;

function modelChevron(spec) {
  const { route, provider, cliPath } = typeof spec === 'string' ? { route: spec } : spec;
  return `<button type="button" class="model-chevron" data-route="${esc(route)}"${provider ? ` data-provider="${esc(provider)}"` : ''}${cliPath ? ` data-cli-path="${esc(cliPath)}"` : ''} title="List the models this provider offers">⌄</button>`;
}

document.addEventListener('click', (event) => {
  const chevron = event.target.closest?.('.model-chevron');
  if (!chevron) return;
  const input = chevron.parentElement.querySelector('input');
  if (input) openModelPicker(chevron, input, { route: chevron.dataset.route, provider: chevron.dataset.provider, cliPath: chevron.dataset.cliPath });
});

/**
 * Every endpoint and credential, as one table. Embedding providers, the
 * default LLM and the extra LLM connections are three shapes of the same row,
 * so the drafts below are the edit buffer that the rows, the stage pickers and
 * the save payload all read from.
 */
let connectionDrafts = [];
let embeddingDrafts = [];
let embeddingUse = '';
let embeddingPoolDraft = { enabled: false, model: 'bge-m3', dimensions: 1024, batchSize: 16 };
let embeddingUsage = [];
const defaultEmbeddingLimits = { requestsPerMinute: 60, tokensPerMinute: 100000, requestsPerDay: 5000, tokensPerDay: 1000000, concurrency: 2, resetTimezone: 'UTC' };
/** Which connection is the default — the mirror of `embeddingUse`. */
let llmUse = '';
/** Provider ids whose row is open, kept across a redraw. */
const expandedProviders = new Set();

function connectionById(id) {
  return connectionDrafts.find((c) => c.id === id);
}

/**
 * A CLI agent as a stage or the default sees it: a one-shot LLM — the mirror
 * of the service's `readAgentLlms`. The agent itself lives in `agentDrafts`.
 */
function agentTarget(agent) {
  return {
    id: agent.name,
    label: (agent.title || '').trim() || agent.name,
    provider: agent.executor,
    model: agent.model || '',
    cliPath: agent.cliPath || '',
    effort: agent.effort || 'default',
    agent: true,
  };
}

/**
 * Everything the default can run on: the models, then the CLI agents, called
 * one-shot — the mirror of the service's `llmTargets`. A model wins an id
 * clash, since it is what the config itself names. A stage can run on more —
 * see `routeTargets`.
 */
function llmTargets() {
  const agents = agentDrafts.filter((a) => CLI_PROVIDERS.includes(a.executor) && !connectionById(a.name)).map(agentTarget);
  return [...connectionDrafts, ...agents];
}

function targetById(id) {
  return llmTargets().find((t) => t.id === id);
}

/**
 * What the default is — a model, or on a machine with none a CLI agent — or
 * null while the lists are loading. A dangling `llmUse` falls back the way the
 * service's `activeLlm` does.
 */
function defaultConnection() {
  const targets = llmTargets();
  return targets.find((c) => c.id === llmUse) ?? targets[0] ?? null;
}

/** The model a deepagents agent runs on: the one it pins, or the default while that is a model. */
function modelEndpoint(agent) {
  if (CLI_PROVIDERS.includes(agent.executor)) return null;
  if (agent.executor === 'default') {
    const def = defaultConnection();
    return def?.provider === 'openai' ? def : null;
  }
  return connectionById(agent.executor) ?? null;
}

/**
 * An agent as a stage sees it, run once through its own loop: a CLI agent as
 * itself, a deepagents agent as the endpoint it runs on with its own model or
 * else the endpoint's — the service runs the deepagents loop there. null for
 * one that runs on nothing.
 */
function agentRouteTarget(agent) {
  if (CLI_PROVIDERS.includes(agent.executor)) return { ...agentTarget(agent), runtime: providerNames[agent.executor] ?? agent.executor };
  const endpoint = modelEndpoint(agent);
  if (!endpoint) return null;
  return {
    ...endpoint,
    id: agent.name,
    label: (agent.title || '').trim() || agent.name,
    model: (agent.model || '').trim() || endpoint.model,
    agent: true,
    runtime: 'deepagents',
  };
}

/**
 * Everything a stage can name: the models, then the CLI agents and the
 * deepagents agents — the mirror of the service's `routeTargets`. Not
 * `llmTargets`, because the default cannot be a deepagents agent: it may
 * follow the default.
 */
function routeTargets() {
  const agents = agentDrafts.filter((a) => !connectionById(a.name)).map(agentRouteTarget).filter(Boolean);
  return [...connectionDrafts, ...agents];
}

function routeTargetById(id) {
  return routeTargets().find((t) => t.id === id);
}

/**
 * What a stage runs on: the target it names, else the default — where the
 * service runs a stage naming nothing known, and what a save writes down.
 * There is no "follow the default" entry to leave it on.
 */
function stageUse(use) {
  return routeTargetById(use) ? use : (defaultConnection()?.id ?? '');
}

/**
 * The model a route runs with when it names none of its own — the mirror of
 * the service's `resolveRoutedLlmConfig`, over everything a stage can name.
 *
 * Shown as a Model field's placeholder and never written: an empty `model`
 * means "follow this provider", so pinning the string would stop the route
 * tracking the provider's own model.
 */
function inheritedModelFor(use) {
  return (routeTargetById(use) ?? defaultConnection())?.model || '';
}

/**
 * The same for an agent spec, which may be an agent *name* — and a name can
 * legitimately be `default`, so this never shares a lookup with the route rule.
 * The mirror of the service's `resolveAgentSpec`: a CLI agent carries its own
 * model and inherits nothing; a deepagents agent takes its model endpoint's; a
 * bare CLI borrows the model of a CLI agent running it, the default's first.
 */
function inheritedAgentModelFor(spec) {
  const wanted = (spec || '').trim();
  const agent = agentDrafts.find((a) => a.name === wanted);
  if (agent) {
    if (agent.model || CLI_PROVIDERS.includes(agent.executor)) return agent.model || '';
    return modelEndpoint(agent)?.model || '';
  }
  if (wanted === 'default') return defaultConnection()?.model || '';
  const target = targetById(wanted);
  if (target) return target.model || '';
  if (!CLI_PROVIDERS.includes(wanted)) return '';
  const def = defaultConnection();
  return ((def?.provider === wanted ? def : llmTargets().find((t) => t.provider === wanted))?.model) || '';
}

const EMBEDDING_PROVIDER_OPTIONS = [
  ['local', 'Local hashing · offline'],
  ['openai', 'OpenAI-compatible API'],
  ['ark-multimodal', 'Volcengine Ark · multimodal'],
];

const EMB_NOTES = {
  local: 'The local hashing embedder is private, offline and ready immediately. Dimensions can be tuned before the first index.',
  openai: 'Changing the API model or dimensions re-embeds the corpus after saving. Use env:VAR_NAME to keep the key out of the config file.',
  'ark-multimodal': 'Ark posts to /embeddings/multimodal and returns one vector per request, so Base URL ends at /api/v3 and Model is the endpoint id (ep-…). Dimensions must match the model (doubao-embedding-vision: 2048, or 1024 with the dimensions parameter sent).',
};

const LLM_NOTES = {
  openai: 'Any OpenAI-compatible endpoint works. Auto prefers the Responses API and falls back to Chat Completions when the endpoint has no such route — reasoning models lose less that way. An empty model disables the general LLM features; the deterministic pipeline keeps running.',
};

const embeddingProviderLabel = (provider) =>
  EMBEDDING_PROVIDER_OPTIONS.find(([v]) => v === provider)?.[1] ?? provider;

const activeEmbedding = () =>
  embeddingDrafts.find((e) => e.id === embeddingUse) ?? embeddingDrafts[0] ?? null;

/**
 * Where a stage runs, as the two things a person reads separately: who runs
 * it, and which model. They used to share one ellipsised line, which turned
 * "super-relay · ark/seed-evolving" into "super-relay…ed-evolving".
 */
const summaryLine = (t) => (t.model ? `${t.provider} · ${t.model}` : t.provider);

function embeddingSummaryText() {
  if (embeddingPoolDraft.enabled) return { provider: 'Model pool', model: embeddingPoolDraft.model };
  const active = activeEmbedding();
  if (!active) return { provider: 'Loading…', model: '' };
  const name = active.label || active.id;
  if (active.provider === 'local') return { provider: name, model: `${active.dimensions || 384}d` };
  return { provider: name, model: active.model || 'API model not set' };
}

function routeSummary(prefix) {
  const use = $(`#cfg-${prefix}-use`).value;
  const model = $(`#cfg-${prefix}-model`).value.trim();
  // a stage names what it runs on; one naming nothing known runs on the default
  const target = routeTargetById(use) ?? defaultConnection();
  return {
    provider: target ? target.label?.trim() || providerNames[target.provider] || target.id : 'Not configured',
    // an inheriting model prints what it inherits, not a blank
    model: model || inheritedModelFor(use),
  };
}

/** Rebuild the Index picker from the configured embedding providers. */
function fillEmbeddingOptions() {
  const select = $('#cfg-embedding-use');
  select.innerHTML = embeddingDrafts
    .map((e) => `<option value="${esc(e.id)}">${esc(e.label || e.id)}</option>`)
    .join('');
  select.value = embeddingDrafts.some((e) => e.id === embeddingUse) ? embeddingUse : (embeddingDrafts[0]?.id ?? '');
  embeddingUse = select.value;
  select.disabled = embeddingPoolDraft.enabled;
  $('#cfg-embedding-route-note').textContent = embeddingPoolDraft.enabled
    ? `Automatic routing · ${embeddingPoolDraft.model} · ${poolEligibleKeys().length} compatible keys. Manage the pool in Providers & Agents.`
    : 'Enable a model pool in Providers & Agents to share compatible keys.';
}

const canonicalEmbeddingModel = (model) => ['bge-m3', 'baai/bge-m3', '@cf/baai/bge-m3'].includes((model || '').toLowerCase()) ? 'bge-m3' : model;
const poolEligibleKeys = () => embeddingDrafts.filter((e) => {
  const model = canonicalEmbeddingModel(embeddingPoolDraft.model);
  return e.enabled !== false && e.provider === 'openai' && [e.model, ...(e.catalog || [])].some((id) => canonicalEmbeddingModel(id) === model)
    && (model === 'bge-m3' ? embeddingPoolDraft.dimensions === 1024 : e.model === model && e.dimensions === embeddingPoolDraft.dimensions);
});

function renderEmbeddingPool() {
  const pool = embeddingPoolDraft;
  const models = [...new Set(embeddingDrafts.flatMap((e) => [e.model, ...(e.catalog || [])]).filter(Boolean).map(canonicalEmbeddingModel))].sort();
  $('#cfg-embedding-pool').innerHTML = `<div class="embedding-pool-head"><h4>Embedding model pool</h4>
    <label class="cfg-check"><input data-pool="enabled" type="checkbox"${pool.enabled ? ' checked' : ''} /> Automatic routing</label></div>
    <p class="cfg-callout">Choose one model. Compatible keys share the work. Lower priorities run first; equal priorities rotate. Unavailable keys cool down automatically.</p>
    <div class="cfg-grid cfg-grid-3">
      <label>Pool model<input data-pool="model" list="embedding-pool-models" value="${esc(pool.model)}" /><datalist id="embedding-pool-models">${models.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist></label>
      <label>Dimensions<input data-pool="dimensions" type="number" min="1" value="${pool.dimensions}" /></label>
      <label>Texts per request<input data-pool="batchSize" type="number" min="1" max="128" value="${pool.batchSize}" /></label>
    </div>
    <div class="embedding-pool-head"><span id="cfg-pool-members" class="mono">${poolEligibleKeys().length} compatible keys · ${embeddingDrafts.length} configured</span>
    <div class="cfg-actions"><button data-pool-action="models">Refresh all models</button><button data-pool-action="test"${pool.enabled ? '' : ' disabled'}>Test pool</button><button data-pool-action="usage">Refresh usage</button></div></div>
    <p class="cfg-callout">Pool vectors are L2-normalized. Only matching models and dimensions participate. Changing the pool model re-embeds the workspace; changing keys or limits does not.</p>
    <div id="cfg-pool-status" role="status"></div>
    <details><summary>Usage today · shared across workspaces</summary><div class="embedding-usage">${embeddingDrafts.filter((e) => e.provider === 'openai').map((e) => {
      const u = embeddingUsage.find((u) => u.id === e.id) || {};
      const limit = { ...defaultEmbeddingLimits, ...e.limits };
      const source = embeddingTokenSource(u);
      return `<div><span>${esc(e.label)}</span><span>${u.requestsToday || 0} / ${limit.requestsPerDay} req</span><span title="${esc(source.title)}">${u.tokensToday || 0} / ${limit.tokensPerDay} tokens${source.tag ? ` · ${source.tag}` : ''}</span><span>${u.cooldownUntil > Date.now() ? 'Cooling down' : esc(limit.resetTimezone)}</span></div>`;
    }).join('')}</div><p class="cfg-callout">App usage persists across restarts. Tokens are the provider's own count when its response includes one (SiliconFlow, OpenRouter), otherwise an estimate for the model (Cloudflare reports none). Other apps are not included. Zero limits block requests.</p></details>`;
}

// Which of today's tokens a provider counted. A day recorded before the split existed has none, so no tag.
function embeddingTokenSource(u) {
  const tokens = u.tokensToday || 0;
  if (!tokens || u.estimatedTokensToday == null) return { tag: '', title: '' };
  const estimated = Math.min(tokens, u.estimatedTokensToday);
  const tag = !estimated ? 'reported' : estimated === tokens ? 'estimated' : `${Math.round(100 * estimated / tokens)}% estimated`;
  return { tag, title: `${estimated} estimated · ${tokens - estimated} reported by the provider` };
}

async function refreshEmbeddingUsage() {
  const scope = activeWorkspace()?.id;
  const result = await api('/api/config/embedding-usage');
  if (activeWorkspace()?.id !== scope) return;
  embeddingUsage = result.entries || [];
  renderEmbeddingPool();
}

function embeddingKeyLimits(entry) {
  if (entry.provider !== 'openai') return '';
  const limits = { ...defaultEmbeddingLimits, ...entry.limits };
  const fields = [['requestsPerMinute', 'Requests / minute'], ['tokensPerMinute', 'Tokens / minute'], ['concurrency', 'Concurrent requests'], ['requestsPerDay', 'Requests / day'], ['tokensPerDay', 'Tokens / day']];
  return `<div class="embedding-key-limits"><div class="embedding-pool-head">
      <label class="cfg-check"><input data-field="enabled" type="checkbox"${entry.enabled !== false ? ' checked' : ''} /> Include in model pools</label>
      <button data-embedding-action="test">Test key</button></div>
    <div class="cfg-grid cfg-grid-3">${fields.map(([name, label]) => `<label>${label}<input data-limit="${name}" type="number" min="${name === 'concurrency' ? 1 : 0}" value="${limits[name]}" /></label>`).join('')}
      <label>Daily reset timezone<input data-limit="resetTimezone" value="${esc(limits.resetTimezone)}" /></label>
      <label>Priority · lower first<input data-field="priority" type="number" min="0" value="${entry.priority ?? 10}" /></label>
      <label>Shared account quota group<input data-field="quotaGroup" value="${esc(entry.quotaGroup || '')}" placeholder="Same account → same group" /></label>
      <label>OpenRouter upstream (optional)<input data-field="upstream" value="${esc(entry.upstream || '')}" placeholder="deepinfra/fp32" /></label>
    </div><p class="cfg-callout">${esc(entry.limitNote || 'Application limits. Use the same quota group for keys belonging to one provider account.')}</p>
    <div class="embedding-pool-head"><strong>Available embedding models · ${(entry.catalog || []).length}</strong><button data-embedding-action="models">Refresh models</button></div>
    <p class="embedding-catalog mono">${esc((entry.catalog || []).join(' · ') || 'Refresh to list the embedding models this key can access.')}</p></div>`;
}

/** The stages that name a model or an agent, by their fields' prefix (`#cfg-<prefix>-use`, `<prefix>Llm`). */
const ROUTE_PREFIXES = ['entity', 'document', 'summary', 'judge'];

/**
 * Rebuild the per-route pickers: the models under LLM, then every agent a
 * stage can run under Agent, each by its name alone. A stage names one of
 * them — there is no "Default LLM" entry, which sat beside the default's own
 * row as a second copy of it. Keeps a selection that still exists, else lands
 * on the default.
 */
function fillRouteOptions() {
  const agents = routeTargets().filter((t) => t.agent);
  const option = (t) => `<option value="${esc(t.id)}">${esc(t.label || t.id)}</option>`;
  for (const prefix of ROUTE_PREFIXES) {
    const select = $(`#cfg-${prefix}-use`);
    const previous = select.value;
    select.innerHTML = `<optgroup label="LLM">${connectionDrafts.map(option).join('')}</optgroup>`
      + (agents.length ? `<optgroup label="Agent">${agents.map(option).join('')}</optgroup>` : '');
    select.value = stageUse(previous);
  }
  refreshResearchAgentOptions();
}

/**
 * The five stages, in the order a document meets them: Convert and Index on
 * sync, Extract and Summarize in the background pass, and Judge, which decides
 * things — duplicates after each pass, disputes and Dream at night, knode_ask
 * on demand (docs/design/09). The flow draws one node each, and the inspector
 * below shows the panel of whichever is selected — the long explanations used
 * to be stacked five deep and cost two screens.
 */
const PIPELINE_STAGES = [
  { key: 'document', step: 1, title: 'Convert', badge: 'vision', accent: 'accent2' },
  { key: 'index', step: 2, title: 'Index', badge: 'embedding', accent: 'accent' },
  { key: 'entity', step: 3, title: 'Extract', badge: 'volume', accent: 'accent2' },
  { key: 'summary', step: 4, title: 'Summarize', badge: 'prose', accent: 'accent2' },
  { key: 'judge', step: 5, title: 'Judge', badge: 'quality', accent: 'accent2' },
];
let selectedStage = 'document';

function stageTarget(key) {
  if (key === 'index') return embeddingSummaryText();
  return routeSummary(key);
}

/** The rate a node reports: only the stages that have one show anything. */
function stageRate(key) {
  const int = (sel, fallback) => Number($(sel)?.value) || fallback;
  if (key === 'document') return `×${int('#cfg-ingest-convert', 2)}`;
  if (key === 'index') return `×${int('#cfg-ingest-concurrency', 4)} · ${int('#cfg-emb-batch', 32)}/req`;
  // Summarize runs in Extract's pass, at its rates
  if (key === 'entity' || key === 'summary') return `×${int('#cfg-extraction-concurrency', 1)} · ${int('#cfg-extraction-batch', 8)}/pass`;
  return '';
}

function renderStageFlow() {
  $('#stage-flow').innerHTML = PIPELINE_STAGES
    .map((stage, index) => {
      const target = stageTarget(stage.key);
      const node = `<button type="button" class="stage-node${stage.key === selectedStage ? ' selected' : ''}" data-stage="${stage.key}">
        <span class="stage-node-head"><i class="stage-step ${stage.accent}">${stage.step}</i>${esc(stage.title)}</span>
        <span class="section-badge ${stage.accent === 'accent2' ? 'accent2' : ''}">${esc(stage.badge)}</span>
        <span class="stage-node-target mono" title="${esc(summaryLine(target))}">${esc(target.provider)}</span>
        <span class="stage-node-model mono" title="${esc(summaryLine(target))}">${esc(target.model || 'its own model')}</span>
        <span class="stage-node-rate mono">${esc(stageRate(stage.key))}</span>
      </button>`;
      return index ? `<span class="stage-arrow">→</span>${node}` : node;
    })
    .join('');
  for (const panel of document.querySelectorAll('.stage-panel')) {
    panel.hidden = panel.dataset.stage !== selectedStage;
  }
}

function updateConfigSummaries() {
  renderStageFlow();
  paintInheritedPlaceholders();
}

/**
 * The greyed text in every Model field that is inheriting. Repainted from
 * here rather than only on a provider-picker change, because editing a
 * connection's own model changes what every stage on it will run.
 */
function paintInheritedPlaceholders() {
  for (const prefix of ROUTE_PREFIXES) {
    const input = $(`#cfg-${prefix}-model`);
    if (input) input.placeholder = inheritedModelFor($(`#cfg-${prefix}-use`).value) || 'Optional · use its model';
  }
  const research = $('#cfg-research-model');
  if (research) research.placeholder = inheritedAgentModelFor($('#cfg-research-agent').value) || 'CLI default';
}

function routeProviderToggle(prefix) {
  const note = $(`#cfg-${prefix}-note`);
  const target = routeTargetById($(`#cfg-${prefix}-use`).value) ?? defaultConnection();
  if (!target) {
    note.innerHTML = 'Nothing to run on yet — add a model in section 01.';
  } else if (target.provider === 'openai') {
    // a model called directly, or a deepagents agent: the loop on that model
    const how = target.agent ? ' · runs the deepagents loop' : '';
    note.innerHTML = `<b>${esc(target.label || target.id)}</b>${how} · ${esc((target.baseUrl || '').trim() || 'no endpoint set')}`;
  } else {
    // a CLI agent, run with its own path
    const meta = cliMeta[target.provider];
    note.innerHTML = `<b>${esc(target.label || target.id)}</b> · ${esc(target.cliPath || (meta ? meta.command : target.provider))}`;
  }
  updateConfigSummaries();
}

function fillRoute(prefix, route = {}) {
  $(`#cfg-${prefix}-use`).value = stageUse(route.use || '');
  $(`#cfg-${prefix}-model`).value = route.model || '';
  routeProviderToggle(prefix);
}

const optionsFor = (pairs, selected) =>
  pairs.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');

/** The shared row chrome; `fields` is the form the chevron opens. */
function providerRow({ kind, accent, id, label, placeholder, providerLabel, summary, isDefault, removable, promotable, fields }) {
  const open = expandedProviders.has(id);
  return `<div class="provider-row${open ? ' open' : ''}" data-id="${esc(id)}" data-kind="${kind}">
    <div class="provider-line">
      <button type="button" class="provider-toggle" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'}">${open ? '▾' : '▸'}</button>
      <span class="section-badge ${accent === 'accent2' ? 'accent2' : ''}">${esc(kind === 'embedding' ? 'embed' : 'llm')}</span>
      <input class="provider-name" data-field="label" value="${esc(label || '')}" placeholder="${esc(placeholder)}" />
      <span>${isDefault
        ? `<span class="section-badge ${accent === 'accent2' ? 'accent2' : ''}">default</span>`
        : promotable ? '<button type="button" class="hint-action provider-default" title="Every job that names no provider of its own moves here">make default</button>' : ''}</span>
      <span class="provider-kind">${esc(providerLabel)}</span>
      <span class="provider-model mono" title="${esc(summary || '')}">${esc(summary || 'no model set')}</span>
      <span class="provider-id mono">${esc(id)}</span>
      <button type="button" class="ghost provider-remove"${removable ? '' : ' disabled'} title="${removable ? 'Remove this provider' : 'This provider cannot be removed'}">✕</button>
    </div>
    ${open ? `<div class="provider-detail">${fields}</div>` : ''}
  </div>`;
}

function embeddingFields(entry) {
  const api = entry.provider !== 'local';
  return `<div class="cfg-grid cfg-grid-2">
      <label>Provider<select data-field="provider">${optionsFor(EMBEDDING_PROVIDER_OPTIONS, entry.provider)}</select></label>
      <label>Model<span class="model-field"><input data-field="model" value="${esc(entry.model || '')}" placeholder="${entry.provider === 'ark-multimodal' ? 'ep-…' : 'text-embedding-3-small'}"${api ? '' : ' disabled'} />${api ? modelChevron(`embedding:${entry.id}`) : ''}</span></label>
      <label class="cfg-span-2">Base URL<input data-field="baseUrl" value="${esc(entry.baseUrl || '')}" placeholder="https://api.openai.com/v1"${api ? '' : ' disabled'} /></label>
      <label>API key<input data-field="apiKey" type="password" value="${esc(entry.apiKey || '')}" placeholder="env:OPENAI_API_KEY"${api ? '' : ' disabled'} /></label>
      <label>Dimensions<input data-field="dimensions" type="number" min="1" step="1" value="${esc(entry.dimensions ?? '')}" /></label>
    </div>
    <label class="cfg-check"><input data-field="sendDimensions" type="checkbox"${entry.sendDimensions ? ' checked' : ''}${api ? '' : ' disabled'} /> Send the <span class="mono">dimensions</span> parameter with API requests</label>
    <p class="cfg-callout">${esc(EMB_NOTES[entry.provider] ?? EMB_NOTES.openai)}</p>${embeddingKeyLimits(entry)}`;
}

/**
 * An LLM row is a model endpoint: where it is, its key, its wire and which
 * model. The coding-agent CLIs that used to be picked here are agents now, in
 * the table below, with their path and effort.
 */
function llmFields(entry, route) {
  const provider = entry.provider || 'openai';
  // the form follows the provider: an endpoint shows its URL, key and wire; a
  // command its executable; a plugin provider whatever fields it declared
  const fields = llmProviderFields(provider);
  const has = (field) => fields.includes(field);
  const inputs = [];
  if (has('baseUrl')) inputs.push(`<label class="cfg-span-2">Base URL<input data-field="baseUrl" value="${esc(entry.baseUrl || '')}" placeholder="https://api.openai.com/v1" /></label>`);
  if (has('apiKey')) inputs.push(`<label>API key<input data-field="apiKey" value="${esc(entry.apiKey || '')}" placeholder="env:OPENAI_API_KEY" /></label>`);
  if (has('protocol')) inputs.push(`<label>Protocol<select data-field="protocol">${optionList(PROTOCOL_OPTIONS, entry.protocol || 'auto')}</select></label>`);
  if (has('cliPath')) inputs.push(`<label class="cfg-span-2">Executable<input data-field="cliPath" value="${esc(entry.cliPath || '')}" placeholder="/path/to/program" /></label>`);
  if (has('cliTimeoutMs')) inputs.push(`<label>Timeout (ms)<input data-field="cliTimeoutMs" type="number" min="1000" step="1000" value="${esc(entry.cliTimeoutMs ?? 300000)}" /></label>`);
  if (has('model')) inputs.push(`<label class="cfg-span-2">Model<span class="model-field"><input data-field="model" value="${esc(entry.model || '')}" placeholder="${provider === 'openai' ? 'gpt-4.1-mini' : 'model id'}" />${modelChevron(route)}</span></label>`);
  return `<div class="cfg-grid cfg-grid-2">
      <label>Provider<select data-field="provider">${optionsFor(connectionProviderOptions(provider), provider)}</select></label>
      ${inputs.join('\n      ')}
    </div>
    <p class="cfg-callout">${esc(LLM_NOTES[provider] ?? LLM_NOTES.openai)}</p>`;
}

function renderProviders() {
  renderEmbeddingPool();
  const rows = embeddingDrafts.map((e) =>
    providerRow({
      kind: 'embedding',
      accent: 'accent',
      id: e.id,
      label: e.label,
      placeholder: 'Name this provider',
      providerLabel: embeddingProviderLabel(e.provider),
      summary: e.provider === 'local' ? `hashing · ${e.dimensions || 384}d` : (e.model ? `${e.model} · ${e.dimensions || ''}d` : ''),
      isDefault: !embeddingPoolDraft.enabled && e.id === embeddingUse,
      // something has to embed, so the last one stays
      removable: embeddingDrafts.length > 1,
      fields: embeddingFields(e),
    }));

  // the default is an ordinary row that `llmUse` points at, so there is one
  // LLM row builder rather than one for the default and one for the rest
  for (const c of connectionDrafts) {
    rows.push(providerRow({
      kind: 'llm',
      accent: 'accent2',
      id: c.id,
      label: c.label,
      placeholder: 'Name this provider',
      providerLabel: providerNames[c.provider] ?? c.provider,
      summary: c.model,
      isDefault: c.id === (defaultConnection()?.id ?? ''),
      // something has to answer, so the last one stays
      removable: connectionDrafts.length > 1,
      promotable: true,
      fields: llmFields(c, `connection:${c.id}`),
    }));
  }

  $('#cfg-providers').innerHTML = rows.join('');
  fillEmbeddingOptions();
}

/** The draft one row edits, whichever of the three lists it came from. */
function providerDraft(id) {
  return embeddingDrafts.find((e) => e.id === id) ?? connectionById(id);
}

function addConnection() {
  let suffix = connectionDrafts.length + 1;
  while (connectionDrafts.some((c) => c.id === `connection-${suffix}`)) suffix += 1;
  const id = `connection-${suffix}`;
  connectionDrafts.push({
    id,
    label: `Connection ${suffix}`,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    protocol: 'auto',
    model: '',
    cliPath: '',
    effort: 'default',
  });
  expandedProviders.add(id);
  renderProviders();
  fillRouteOptions();
  updateConfigSummaries();
}

function addEmbeddingProvider() {
  let suffix = embeddingDrafts.length + 1;
  while (embeddingDrafts.some((e) => e.id === `embedding-${suffix}`)) suffix += 1;
  const id = `embedding-${suffix}`;
  embeddingDrafts.push({
    id,
    label: `Embedding ${suffix}`,
    provider: 'local',
    baseUrl: '',
    apiKey: '',
    model: '',
    dimensions: 384,
    sendDimensions: false,
  });
  expandedProviders.add(id);
  renderProviders();
  updateConfigSummaries();
}

/** Under the Extract stage: what the background passes still have to read (a long document counts its segments). */
async function showExtractionQueue() {
  const el = $('#cfg-extraction-queue');
  if (!el) return;
  try {
    const s = await api('/api/stats');
    el.textContent = s.extraction_queue ? `Queue: ${s.extraction_queue} documents, ${s.extraction_segments ?? s.extraction_queue} calls left.` : '';
  } catch {
    el.textContent = '';
  }
}

async function loadConfigForm({ preserveStatus = false } = {}) {
  // A workspace switch can happen while this request is in flight. Ignore a
  // response for the old workspace instead of painting its routes into the
  // newly selected workspace's form.
  const workspaceId = activeWorkspace()?.id;
  try {
    const cfg = await api('/api/config');
    if (activeWorkspace()?.id !== workspaceId) return;
    loadedConfig = cfg;
    // which providers this service knows — its plugins may add some
    try {
      applyProviderCatalog(await api('/api/config/providers'));
    } catch {
      // an older service: the built-in names above stay
    }
    if (activeWorkspace()?.id !== workspaceId) return;
    embeddingDrafts = (cfg.embeddingProviders ?? []).map((e) => ({ ...e }));
    embeddingUse = cfg.embeddingUse || embeddingDrafts[0]?.id || '';
    embeddingPoolDraft = { enabled: false, model: 'bge-m3', dimensions: 1024, batchSize: 16, ...cfg.embeddingPool };
    embeddingUsage = [];
    void refreshEmbeddingUsage().catch(() => {});
    connectionDrafts = (cfg.connections ?? []).map((c) => ({ ...c }));
    llmUse = cfg.llmUse || connectionDrafts[0]?.id || '';
    // agents before routes: a stage may run on an agent, and a route
    // filled before its agent exists would read — and then save — as the default
    await loadAgentsList();
    if (activeWorkspace()?.id !== workspaceId) return;
    renderProviders();
    fillRouteOptions();
    for (const prefix of ROUTE_PREFIXES) fillRoute(prefix, cfg.extraction?.[`${prefix}Llm`]);
    $('#cfg-extraction-batch').value = cfg.extraction?.batchSize ?? 8;
    $('#cfg-extraction-concurrency').value = cfg.extraction?.concurrency ?? 1;
    $('#cfg-extraction-claims').checked = cfg.extraction?.claims !== false;
    $('#cfg-review-judge').value = cfg.review?.llmJudge ?? 'suggest';
    $('#cfg-review-claims').value = cfg.review?.claims ?? 'suggest';
    $('#cfg-review-claim-merge').value = cfg.review?.claimMerge ?? 'auto';
    $('#cfg-extraction-segment').textContent = (cfg.extraction?.segmentChars ?? 12000).toLocaleString('en-US');
    void showExtractionQueue();
    $('#cfg-ingest-concurrency').value = cfg.ingest?.concurrency ?? 4;
    $('#cfg-ingest-convert').value = cfg.ingest?.convertConcurrency ?? 2;
    $('#cfg-emb-batch').value = embeddingPoolDraft.enabled ? embeddingPoolDraft.batchSize : activeEmbedding()?.batchSize ?? 32;
    fillResearchForm(cfg.research ?? {});
    fillChatForm(cfg.chat ?? {});
    renderAgents();
    // With no agent configured, pre-fill what the service says can run here. It
    // is only a pre-fill: nothing is saved until the person presses Save, so
    // "not configured" never quietly becomes a setting nobody chose.
    if (!cfg.research?.agent) {
      try {
        const { suggested } = await api('/api/config/agents');
        if (suggested && activeWorkspace()?.id === workspaceId) $('#cfg-research-agent').value = suggested;
      } catch {
        /* the picker still works; it just starts empty */
      }
    }
    updateConfigSummaries();
    try {
      await loadResearchProfiles(cfg.research?.profile);
    } catch (e) {
      $('#cfg-roles').innerHTML = `<p class="cfg-callout">research profiles unavailable: ${esc(e.message)}</p>`;
    }
    if (!preserveStatus) $('#cfg-status').innerHTML = '';
  } catch (e) {
    if (activeWorkspace()?.id !== workspaceId) return;
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">load failed: ${esc(e.message)}</div>`;
  }
}

function gatherRoute(prefix) {
  return {
    use: $(`#cfg-${prefix}-use`).value,
    model: $(`#cfg-${prefix}-model`).value.trim(),
    // the endpoint now lives on the connection; clear any pre-connections leftovers
    provider: 'inherit',
    baseUrl: '',
    apiKey: '',
    cliPath: '',
    cliTimeoutMs: loadedConfig?.extraction?.[`${prefix}Llm`]?.cliTimeoutMs || 300000,
  };
}

// '***' / 'env:…' are passed through verbatim; the server keeps the real secret.
function gatherConfig() {
  return {
    embeddingProviders: embeddingDrafts.map((e) => ({
      ...e,
      label: (e.label || '').trim() || e.id,
      // the request size is edited on the Index node, not in the provider row
      batchSize: !embeddingPoolDraft.enabled && e.id === embeddingUse ? Number($('#cfg-emb-batch').value) || e.batchSize : e.batchSize,
    })),
    embeddingUse,
    embeddingPool: { ...embeddingPoolDraft, ...(embeddingPoolDraft.enabled ? { batchSize: Number($('#cfg-emb-batch').value) || embeddingPoolDraft.batchSize } : {}) },
    ingest: {
      concurrency: Number($('#cfg-ingest-concurrency').value) || undefined,
      convertConcurrency: Number($('#cfg-ingest-convert').value) || undefined,
    },
    connections: connectionDrafts.map((c) => ({ ...c, label: c.label.trim() || c.id })),
    llmUse,
    extraction: {
      entityLlm: gatherRoute('entity'),
      documentLlm: gatherRoute('document'),
      summaryLlm: gatherRoute('summary'),
      judgeLlm: gatherRoute('judge'),
      batchSize: Number($('#cfg-extraction-batch').value),
      concurrency: Number($('#cfg-extraction-concurrency').value),
      claims: $('#cfg-extraction-claims').checked,
    },
    // what the Judge stage does with its verdicts
    review: {
      llmJudge: $('#cfg-review-judge').value,
      claims: $('#cfg-review-claims').value,
      claimMerge: $('#cfg-review-claim-merge').value,
    },
    research: gatherResearchConfig(),
    chat: gatherChatConfig(),
  };
}

/* ---------- 03 · agents: who runs a research job or a chat turn ---------- */

/**
 * Agents, one row each whichever runtime they have: the built-in deepagents
 * loop on one of the models above, or a coding-agent CLI that brings its own
 * loop, path and model. The CLIs used to sit among the models, which made
 * "cursor" the default *LLM* and let the deep agent quietly run Cursor.
 *
 * Each agent is its own file under `playbooks/agents/`, so unlike the rest of
 * this screen they are written the moment one is added or removed — Research
 * cannot point at a name that does not exist yet. Field edits still wait for
 * Save & apply, along with everything else.
 */
let agentDrafts = [];
const expandedAgents = new Set();

const AGENT_EFFORTS = [
  ['default', 'CLI default'], ['low', 'Low'], ['medium', 'Medium'],
  ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'], ['ultra', 'Ultra (codex)'],
];
const AGENT_WEB = [['inherit', 'Follow review.external'], ['on', 'On (within review.external)'], ['off', 'Off']];
const AGENT_TYPES = { 'claude-cli': 'Claude Code', 'codex-cli': 'Codex', 'cursor-cli': 'Cursor' };

const isCliAgent = (agent) => CLI_PROVIDERS.includes(agent.executor);

function agentById(name) {
  return agentDrafts.find((a) => a.name === name);
}

/** Where an agent runs, by the names the tables use. */
function agentRunsOn(agent) {
  if (isCliAgent(agent)) {
    const command = cliMeta[agent.executor]?.path ?? agent.executor;
    return agent.cliPath ? { name: agent.cliPath, help: agent.cliPath } : { name: 'From PATH', help: `${command}, found on the service PATH` };
  }
  if (agent.executor === 'default') {
    const def = defaultConnection();
    const name = def ? def.label || def.id : 'Default LLM';
    return { name, note: 'follows default', help: `Follows the default LLM — ${name} for now. Make another model the default and this agent moves with it.` };
  }
  const connection = connectionById(agent.executor);
  return connection ? { name: connection.label || connection.id, help: connection.baseUrl || '' } : { name: agent.executor || 'Not configured', help: '' };
}

/** The model a row runs: its own, else what its model endpoint brings. */
function agentModelSummary(agent) {
  if (agent.model) return { text: agent.model, help: agent.model, pinned: true };
  const endpoint = modelEndpoint(agent);
  if (endpoint?.model) return { text: endpoint.model, help: `Inherited from ${endpoint.label || endpoint.id}` };
  return { text: isCliAgent(agent) ? 'CLI default' : 'its own default', help: '' };
}

/** Why an agent cannot run, in words that say what to change; '' when it can. */
function agentProblem(agent) {
  if (isCliAgent(agent)) return '';
  const endpoint = modelEndpoint(agent);
  if (agent.executor === 'default' && !endpoint) return 'deepagents runs on a model, and the default is a CLI agent — pick a model for it.';
  if (!endpoint) return 'Its executor cannot run here — pick another one.';
  if (!endpoint.model && !agent.model) return `${endpoint.label || endpoint.id} has no model set.`;
  return '';
}

function deepagentsFields(agent) {
  const def = defaultConnection();
  const options = [`<option value="default"${agent.executor === 'default' ? ' selected' : ''}>Follow the default LLM${def ? ` · ${esc(def.label || def.id)}` : ''}</option>`]
    .concat(connectionDrafts.map((c) => `<option value="${esc(c.id)}"${c.id === agent.executor ? ' selected' : ''}>${esc(c.label || c.id)}</option>`))
    .join('');
  return `<div class="cfg-grid cfg-grid-2">
      <label>Runs on<select data-field="executor">${options}</select></label>
      <label>Model<span class="model-field"><input data-field="model" value="${esc(agent.model || '')}" placeholder="${esc(modelEndpoint(agent)?.model || 'Its own default')}" />${modelChevron(executorModelRoute(agent.name))}</span></label>
    </div>`;
}

function cliFields(agent) {
  const cliOptions = CLI_PROVIDERS.map((p) => `<option value="${p}"${p === agent.executor ? ' selected' : ''}>${esc(providerNames[p])}</option>`).join('');
  return `<div class="cfg-grid cfg-grid-2">
      <label>CLI<select data-field="executor">${cliOptions}</select></label>
      <label>Model<span class="model-field"><input data-field="model" value="${esc(agent.model || '')}" placeholder="Use CLI default" />${modelChevron(executorModelRoute(agent.name))}</span></label>
      <label>Reasoning effort<select data-field="effort">${optionList(AGENT_EFFORTS, agent.effort || 'default')}</select></label>
      <label>Web access<select data-field="web">${optionList(AGENT_WEB, agent.tools?.web ?? 'inherit')}</select></label>
      <label class="cfg-span-2">CLI executable<input data-field="cliPath" value="${esc(agent.cliPath || '')}" placeholder="Default: ${esc(cliMeta[agent.executor]?.path ?? '')} from PATH" /></label>
    </div>`;
}

function renderAgents() {
  const host = $('#cfg-agents');
  if (!agentDrafts.length) {
    host.innerHTML = '<p class="cfg-callout">No agents yet — add one: deepagents on one of the models above, or a coding-agent CLI on this machine.</p>';
    return;
  }
  host.innerHTML = agentDrafts
    .map((agent) => {
      const cli = isCliAgent(agent);
      const open = expandedAgents.has(agent.name);
      const where = agentRunsOn(agent);
      const model = agentModelSummary(agent);
      const problem = agentProblem(agent);
      const uses = [
        cli && agent.name === llmUse ? '<span class="section-badge">default</span>' : '',
        $('#cfg-research-agent')?.value === agent.name ? '<span class="section-badge accent2">research</span>' : '',
        $('#cfg-chat-agent')?.value === agent.name ? '<span class="section-badge">ask</span>' : '',
      ].join('');
      return `<div class="provider-row${open ? ' open' : ''}" data-agent="${esc(agent.name)}">
        <div class="provider-line">
          <button type="button" class="provider-toggle agent-toggle" aria-expanded="${open}">${open ? '▾' : '▸'}</button>
          <span class="section-badge${cli ? '' : ' accent2'}">${esc(cli ? AGENT_TYPES[agent.executor] : 'deepagents')}</span>
          <input class="provider-name" data-field="title" value="${esc(agent.title || '')}" placeholder="Name this agent" />
          <span>${uses}</span>
          <span class="provider-kind" title="${esc(where.help)}">${esc(where.name)}${where.note ? ` <span class="soft">· ${esc(where.note)}</span>` : ''}</span>
          <span class="provider-model mono${model.pinned ? ' pinned' : ''}" title="${esc(model.help)}">${esc(model.text)}</span>
          <span class="provider-id mono">${problem ? `<span title="${esc(problem)}">⚠</span> ` : ''}${esc(agent.name)}</span>
          <button type="button" class="ghost agent-remove" title="${agent.builtin ? 'Reset this template to its built-in' : 'Remove this agent'}">${agent.builtin ? '⟲' : '✕'}</button>
        </div>
        ${open ? `<div class="provider-detail">${cli ? cliFields(agent) : deepagentsFields(agent)}</div>` : ''}
      </div>`;
    })
    .join('');
}

async function loadAgentsList() {
  try {
    const body = await api('/api/agents');
    agentDrafts = body.agents.map((a) => ({ ...a }));
  } catch {
    agentDrafts = [];
  }
  renderAgents();
  // a stage and the research pickers may name an agent
  fillRouteOptions();
}

/**
 * A new agent is written straight away: Research cannot name what has no file.
 * deepagents follows the default LLM while the default is a model; when it is
 * a CLI agent there is nothing to follow, so the first model is pinned.
 */
async function addAgent(runtime) {
  const cli = CLI_PROVIDERS.includes(runtime);
  const base = cli ? runtime.replace(/-cli$/, '') : 'agent';
  const taken = new Set([...agentDrafts.map((a) => a.name), ...connectionDrafts.map((c) => c.id)]);
  let suffix = 1;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  const name = `${base}-${suffix}`;
  const def = defaultConnection();
  const executor = cli ? runtime : def?.provider === 'openai' ? 'default' : (connectionDrafts[0]?.id ?? 'default');
  try {
    await api(`/api/agents/${name}`, {
      method: 'PUT',
      body: JSON.stringify({
        agent: {
          title: cli ? providerNames[runtime] : 'New deepagents agent',
          executor,
        },
      }),
    });
    expandedAgents.add(name);
    await loadAgentsList();
  } catch (e) {
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">could not create the agent: ${esc(e.message)}</div>`;
  }
}

async function removeAgent(name) {
  try {
    const { reset } = await api(`/api/agents/${name}`, { method: 'DELETE' });
    expandedAgents.delete(name);
    // the service moves research, Ask, a pipeline route and the default off a
    // deleted agent, so read those back rather than keep a name that is gone
    const cfg = reset ? null : await api('/api/config');
    if (cfg) llmUse = cfg.llmUse || llmUse;
    await loadAgentsList();
    if (cfg) {
      $('#cfg-research-agent').value = cfg.research?.agent ?? '';
      $('#cfg-chat-agent').value = cfg.chat?.agent ?? '';
      for (const prefix of ROUTE_PREFIXES) {
        $(`#cfg-${prefix}-use`).value = stageUse(cfg.extraction?.[`${prefix}Llm`]?.use ?? '');
        routeProviderToggle(prefix);
      }
      renderProviders();
      refreshResearchAgentOptions();
      renderAgents();
    }
  } catch (e) {
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">could not remove the agent: ${esc(e.message)}</div>`;
  }
}

/** Each agent is its own file, so Save & apply writes them beside the config. */
async function saveAgents() {
  for (const agent of agentDrafts) {
    await api(`/api/agents/${agent.name}`, {
      method: 'PUT',
      body: JSON.stringify({
        agent: {
          title: (agent.title || '').trim() || agent.name,
          executor: agent.executor,
          cliPath: agent.cliPath ?? '',
          model: agent.model ?? '',
          effort: agent.effort ?? 'default',
          // set in the macOS app's effort chip; kept, not edited, here
          speed: agent.speed ?? 'default',
          tools: { web: agent.tools?.web ?? 'inherit' },
        },
      }),
    });
  }
}

for (const id of ['#cfg-research-agent', '#cfg-chat-agent']) {
  $(id).addEventListener('change', () => {
    renderAgents();
    paintInheritedPlaceholders();
  });
}

$('#cfg-add-agent').addEventListener('click', (event) => {
  showMenuUnder(event.currentTarget, [
    { label: 'deepagents · on the default LLM', run: () => addAgent('deepagents') },
    ...CLI_PROVIDERS.map((p) => ({ label: providerNames[p], run: () => addAgent(p) })),
  ]);
});

$('#cfg-agents').addEventListener('input', (event) => {
  const row = event.target.closest?.('.provider-row');
  const field = event.target.dataset?.field;
  const agent = row && agentById(row.dataset.agent);
  if (!agent || !field || event.target.tagName === 'SELECT') return;
  agent[field] = event.target.value;
  // the model list is the CLI's at this path, not at the one it was drawn with
  if (field === 'cliPath') row.querySelector('.model-chevron')?.setAttribute('data-cli-path', agent.cliPath);
  // a CLI agent's name and model are what a stage or the default shows
  if (field === 'title') fillRouteOptions();
  if (field === 'model' || field === 'title') {
    const cell = row.querySelector('.provider-model');
    const summary = agentModelSummary(agent);
    cell.textContent = summary.text;
    cell.title = summary.help;
    cell.classList.toggle('pinned', Boolean(summary.pinned));
    updateConfigSummaries();
  }
});

$('#cfg-agents').addEventListener('change', (event) => {
  const row = event.target.closest?.('.provider-row');
  const field = event.target.dataset?.field;
  const agent = row && agentById(row.dataset.agent);
  if (!agent || !field) return;
  if (field === 'web') {
    agent.tools = { ...agent.tools, web: event.target.value };
    return;
  }
  if (field !== 'executor' && field !== 'effort') return;
  agent[field] = event.target.value;
  if (field === 'executor') {
    renderAgents();
    fillRouteOptions();
    updateConfigSummaries();
  }
});

$('#cfg-agents').addEventListener('click', (event) => {
  const row = event.target.closest?.('.provider-row');
  if (!row) return;
  const name = row.dataset.agent;
  if (event.target.classList.contains('agent-toggle')) {
    if (expandedAgents.has(name)) expandedAgents.delete(name); else expandedAgents.add(name);
    renderAgents();
    return;
  }
  if (event.target.classList.contains('agent-remove')) removeAgent(name);
});

/* ---------- Settings · research: pipeline, initialization, profile; and Ask's chat block ---------- */
const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'cursor-cli'];
const PROTOCOL_OPTIONS = [
  ['auto', 'Auto (Responses, else Chat)'], ['responses', 'Responses only'], ['chat', 'Chat Completions only'],
];
const EFFORT_OPTIONS = [
  ['default', 'CLI default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max (claude & codex; cursor → high)'], ['ultra', 'Ultra (codex; claude → max)'],
];
const ROLE_PHASES = [
  ['plan', 'Plan · outline the page'], ['research', 'Research · one section'], ['synthesize', 'Synthesize · write the page'], ['review', 'Review · critique'], ['revise', 'Revise · fix issues'],
];
const ROLE_WEB = [['inherit', 'Profile setting'], ['on', 'On (within review.external)'], ['off', 'Off']];
let researchProfiles = [];
let profileDraft = null;
let profileDirty = false;

function optionList(pairs, selected) {
  return pairs.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

// `fallbackLabel` is the meaning of the empty value: "follow the one above" for
// chat and roles. The research agent has no such fallback any more — it gets
// null, and an empty value is shown as the unconfigured state it is.
//
// The choices are the agents in section 01, each saying which runtime it is. A
// config written before agents may name a bare CLI, the default or a model
// straight; those keep resolving, so the one in use stays listed — only that one.
function agentOptions(selected, fallbackLabel) {
  const opts = fallbackLabel
    ? [`<option value="">${esc(fallbackLabel)}</option>`]
    : [`<option value=""${selected ? ' disabled' : ' selected'}>Not configured — pick an agent</option>`];
  // in the order the agents table lists them: there is no kind to sort by
  for (const a of agentDrafts) {
    const runtime = isCliAgent(a) ? providerNames[a.executor] : 'deepagents';
    opts.push(`<option value="${esc(a.name)}"${a.name === selected ? ' selected' : ''}>${esc(a.title || a.name)} · ${esc(runtime)}</option>`);
  }
  if (selected && !agentById(selected)) {
    let legacy = selected;
    if (selected === 'default') {
      const def = defaultConnection();
      legacy = `Default LLM${def ? ` · ${def.label || def.id}` : ''}`;
    } else if (CLI_PROVIDERS.includes(selected)) {
      legacy = `${providerNames[selected]} · from PATH`;
    } else if (connectionById(selected)) {
      legacy = `${connectionById(selected).label || selected} · deepagents`;
    }
    opts.push(`<option value="${esc(selected)}" selected>${esc(legacy)}</option>`);
  }
  return opts.join('');
}

/** Only the CLIs ship a web tool; deepagents on a model searches the base only. */
function agentWebCapable(spec) {
  const agent = agentById(spec);
  if (agent) return isCliAgent(agent);
  if (CLI_PROVIDERS.includes(spec)) return true;
  const provider = spec === 'default' ? defaultConnection()?.provider : targetById(spec)?.provider;
  return CLI_PROVIDERS.includes(provider);
}

function refreshResearchAgentOptions() {
  const select = $('#cfg-research-agent');
  if (!select) return;
  const current = select.value;
  select.innerHTML = agentOptions(current, null);
  select.value = current;
  if (select.value !== current) select.value = '';
  const chatSelect = $('#cfg-chat-agent');
  if (chatSelect) {
    const chatCurrent = chatSelect.value;
    chatSelect.innerHTML = agentOptions(chatCurrent, 'The research agent, else the default provider');
    chatSelect.value = chatCurrent;
    if (chatSelect.value !== chatCurrent) chatSelect.value = '';
  }
  for (const roleSelect of document.querySelectorAll('#cfg-roles select[data-field="agent"]')) {
    const value = roleSelect.value;
    roleSelect.innerHTML = agentOptions(value, 'The research agent above');
    roleSelect.value = value;
  }
  updateResearchNote();
}

function fillResearchForm(research) {
  $('#cfg-research-agent').innerHTML = agentOptions(research.agent || '', null);
  $('#cfg-research-agent').value = research.agent || '';
  $('#cfg-research-model').value = research.model || '';
  paintInheritedPlaceholders();
  $('#cfg-research-pipeline').value = research.pipeline || 'team';
  $('#cfg-research-concurrency').value = research.concurrency ?? 1;
  $('#cfg-research-maxturns').value = research.maxTurns ?? 40;
  $('#cfg-research-timeout').value = Math.max(1, Math.round((research.timeoutMs ?? 1200000) / 60000));
  $('#cfg-research-researchers').value = research.researchers ?? 3;
  $('#cfg-research-rounds').value = research.reviewRounds ?? 1;
  $('#cfg-research-auto').checked = !!research.auto?.enabled;
  $('#cfg-research-daily').value = research.auto?.dailyJobs ?? 3;
  $('#cfg-init-maxms').value = Math.max(1, Math.round((research.init?.extractionMaxMs ?? 900000) / 60000));
  $('#cfg-init-followups').value = research.init?.followUps ?? 6;
  if (!$('#cfg-profile-effort').options.length) $('#cfg-profile-effort').innerHTML = optionList(EFFORT_OPTIONS, 'default');
}

async function loadResearchProfiles(preferred) {
  const r = await api('/api/research/profiles');
  researchProfiles = r.profiles ?? [];
  const select = $('#cfg-research-profile');
  select.innerHTML = researchProfiles.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.title && p.title !== p.name ? ` · ${esc(p.title)}` : ''}</option>`).join('');
  const want = preferred && researchProfiles.some((p) => p.name === preferred) ? preferred : r.active;
  select.value = want;
  await loadProfileDetail(select.value || r.active);
}

async function loadProfileDetail(name) {
  profileDraft = await api(`/api/research/profiles/${encodeURIComponent(name)}`);
  profileDirty = false;
  renderProfileForm();
}

function renderProfileForm() {
  const p = profileDraft;
  if (!p) return;
  $('#cfg-profile-name').textContent = p.name;
  $('#cfg-profile-title').value = p.title || '';
  $('#cfg-profile-desc').value = p.description || '';
  $('#cfg-profile-pipeline').value = p.pipeline || '';
  $('#cfg-profile-effort').innerHTML = optionList(EFFORT_OPTIONS, p.reasoning.effort);
  $('#cfg-profile-web').value = p.search.web;
  $('#cfg-profile-freshness').value = p.search.freshness;
  $('#cfg-profile-rounds').value = p.search.maxRounds;
  $('#cfg-profile-minsources').value = p.verification.minSourcesPerClaim;
  $('#cfg-profile-conflicts').value = p.verification.resolveConflicts;
  $('#cfg-profile-maxsections').value = p.stop.maxSections;
  $('#cfg-profile-primary').checked = !!p.verification.preferPrimarySources;
  $('#cfg-profile-marginal').checked = !!p.stop.marginalGain;
  $('#cfg-profile-citations').checked = !!p.output.citations;
  $('#cfg-profile-uncertainty').checked = !!p.output.uncertainty;
  $('#cfg-profile-evidence').checked = !!p.output.evidenceTable;
  $('#cfg-profile-delete').textContent = p.builtin ? 'Reset to built-in' : 'Delete';
  renderRoles();
  updateResearchNote();
}

function renderRoles() {
  const host = $('#cfg-roles');
  const roles = profileDraft?.roles ?? [];
  if (!roles.length) {
    host.innerHTML = '<p class="cfg-callout">No roles. The team pipeline needs at least a synthesize role; single-session mode ignores roles.</p>';
    return;
  }
  host.innerHTML = roles.map((r, index) => `<fieldset class="cfg-card cfg-role${r.enabled ? '' : ' cfg-role-off'}" data-index="${index}">
      <div class="cfg-connection-head">
        <label class="cfg-check cfg-role-enabled"><input type="checkbox" data-field="enabled"${r.enabled ? ' checked' : ''} /> On</label>
        <input class="cfg-conn-label" data-field="title" value="${esc(r.title || '')}" placeholder="Role title" />
        <span class="mono">${esc(r.id)} · ${esc(r.phase)}${r.native ? ' · native' : ''}</span>
        <button type="button" class="ghost cfg-role-remove" title="Remove this role">Remove</button>
      </div>
      <div class="cfg-grid cfg-grid-3">
        <label>Phase<select data-field="phase">${optionList(ROLE_PHASES, r.phase)}</select></label>
        <label>Runs on<select data-field="agent">${agentOptions(r.agent || '', 'The research agent above')}</select></label>
        <label>Model<input data-field="model" value="${esc(r.model || '')}" placeholder="${esc(inheritedAgentModelFor(r.agent || $('#cfg-research-agent').value) || "Agent's model")}" /></label>
        <label>Effort<select data-field="effort">${optionList([['default', 'Profile default'], ...EFFORT_OPTIONS.slice(1)], r.effort)}</select></label>
        <label>Web tools<select data-field="web">${optionList(ROLE_WEB, r.tools.web)}</select></label>
        <label>Turns per session<input data-field="maxTurns" type="number" min="0" step="1" value="${r.maxTurns || ''}" placeholder="Default" /></label>
        ${r.phase === 'research' ? `<label>Parallel sessions<input data-field="parallel" type="number" min="0" max="16" step="1" value="${r.parallel || ''}" placeholder="Researchers default" /></label>` : ''}
        ${r.phase === 'review' || r.phase === 'revise' ? `<label>Rounds<input data-field="rounds" type="number" min="0" max="6" step="1" value="${r.rounds || ''}" placeholder="Review rounds default" /></label>` : ''}
        <label class="cfg-span-2">Description<input data-field="description" value="${esc(r.description || '')}" placeholder="One line the orchestrator reads when picking this sub-agent" /></label>
      </div>
      <div class="cfg-checks">
        <label class="cfg-check"><input type="checkbox" data-field="write"${r.tools.write ? ' checked' : ''} /> Writes pages (knode_write / knode_commit)</label>
        <label class="cfg-check"><input type="checkbox" data-field="files"${r.tools.files ? ' checked' : ''} /> Reads files (Read / Grep / Glob)</label>
        <label class="cfg-check"><input type="checkbox" data-field="native"${r.native ? ' checked' : ''} /> Native sub-agent (pipeline: native)</label>
      </div>
      <div class="cfg-prompt">
        <div class="cfg-prompt-head"><span>Prompt</span><span class="mono">${esc(r.promptPath || '')}${r.promptIsDefault ? ' · built-in' : ''}</span><button type="button" class="ghost cfg-role-reset">Reset to built-in</button></div>
        <textarea data-field="promptText" rows="9" spellcheck="false">${esc(r.promptText || '')}</textarea>
      </div>
    </fieldset>`).join('');
}

function updateResearchNote() {
  const note = $('#cfg-research-note');
  if (!note) return;
  const p = profileDraft;
  const agentValue = $('#cfg-research-agent').value;
  // the selected option already reads the way the picker shows it
  const agentLabel = agentValue ? ($('#cfg-research-agent').selectedOptions[0]?.textContent || agentValue) : 'not configured';
  const pipeline = (p && p.pipeline) || $('#cfg-research-pipeline').value;
  const fanout = Number($('#cfg-research-researchers').value) || 1;
  const roles = p
    ? p.roles.filter((r) => r.enabled).map((r) => {
      const n = r.phase === 'research' ? (r.parallel || fanout) : 0;
      return `${r.id}${n > 1 ? ` ×${n}` : ''}${r.agent ? ` @${r.agent}` : ''}`;
    })
    : [];
  const parts = [`Agent: ${agentLabel}`, `pipeline: ${pipeline}${p && p.pipeline ? ' (pinned by profile)' : ''}`];
  const web = agentValue && !agentWebCapable(agentValue) ? 'none (built-in agent)' : p ? `${p.search.web} / ${p.search.freshness}` : null;
  if (p) parts.push(`effort: ${p.reasoning.effort}`);
  if (web) parts.push(`web: ${web}`);
  if (p) parts.push(`sources per fact: ${p.verification.minSourcesPerClaim}`);
  if (pipeline !== 'single') parts.push(`roles: ${roles.join(', ') || 'none'}`);
  const caveat = agentValue && !agentWebCapable(agentValue)
    ? ' The built-in agent has no web tool — it verifies against the knowledge base only.'
    : ' Web tools never exceed what review.external allows.';
  note.textContent = `${parts.join(' · ')}.${caveat}`;
}

function gatherResearchConfig() {
  return {
    agent: $('#cfg-research-agent').value,
    model: $('#cfg-research-model').value.trim(),
    profile: $('#cfg-research-profile').value,
    pipeline: $('#cfg-research-pipeline').value,
    concurrency: Number($('#cfg-research-concurrency').value) || 1,
    maxTurns: Number($('#cfg-research-maxturns').value) || 40,
    timeoutMs: (Number($('#cfg-research-timeout').value) || 20) * 60000,
    researchers: Number($('#cfg-research-researchers').value) || 3,
    reviewRounds: Math.max(0, Number($('#cfg-research-rounds').value) || 0),
    auto: { enabled: $('#cfg-research-auto').checked, dailyJobs: Number($('#cfg-research-daily').value) || 3 },
    init: {
      followUps: Math.max(0, Number($('#cfg-init-followups').value) || 0),
      // edited with the Extract stage under Ingest: it is how long the catch-up extraction may run
      extractionMaxMs: (Number($('#cfg-init-maxms').value) || 15) * 60000,
    },
  };
}

// The Ask tab. Model, effort and web access belong to the agent definition, and
// the turn cap, timeout and tools are the same for every agent; what is left
// here is a property of the conversation.
function fillChatForm(chat) {
  $('#cfg-chat-agent').innerHTML = agentOptions(chat.agent || '', 'The research agent, else the default provider', 'general');
  $('#cfg-chat-agent').value = chat.agent || '';
  $('#cfg-chat-history').value = chat.historyTurns ?? 12;
  $('#cfg-chat-keep').value = chat.keep ?? 200;
}

function gatherChatConfig() {
  return {
    agent: $('#cfg-chat-agent').value,
    historyTurns: Math.max(0, Number($('#cfg-chat-history').value) || 0),
    keep: Number($('#cfg-chat-keep').value) || 200,
  };
}

function gatherProfile(name) {
  const p = profileDraft;
  const roles = p.roles.map(({ promptText, promptPath, promptIsDefault, promptDefault, ...role }) => role);
  return {
    profile: {
      name: name || p.name,
      title: $('#cfg-profile-title').value.trim(),
      description: $('#cfg-profile-desc').value.trim(),
      pipeline: $('#cfg-profile-pipeline').value,
      // speed is set in the macOS app's effort chip; kept, not edited, here
      reasoning: { effort: $('#cfg-profile-effort').value, speed: p.reasoning?.speed ?? 'default' },
      search: { web: $('#cfg-profile-web').value, freshness: $('#cfg-profile-freshness').value, maxRounds: Number($('#cfg-profile-rounds').value) || 3 },
      verification: {
        minSourcesPerClaim: Number($('#cfg-profile-minsources').value) || 1,
        preferPrimarySources: $('#cfg-profile-primary').checked,
        resolveConflicts: $('#cfg-profile-conflicts').value,
      },
      stop: { maxSections: Number($('#cfg-profile-maxsections').value) || 8, marginalGain: $('#cfg-profile-marginal').checked },
      output: { citations: $('#cfg-profile-citations').checked, uncertainty: $('#cfg-profile-uncertainty').checked, evidenceTable: $('#cfg-profile-evidence').checked },
      roles,
    },
    prompts: Object.fromEntries(p.roles.map((r) => [r.id, r.promptText ?? ''])),
  };
}

async function saveResearchProfile() {
  if (!profileDraft) return null;
  const saved = await api(`/api/research/profiles/${encodeURIComponent(profileDraft.name)}`, { method: 'PUT', body: JSON.stringify(gatherProfile()) });
  profileDraft = saved;
  profileDirty = false;
  renderProfileForm();
  return saved;
}

function newRoleId(base) {
  const ids = new Set((profileDraft?.roles ?? []).map((r) => r.id));
  let id = base;
  let n = 2;
  while (ids.has(id)) id = `${base}-${n++}`;
  return id;
}

$('#cfg-research-profile').addEventListener('change', async (event) => {
  if (profileDirty && !window.confirm('Discard unsaved changes to the current profile?')) {
    event.target.value = profileDraft?.name ?? event.target.value;
    return;
  }
  try {
    await loadProfileDetail(event.target.value);
  } catch (e) {
    toast(`profile load failed: ${e.message}`);
  }
});
$('#cfg-research-agent').addEventListener('change', updateResearchNote);
$('#cfg-research-pipeline').addEventListener('change', updateResearchNote);
$('#cfg-research-researchers').addEventListener('input', updateResearchNote);

$('#cfg-profile-card').addEventListener('input', () => { profileDirty = true; });
$('#cfg-profile-card').addEventListener('change', (event) => {
  profileDirty = true;
  if (profileDraft && ['cfg-profile-effort', 'cfg-profile-web', 'cfg-profile-freshness', 'cfg-profile-pipeline', 'cfg-profile-minsources'].includes(event.target.id)) {
    const g = gatherProfile().profile;
    Object.assign(profileDraft, { pipeline: g.pipeline, reasoning: g.reasoning, search: g.search, verification: g.verification });
    updateResearchNote();
  }
});

$('#cfg-role-add').addEventListener('click', () => {
  if (!profileDraft) return;
  const phase = 'research';
  const id = newRoleId('role');
  const promptDefault = profileDraft.phaseDefaults?.[phase] ?? '';
  profileDraft.roles.push({
    id, title: 'New role', phase, enabled: true, agent: '', model: '', effort: 'default',
    tools: { write: false, files: true, web: 'inherit' }, parallel: 0, rounds: 0, maxTurns: 0, prompt: '', native: false, description: '',
    promptPath: `playbooks/research/roles/${id}.md`, promptText: promptDefault, promptIsDefault: true, promptDefault,
  });
  profileDirty = true;
  renderRoles();
  updateResearchNote();
});

// Typing edits the role draft in place; phase / native / enabled changes redraw the card.
$('#cfg-roles').addEventListener('input', (event) => {
  const field = event.target.dataset?.field;
  const card = event.target.closest('.cfg-role');
  if (!field || !card || !profileDraft) return;
  const role = profileDraft.roles[Number(card.dataset.index)];
  profileDirty = true;
  if (field === 'write' || field === 'files') role.tools[field] = event.target.checked;
  else if (field === 'web') role.tools.web = event.target.value;
  else if (field === 'enabled' || field === 'native') role[field] = event.target.checked;
  else if (['parallel', 'rounds', 'maxTurns'].includes(field)) role[field] = Math.max(0, Number(event.target.value) || 0);
  else if (field === 'promptText') {
    role.promptText = event.target.value;
    role.promptIsDefault = role.promptText.trim() === (role.promptDefault || '').trim();
  } else role[field] = event.target.value;
  if (field === 'title' || field === 'agent') updateResearchNote();
});
$('#cfg-roles').addEventListener('change', (event) => {
  const field = event.target.dataset?.field;
  const card = event.target.closest('.cfg-role');
  if (!field || !card || !profileDraft) return;
  const role = profileDraft.roles[Number(card.dataset.index)];
  if (field === 'phase') {
    const wasDefault = role.promptIsDefault || !role.promptText?.trim();
    role.phase = event.target.value;
    role.promptDefault = profileDraft.phaseDefaults?.[role.phase] ?? '';
    if (wasDefault) {
      role.promptText = role.promptDefault;
      role.promptIsDefault = true;
    }
    if (role.phase === 'synthesize' || role.phase === 'revise') role.tools.write = true;
  }
  if (['phase', 'native', 'enabled'].includes(field)) {
    renderRoles();
    updateResearchNote();
  }
});
$('#cfg-roles').addEventListener('click', (event) => {
  const card = event.target.closest('.cfg-role');
  if (!card || !profileDraft) return;
  const index = Number(card.dataset.index);
  if (event.target.classList.contains('cfg-role-remove')) {
    profileDraft.roles.splice(index, 1);
    profileDirty = true;
    renderRoles();
    updateResearchNote();
  } else if (event.target.classList.contains('cfg-role-reset')) {
    const role = profileDraft.roles[index];
    role.promptText = role.promptDefault || profileDraft.phaseDefaults?.[role.phase] || '';
    role.promptIsDefault = true;
    profileDirty = true;
    renderRoles();
  }
});

$('#cfg-profile-duplicate').addEventListener('click', async () => {
  if (!profileDraft) return;
  const name = window.prompt('Name for the new profile (letters, digits, - and _):', `${profileDraft.name}-copy`);
  if (!name) return;
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) {
    toast('invalid profile name');
    return;
  }
  try {
    await api(`/api/research/profiles/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(gatherProfile(name)) });
    await loadResearchProfiles(name);
    toast(`profile ${name} created — it is selected above; Save & apply makes it active`);
  } catch (e) {
    toast(`duplicate failed: ${e.message}`);
  }
});

$('#cfg-profile-delete').addEventListener('click', async () => {
  if (!profileDraft) return;
  const verb = profileDraft.builtin ? 'Reset' : 'Delete';
  if (!window.confirm(`${verb} profile "${profileDraft.name}"?${profileDraft.builtin ? ' Its file goes back to the built-in defaults.' : ''}`)) return;
  try {
    await api(`/api/research/profiles/${encodeURIComponent(profileDraft.name)}`, { method: 'DELETE' });
    await loadResearchProfiles(profileDraft.builtin ? profileDraft.name : undefined);
    toast(`profile ${verb.toLowerCase()}${verb === 'Reset' ? '' : 'd'}`);
  } catch (e) {
    toast(`${verb.toLowerCase()} failed: ${e.message}`);
  }
});

function renderCfgResult(r) {
  // same order and names as the pipeline section
  const items = [
    ['1 · Convert', r.documentLlm],
    ['2 · Index', r.embedding],
    ['3 · Extract', r.entityLlm],
    ['4 · Summarize', r.summaryLlm],
    ['5 · Judge', r.judgeLlm],
  ];
  $('#cfg-status').innerHTML = items.map(([label, result]) => {
    if (!result) return '';
    if (result.ok === false) return `<div class="cfg-line bad"><b>${label}</b> · ${esc(result.error)}</div>`;
    if (!result.enabled && !label.startsWith('2 ·')) return `<div class="cfg-line warn"><b>${label}</b> · ${esc(result.note)}</div>`;
    if (label.startsWith('2 ·')) return `<div class="cfg-line good"><b>${label}</b> · ${esc(result.model)} · ${result.dimensions}d · ${result.ms}ms</div>`;
    const inherited = result.inherited ? 'inherited · ' : '';
    const sample = result.sample ? ` · replied “${esc(String(result.sample).trim())}”` : '';
    return `<div class="cfg-line good"><b>${label}</b> · ${inherited}${esc(result.model)} · ${result.ms ?? 0}ms${sample}</div>`;
  }).join('');
}

for (const prefix of ROUTE_PREFIXES) {
  $(`#cfg-${prefix}-use`).addEventListener('change', () => routeProviderToggle(prefix));
  $(`#cfg-${prefix}-model`).addEventListener('input', updateConfigSummaries);
}

$('#stage-flow').addEventListener('click', (event) => {
  const node = event.target.closest?.('.stage-node');
  if (!node) return;
  selectedStage = node.dataset.stage;
  renderStageFlow();
});

$('#cfg-embedding-use').addEventListener('change', (event) => {
  embeddingUse = event.target.value;
  $('#cfg-emb-batch').value = activeEmbedding()?.batchSize ?? 32;
  renderProviders();
  updateConfigSummaries();
});

for (const id of ['#cfg-ingest-convert', '#cfg-ingest-concurrency', '#cfg-emb-batch', '#cfg-extraction-concurrency', '#cfg-extraction-batch']) {
  $(id).addEventListener('input', renderStageFlow);
}
$('#cfg-emb-batch').addEventListener('input', (event) => {
  if (embeddingPoolDraft.enabled) {
    embeddingPoolDraft.batchSize = Number(event.target.value);
    $('#cfg-embedding-pool [data-pool="batchSize"]').value = event.target.value;
  }
});

$('#cfg-add-provider').addEventListener('click', (event) => {
  showMenuUnder(event.currentTarget, [
    { label: 'LLM · OpenAI-compatible API', run: addConnection },
    { label: 'Embedding', run: addEmbeddingProvider },
  ]);
});

/** The row a DOM event happened in, and the draft object behind it. */
function rowDraft(target) {
  const row = target.closest?.('.provider-row');
  if (!row) return null;
  const draft = providerDraft(row.dataset.id);
  return draft ? { row, draft } : null;
}

// Typing edits the draft in place; only a provider change, a removal or the
// chevron redraws, so an input never loses focus mid-edit.
$('#cfg-providers').addEventListener('input', (event) => {
  const field = event.target.dataset?.field;
  const found = rowDraft(event.target);
  if (!found) return;
  const limit = event.target.dataset?.limit;
  if (limit) {
    found.draft.limits = { ...defaultEmbeddingLimits, ...found.draft.limits, [limit]: limit === 'resetTimezone' ? event.target.value : Number(event.target.value) };
    return;
  }
  if (!field) return;
  found.draft[field] = event.target.type === 'checkbox' ? event.target.checked : ['dimensions', 'priority'].includes(field) ? Number(event.target.value) : event.target.value;
  if (field === 'label') fillRouteOptions();
  // the row's own summary column used to refresh on a label edit and never on
  // a model one, so a typed model stayed invisible until the next redraw
  if (field === 'label' || field === 'model') {
    const cell = found.row.querySelector('.provider-model');
    cell.textContent = found.draft.model || 'no model set';
    cell.title = found.draft.model || '';
  }
  updateConfigSummaries();
});

$('#cfg-providers').addEventListener('change', (event) => {
  const found = rowDraft(event.target);
  if (!found) return;
  const field = event.target.dataset?.field;
  if (field === 'enabled') { found.draft.enabled = event.target.checked; renderEmbeddingPool(); return; }
  if (field === 'sendDimensions') {
    found.draft.sendDimensions = event.target.checked;
    return;
  }
  if (field !== 'provider') return;
  found.draft.provider = event.target.value;
  // the list came from the provider that is no longer selected
  modelLists.delete(modelListKey(found.row.dataset.kind === 'embedding'
    ? { route: `embedding:${found.row.dataset.id}` }
    : { route: `connection:${found.row.dataset.id}` }));
  // an endpoint that no longer applies would otherwise be saved and tested
  if (found.row.dataset.kind === 'embedding' && found.draft.provider === 'local') {
    found.draft.baseUrl = '';
    found.draft.apiKey = '';
    found.draft.model = '';
  } else if (found.row.dataset.kind === 'llm') {
    const fields = llmProviderFields(found.draft.provider);
    if (!fields.includes('baseUrl')) found.draft.baseUrl = '';
    if (!fields.includes('apiKey')) found.draft.apiKey = '';
  }
  renderProviders();
  fillRouteOptions();
  updateConfigSummaries();
});

$('#cfg-providers').addEventListener('click', async (event) => {
  const row = event.target.closest?.('.provider-row');
  if (!row) return;
  const id = row.dataset.id;
  if (event.target.dataset.embeddingAction) {
    const draft = embeddingDrafts.find((e) => e.id === id);
    const scope = activeWorkspace()?.id;
    if (!draft) return;
    event.target.disabled = true;
    try {
      if (event.target.dataset.embeddingAction === 'models') {
        const result = await api('/api/config/models', { method: 'POST', body: JSON.stringify({ route: `embedding:${id}`, config: gatherConfig(), refresh: true }) });
        if (!result.ok) throw new Error(result.error || result.note || 'Catalog unavailable');
        if (activeWorkspace()?.id !== scope) return;
        draft.catalog = result.models.map((m) => m.id); renderProviders();
        toast('Catalog updated. Save & apply to keep it.');
      } else {
        const result = await api('/api/config/embedding-test', { method: 'POST', body: JSON.stringify({ id, config: gatherConfig() }) });
        toast(`Key test passed · ${result.dimensions} dimensions`); await refreshEmbeddingUsage();
      }
    } catch (e) { toast(e.message); }
    finally { event.target.disabled = false; }
    return;
  }

  if (event.target.classList.contains('provider-toggle')) {
    if (expandedProviders.has(id)) expandedProviders.delete(id); else expandedProviders.add(id);
    renderProviders();
    return;
  }

  if (event.target.classList.contains('provider-default')) {
    llmUse = id;
    renderProviders();
    updateConfigSummaries();
    return;
  }

  if (!event.target.classList.contains('provider-remove') || event.target.disabled) return;
  expandedProviders.delete(id);
  if (row.dataset.kind === 'embedding') {
    embeddingDrafts = embeddingDrafts.filter((e) => e.id !== id);
    // removing the active provider moves Index to the first one left, which
    // re-embeds on save — say so rather than let the corpus change quietly
    if (embeddingUse === id && embeddingDrafts[0]) {
      embeddingUse = embeddingDrafts[0].id;
      $('#cfg-status').innerHTML = `<div class="cfg-line">Index now runs on ${esc(embeddingDrafts[0].label || embeddingUse)} — saving re-embeds the corpus.</div>`;
    }
    renderProviders();
    updateConfigSummaries();
    return;
  }

  connectionDrafts = connectionDrafts.filter((c) => c.id !== id);
  // removing the default moves it to the first row left — say so, because
  // every job that names no provider of its own moves with it
  if (llmUse === id && connectionDrafts[0]) {
    llmUse = connectionDrafts[0].id;
    $('#cfg-status').innerHTML = `<div class="cfg-line">The default provider is now ${esc(connectionDrafts[0].label || llmUse)} — every job that names no provider of its own follows it.</div>`;
  }
  renderProviders();
  // a stage on the removed connection lands on the default, by name
  fillRouteOptions();
  updateConfigSummaries();
  for (const prefix of ROUTE_PREFIXES) routeProviderToggle(prefix);
});

$('#cfg-embedding-pool').addEventListener('input', (event) => {
  const field = event.target.dataset.pool;
  if (!field) return;
  embeddingPoolDraft[field] = field === 'enabled' ? event.target.checked : field === 'model' ? event.target.value : Number(event.target.value);
  if (field === 'model' && canonicalEmbeddingModel(embeddingPoolDraft.model) === 'bge-m3') embeddingPoolDraft.dimensions = 1024;
  if (field === 'batchSize') $('#cfg-emb-batch').value = embeddingPoolDraft.batchSize;
  if (field === 'enabled') $('#cfg-emb-batch').value = embeddingPoolDraft.enabled ? embeddingPoolDraft.batchSize : activeEmbedding()?.batchSize ?? 32;
  fillEmbeddingOptions(); updateConfigSummaries();
  $('#cfg-pool-members').textContent = `${poolEligibleKeys().length} compatible keys · ${embeddingDrafts.length} configured`;
  $('#cfg-embedding-pool [data-pool-action="test"]').disabled = !embeddingPoolDraft.enabled;
});

$('#cfg-embedding-pool').addEventListener('click', async (event) => {
  const action = event.target.dataset.poolAction;
  if (!action) return;
  const scope = activeWorkspace()?.id;
  const draft = gatherConfig();
  const rows = [...embeddingDrafts];
  event.target.disabled = true;
  const status = (text) => { if (activeWorkspace()?.id === scope) $('#cfg-pool-status').textContent = text; };
  try {
    if (action === 'models') {
      let count = 0; const failures = [];
      for (const row of rows.filter((e) => e.provider === 'openai')) {
        if (activeWorkspace()?.id !== scope) return;
        status(`Loading models: ${row.label}`);
        try {
          const result = await api('/api/config/models', { method: 'POST', body: JSON.stringify({ route: `embedding:${row.id}`, config: draft, refresh: true }) });
          if (!result.ok) throw new Error();
          row.catalog = result.models.map((m) => m.id); count++;
        } catch { failures.push(row.label); }
      }
      if (activeWorkspace()?.id !== scope) return;
      renderProviders(); status(`Refreshed ${count} keys. Save & apply to keep the catalog.${failures.length ? ' Unavailable: ' + failures.join(', ') : ''}`);
    } else if (action === 'test') {
      status('Testing the model pool…');
      const result = await api('/api/config/embedding-test', { method: 'POST', body: JSON.stringify({ config: draft }) });
      await refreshEmbeddingUsage(); status(`Pool test passed · ${result.dimensions} dimensions · ${result.ms} ms`);
    } else { await refreshEmbeddingUsage(); }
  } catch (error) { status(error.message); }
  finally { event.target.disabled = false; }
});

function setConfigBusy(busy) {
  $('#btn-cfg-test').disabled = busy;
  $('#btn-cfg-save').disabled = busy;
}

$('#btn-cfg-test').addEventListener('click', async () => {
  setConfigBusy(true);
  $('#cfg-status').innerHTML = '<div class="cfg-line">Testing each configured stage…</div>';
  try {
    renderCfgResult(await api('/api/config/test', { method: 'POST', body: JSON.stringify(gatherConfig()) }));
  } catch (e) {
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">test failed: ${esc(e.message)}</div>`;
  } finally {
    setConfigBusy(false);
  }
});

$('#btn-cfg-save').addEventListener('click', async () => {
  const workspace = activeWorkspace();
  const workspaceId = workspace?.id;
  const selectedWorkspaceLabel = workspaceLabel(workspace);
  setConfigBusy(true);
  $('#cfg-status').innerHTML = '<div class="cfg-line">Saving routes… re-embedding if retrieval changed.</div>';
  try {
    // the agents have to be on disk before the config may name one
    let agentLine = '';
    try {
      await saveAgents();
    } catch (e) {
      agentLine = `<div class="cfg-line bad">agents not saved: ${esc(e.message)}</div>`;
    }
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(gatherConfig()) });
    let profileLine = '';
    try {
      const saved = await saveResearchProfile();
      if (saved) profileLine = `<div class="cfg-line good">research profile <b>${esc(saved.name)}</b> saved · ${esc(saved.path)}</div>`;
    } catch (e) {
      profileLine = `<div class="cfg-line bad">research profile not saved: ${esc(e.message)}</div>`;
    }
    if (activeWorkspace()?.id !== workspaceId) {
      toast(`configuration saved for ${selectedWorkspaceLabel}`);
      return;
    }
    let html = `<div class="cfg-line good"><b>Configuration saved for ${esc(selectedWorkspaceLabel)}</b> · routes applied</div>`;
    if (r.reembedded && r.reindex) html += `<div class="cfg-line">re-embedded: ${r.reindex.indexed} docs · ${r.reindex.chunks} chunks</div>`;
    else if (r.reconverted && r.reindex) html += `<div class="cfg-line">document conversion refreshed: ${r.reindex.indexed} docs · ${r.reindex.errors} errors</div>`;
    html += agentLine + profileLine;
    $('#cfg-status').innerHTML = html;
    toast(`configuration saved for ${selectedWorkspaceLabel}`);
    await loadConfigForm({ preserveStatus: true });
    loadStats();
  } catch (e) {
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">save failed: ${esc(e.message)}</div>`;
  } finally {
    setConfigBusy(false);
  }
});

$('#btn-clear-workspace').addEventListener('click', () => {
  const workspace = activeWorkspace();
  $('#clear-dialog-workspace-name').textContent = workspaceLabel(workspace);
  $('#clear-workspace-error').textContent = '';
  $('#clear-workspace-confirm').value = '';
  $('#btn-confirm-clear-workspace').disabled = true;
  $('#clear-workspace-dialog').showModal();
  setTimeout(() => $('#clear-workspace-confirm').focus(), 0);
});

$('#clear-workspace-confirm').addEventListener('input', () => {
  $('#btn-confirm-clear-workspace').disabled = $('#clear-workspace-confirm').value.trim().toUpperCase() !== 'CLEAR';
});

$('#btn-cancel-clear-workspace').addEventListener('click', () => $('#clear-workspace-dialog').close());
$('#clear-workspace-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const workspace = activeWorkspace();
  if (!workspace || $('#clear-workspace-confirm').value.trim().toUpperCase() !== 'CLEAR') return;
  const button = $('#btn-confirm-clear-workspace');
  button.disabled = true;
  button.textContent = 'Clearing…';
  try {
    await api('/api/workspace', { method: 'DELETE' });
    $('#clear-workspace-dialog').close();
    loadWorkspaceData();
    toast(`${workspaceLabel(workspace)} was completely cleared`);
  } catch (error) {
    $('#clear-workspace-error').textContent = error.message;
  } finally {
    button.textContent = 'Clear workspace';
    button.disabled = $('#clear-workspace-confirm').value.trim().toUpperCase() !== 'CLEAR';
  }
});

/* -------------------------------- boot ---------------------------------- */

bootAuth();
