/* knode-os web UI — vanilla JS, no build step */
'use strict';

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const headers = { 'content-type': 'application/json', ...workspaceRequestHeaders(), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
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
let markedConfigured = false;

function configureMarkdown() {
  if (markedConfigured || !window.marked?.use) return;
  window.marked.use({
    extensions: [{
      name: 'wikilink',
      level: 'inline',
      start(src) {
        const at = src.search(/!?\[\[/);
        return at < 0 ? undefined : at;
      },
      tokenizer(src) {
        const match = /^(!)?\[\[([^\]\n]+)\]\]/.exec(src);
        if (!match) return undefined;
        const fields = match[2].split('|');
        const target = fields.shift().trim();
        if (!target) return undefined;
        const note = target.split('#', 1)[0].replace(/\\/g, '/').replace(/\.(md|markdown)$/i, '');
        const label = fields.join('|').trim() || note.split('/').pop() || target.replace(/^#/, '');
        return { type: 'wikilink', raw: match[0], target, label, embed: Boolean(match[1]) };
      },
      renderer(token) {
        return `<a class="wikilink" href="#" data-wikilink="${esc(token.target)}">${esc(token.label)}</a>`;
      },
    }],
  });
  markedConfigured = true;
}

const renderMd = (s) => {
  configureMarkdown();
  return window.marked?.parse ? window.marked.parse(s) : `<pre>${esc(s)}</pre>`;
};

/* --------------------------- auth & workspaces ------------------------- */

const AUTH_KEY = 'knode-os.auth.v1';
const ACCOUNTS_KEY = 'knode-os.mock-accounts.v1';
const BUILTIN_ACCOUNTS = [
  { username: 'admin', password: 'admin', name: 'Admin' },
  { username: 'test', password: 'test', name: 'Test' },
];
let authState = null;
let pendingUser = null;
let pendingPersistence = 'local';
let statsTimer = null;

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

function readMockAccounts() {
  try {
    const accounts = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    return Array.isArray(accounts) ? accounts.filter((account) => account?.username && typeof account.password === 'string') : [];
  } catch {
    return [];
  }
}

function findMockAccount(username, password) {
  const normalized = normalizeUsername(username);
  return [...BUILTIN_ACCOUNTS, ...readMockAccounts()]
    .find((account) => normalizeUsername(account.username) === normalized && account.password === password) || null;
}

function usernameExists(username) {
  const normalized = normalizeUsername(username);
  return [...BUILTIN_ACCOUNTS, ...readMockAccounts()]
    .some((account) => normalizeUsername(account.username) === normalized);
}

function saveMockAccount(account) {
  const accounts = readMockAccounts();
  accounts.push(account);
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

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

function completeLogin(activeWorkspace, extraWorkspaces = []) {
  const user = pendingUser;
  if (!user) return;
  const personal = personalWorkspace();
  authState = {
    user,
    persistence: pendingPersistence,
    workspaces: [personal, ...extraWorkspaces],
    activeWorkspaceId: activeWorkspace.id,
  };
  saveAuthState();
  $('#login-password').value = '';
  $('#register-password').value = '';
  $('#register-confirm').value = '';
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
  const teams = authState.workspaces.filter((workspace) => workspace.kind === 'team');
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
  $('#account-email').textContent = user.username ? `@${user.username}` : user.email;
  document.body.dataset.workspace = workspace.kind;

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
  if (graphState.anim) cancelAnimationFrame(graphState.anim);
  graphState.nodes = [];
  graphState.edges = [];
  graphState.loaded = false;
  graphState.anim = null;
  graphState.selected = null;
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

function enterApp() {
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

function showLogin() {
  $('#app-shell').hidden = true;
  $('#auth-view').hidden = false;
  showAuthStep('login');
  $('#login-form').reset();
  $('#login-remember').checked = true;
  $('#login-password').type = 'password';
  $('#btn-toggle-password').textContent = 'Show';
  $('#login-error').textContent = '';
  $('#register-error').textContent = '';
  closeWorkspaceMenu();
  setTimeout(() => $('#login-username').focus(), 0);
}

function continueToWorkspaceChoice(user, persistence) {
  pendingUser = user;
  pendingPersistence = persistence;
  $('#personal-choice-avatar').textContent = initials(user.name || user.username);
  $('#onboarding-team-form').reset();
  $('#onboarding-team-error').textContent = '';
  showAuthStep('workspaces');
}

$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const username = normalizeUsername($('#login-username').value);
  const password = $('#login-password').value;
  if (!username) {
    $('#login-error').textContent = 'Enter your username.';
    $('#login-username').focus();
    return;
  }
  const account = findMockAccount(username, password);
  if (!account) {
    $('#login-error').textContent = 'Invalid username or password.';
    $('#login-password').focus();
    return;
  }
  $('#login-error').textContent = '';
  continueToWorkspaceChoice(
    { username: normalizeUsername(account.username), name: account.name || nameFromUsername(account.username) },
    $('#login-remember').checked ? 'local' : 'session',
  );
});

$('#btn-toggle-password').addEventListener('click', () => {
  const password = $('#login-password');
  const reveal = password.type === 'password';
  password.type = reveal ? 'text' : 'password';
  $('#btn-toggle-password').textContent = reveal ? 'Hide' : 'Show';
});

$('#btn-show-register').addEventListener('click', () => {
  $('#register-form').reset();
  $('#register-error').textContent = '';
  showAuthStep('register');
  setTimeout(() => $('#register-username').focus(), 0);
});

$('#btn-register-back').addEventListener('click', () => showAuthStep('login'));

$('#register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const rawUsername = $('#register-username').value.trim();
  const username = normalizeUsername(rawUsername);
  const password = $('#register-password').value;
  const confirmPassword = $('#register-confirm').value;
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(rawUsername)) {
    $('#register-error').textContent = 'Use 3–32 letters, numbers, dots, dashes or underscores.';
    $('#register-username').focus();
    return;
  }
  if (usernameExists(username)) {
    $('#register-error').textContent = 'That username already exists.';
    $('#register-username').focus();
    return;
  }
  if (password.length < 4) {
    $('#register-error').textContent = 'Password must be at least 4 characters.';
    $('#register-password').focus();
    return;
  }
  if (password !== confirmPassword) {
    $('#register-error').textContent = 'Passwords do not match.';
    $('#register-confirm').focus();
    return;
  }
  const account = { username, password, name: nameFromUsername(username) };
  try {
    saveMockAccount(account);
  } catch {
    $('#register-error').textContent = 'This browser could not save the account.';
    return;
  }
  $('#register-error').textContent = '';
  continueToWorkspaceChoice({ username: account.username, name: account.name }, 'local');
});

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

$('#btn-sign-out').addEventListener('click', () => {
  try { localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY); } catch { /* no-op */ }
  authState = null;
  pendingUser = null;
  showLogin();
});

function bootAuth() {
  authState = readAuthState();
  if (authState) enterApp();
  else showLogin();
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
    { id: 'wiki', title: 'Wiki', hint: 'Pages researched by agent CLIs' },
    { id: 'dream', title: 'Dream', hint: 'Review agent improvement ideas' },
  ] },
  { id: 'settings', title: 'Settings', tabs: [
    { id: 'providers', title: 'Providers', hint: 'Endpoints and credentials' },
    { id: 'pipeline', title: 'Pipeline', hint: 'What each stage needs' },
    { id: 'agents', title: 'Agents', hint: 'Who does the work' },
    { id: 'research', title: 'Research', hint: 'How the wiki gets written' },
    { id: 'workspace', title: 'Workspace', hint: 'Clear this workspace' },
  ] },
];

/**
 * Which `<section class="tab">` shows a tab. Settings' five tabs share one
 * host: keying identity and loaders on the leaf instead would re-run
 * `loadConfigForm()` on every sub-tab click and throw away unsaved routes.
 */
const TAB_HOST = { providers: 'settings', pipeline: 'settings', agents: 'settings', research: 'settings', workspace: 'settings' };
const hostOf = (tab) => TAB_HOST[tab] ?? tab;

/** What a host view loads when you arrive at it. */
const TAB_LOAD = {
  search: () => paintSearchScope(),
  traces: () => loadTraces(),
  dream: () => loadSuggestions(),
  wiki: () => loadResearch(),
  ask: () => loadChat(),
  settings: () => loadConfigForm(),
  graph: () => { if (!graphState.loaded) loadGraph(''); },
};

const NAV_KEY = 'knode-os.nav.v1';
const sectionOf = (tab) => NAV.find((s) => s.tabs.some((t) => t.id === tab));
let currentTab = 'files';
const lastTab = Object.fromEntries(NAV.map((s) => [s.id, s.tabs[0].id]));

function restoreNav() {
  try {
    const saved = JSON.parse(localStorage.getItem(NAV_KEY) ?? '{}');
    for (const [section, tab] of Object.entries(saved.lastTab ?? {})) {
      if (sectionOf(tab)?.id === section) lastTab[section] = tab;
    }
    // these ids will move again; an unknown one just means the default
    return sectionOf(saved.tab) ? saved.tab : currentTab;
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

/* ------------------------------- stats --------------------------------- */

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#statsbar').textContent =
      `${s.documents} docs · ${s.chunks} chunks · ${s.entities} entities · ${s.relations} rels · ${s.traces} traces` +
      (s.pending_suggestions ? ` · ☾${s.pending_suggestions}` : '');
  } catch { /* server still starting */ }
}

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
        label.textContent = `${div.classList.contains('collapsed') ? '▸' : '▾'} ${child.name}`;
      };
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
  const movable = isWritable(node.path) && node.path !== 'wiki' && node.path !== 'raw/docs';
  const items = [];
  if (dir && isWritable(node.path)) {
    items.push({ label: 'New file here…', run: () => { pickDir(node.path); newFile(node.path); } });
    items.push({ label: 'New folder here…', run: () => { pickDir(node.path); newFolder(node.path); } });
    items.push('-');
    items.push({ label: 'Upload files here…', run: () => { pickDir(node.path); pickUpload('files', node.path); } });
    items.push({ label: 'Upload folder here…', run: () => { pickDir(node.path); pickUpload('folder', node.path); } });
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
function readOnlyNotice(derived, truncated, bytes) {
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
  const notice = readOnlyNotice(derived, truncated, bytes);
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
    $('#btn-delete').disabled = false;
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
  ]);
});

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
      const res = await fetch('/api/upload', { method: 'POST', headers: workspaceRequestHeaders(), body: form });
      const data = await res.json().catch(() => ({}));
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

const graphState = { nodes: [], edges: [], loaded: false, anim: null, selected: null };

async function loadGraph(q) {
  const depth = $('#graph-depth').value;
  const url = q ? `/api/graph?q=${encodeURIComponent(q)}&depth=${depth}` : '/api/graph';
  try {
    const res = await api(url);
    graphState.loaded = true;
    startGraph(res.nodes, res.edges);
    const side = $('#graph-side');
    side.innerHTML = res.nodes.length === 0 ? '<p class="hint">graph is empty — index docs first (entities come from [[wikilinks]] and LLM extraction).</p>' : '';
    const claimsBySubject = new Map();
    for (const cl of res.claims ?? []) {
      if (!claimsBySubject.has(cl.subject)) claimsBySubject.set(cl.subject, []);
      claimsBySubject.get(cl.subject).push(cl);
    }
    for (const n of res.nodes.slice(0, 30)) {
      const card = document.createElement('div');
      card.className = 'entity-card';
      const facts = (claimsBySubject.get(n.name) ?? []).slice(0, 3)
        .map((cl) => `<div class="hint">◈ ${esc(cl.statement.slice(0, 120))} <span class="mono">[${esc(cl.status)}]</span></div>`)
        .join('');
      card.innerHTML = `<span class="etype">${esc(n.type)}</span> <span class="ename">${esc(n.name)}</span>
        <div class="hint">${esc((n.description || '').slice(0, 140))}</div>
        <div class="hint mono">score ${(n.score ?? 0).toFixed(2)} · ${n.mentionCount} mentions</div>${facts}`;
      side.appendChild(card);
    }
    if (res.chunks?.length) {
      const h = document.createElement('p');
      h.className = 'hint';
      h.textContent = 'grounded in: ' + [...new Set(res.chunks.map((c) => c.path))].slice(0, 5).join(', ');
      side.appendChild(h);
    }
  } catch (e) {
    toast(`graph failed: ${e.message}`);
  }
}

function startGraph(nodes, edges) {
  const canvas = $('#graph-canvas');
  const ctx = canvas.getContext('2d');
  const W = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const H = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const colors = { person: '#5fd297', organization: '#ffc861', product: '#ff9e7a', project: '#ff7a90', component: '#7ab8ff', technology: '#5cc8ff', concept: '#b48cff', event: '#e98cff', location: '#8cffe2', other: '#8b95a5' };

  const ns = nodes.slice(0, 150).map((n, i) => ({
    ...n,
    x: W / 2 + Math.cos((i / nodes.length) * 6.283) * Math.min(W, H) * 0.33,
    y: H / 2 + Math.sin((i / nodes.length) * 6.283) * Math.min(W, H) * 0.33,
    vx: 0, vy: 0,
    r: (6 + Math.min(14, Math.sqrt(n.mentionCount + 1) * 3)) * devicePixelRatio,
  }));
  const byId = new Map(ns.map((n) => [n.id, n]));
  const es = edges.filter((e) => byId.has(e.source) && byId.has(e.target));

  if (graphState.anim) cancelAnimationFrame(graphState.anim);
  graphState.nodes = ns;
  graphState.edges = es;

  let ticks = 0;
  const step = () => {
    // forces
    for (const a of ns) {
      a.vx += (W / 2 - a.x) * 0.0004;
      a.vy += (H / 2 - a.y) * 0.0004;
      for (const b of ns) {
        if (a === b) continue;
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy + 0.01;
        if (d2 < 40000 * devicePixelRatio) {
          const f = 1200 * devicePixelRatio / d2;
          a.vx += dx * f * 0.01;
          a.vy += dy * f * 0.01;
        }
      }
    }
    for (const e of es) {
      const a = byId.get(e.source), b = byId.get(e.target);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const want = 110 * devicePixelRatio;
      const f = ((d - want) / d) * 0.004 * Math.min(2, e.weight);
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of ns) {
      n.vx *= 0.85; n.vy *= 0.85;
      n.x = Math.max(n.r, Math.min(W - n.r, n.x + n.vx));
      n.y = Math.max(n.r, Math.min(H - n.r, n.y + n.vy));
    }
    // draw
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(140,150,170,0.25)';
    for (const e of es) {
      const a = byId.get(e.source), b = byId.get(e.target);
      ctx.lineWidth = Math.min(3, 0.5 + e.weight * 0.4) * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.font = `${11 * devicePixelRatio}px sans-serif`;
    for (const n of ns) {
      ctx.fillStyle = colors[n.type] || colors.other;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#d7dde6';
      ctx.fillText(n.name.slice(0, 22), n.x + n.r + 3, n.y + 4);
    }
    if (++ticks < 240) graphState.anim = requestAnimationFrame(step);
  };
  step();

  canvas.onclick = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * devicePixelRatio;
    const y = (ev.clientY - rect.top) * devicePixelRatio;
    const hit = ns.find((n) => (n.x - x) ** 2 + (n.y - y) ** 2 <= (n.r + 4) ** 2);
    if (hit) {
      $('#graph-q').value = hit.name;
      loadGraph(hit.name);
    }
  };
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
      div.innerHTML = `<span class="skind ${s.kind}">${s.kind}</span> <span class="hint mono">${s.status} · ${new Date(s.created_at).toLocaleDateString()}</span>
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
      const what = `${j.kind} · ${esc(j.target ?? j.query ?? '')}`;
      const when = new Date(j.finishedAt ?? j.startedAt ?? j.createdAt).toLocaleString();
      const actions = [];
      if (j.status === 'queued' || j.status === 'running') actions.push(`<button data-cancel="${j.id}">cancel</button>`);
      if (j.status === 'failed' || j.status === 'cancelled') actions.push(`<button data-retry="${j.id}">retry</button>`);
      actions.push(`<button data-log="${j.id}">log</button>`);
      div.innerHTML = `<span class="jstatus ${j.status}">${j.status}</span>
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

function renderModelPicker(picker, route, input) {
  const state = modelLists.get(route);
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

async function loadModelList(route, picker, input, refresh = false) {
  const state = modelLists.get(route) ?? {};
  if (state.loading) return;
  if (state.result && !refresh) return;
  modelLists.set(route, { ...state, loading: true, error: null });
  renderModelPicker(picker, route, input);
  try {
    const result = await api('/api/config/models', {
      method: 'POST',
      body: JSON.stringify({ route, refresh, config: gatherConfig() }),
    });
    modelLists.set(route, { loading: false, result, error: result.error ?? null });
  } catch (e) {
    modelLists.set(route, { loading: false, result: state.result, error: e.message });
  }
  if (document.body.contains(picker)) renderModelPicker(picker, route, input);
}

function openModelPicker(anchor, input, route) {
  closeModelPicker();
  const picker = document.createElement('div');
  picker.className = 'model-picker';
  document.body.appendChild(picker);
  renderModelPicker(picker, route, input);

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
    if (event.target.closest('.model-refresh')) loadModelList(route, picker, input, true);
  });
  picker.addEventListener('input', (event) => {
    if (event.target.classList.contains('model-filter')) renderModelPicker(picker, route, input);
  });

  setTimeout(() => {
    document.addEventListener('click', onModelPickerOutside, true);
    window.addEventListener('keydown', onModelPickerKey);
    window.addEventListener('resize', closeModelPicker);
  }, 0);

  loadModelList(route, picker, input);
}

/** A model input keeps its free text and gains a chevron that lists what the provider offers. */
function modelChevron(route) {
  return `<button type="button" class="model-chevron" data-route="${esc(route)}" title="List the models this provider offers">⌄</button>`;
}

document.addEventListener('click', (event) => {
  const chevron = event.target.closest?.('.model-chevron');
  if (!chevron) return;
  const input = chevron.parentElement.querySelector('input');
  if (input) openModelPicker(chevron, input, chevron.dataset.route);
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
let defaultLlmDraft = null;
/** Provider ids whose row is open, kept across a redraw. */
const expandedProviders = new Set();

function connectionById(id) {
  return connectionDrafts.find((c) => c.id === id);
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
  'codex-cli': 'Uses your existing Codex login for a read-only one-shot request.',
  'claude-cli': 'Uses your existing Claude Code login for one non-interactive turn.',
  'cursor-cli': 'Uses your existing Cursor Agent login in headless print mode.',
};

const embeddingProviderLabel = (provider) =>
  EMBEDDING_PROVIDER_OPTIONS.find(([v]) => v === provider)?.[1] ?? provider;

const activeEmbedding = () =>
  embeddingDrafts.find((e) => e.id === embeddingUse) ?? embeddingDrafts[0] ?? null;

function embeddingSummaryText() {
  const active = activeEmbedding();
  if (!active) return 'Loading…';
  if (active.provider === 'local') return `${active.label || active.id} · ${active.dimensions || 384}d`;
  return active.model ? `${active.label || active.id} · ${active.model}` : 'API model not set';
}

function defaultLlmSummaryText() {
  if (!defaultLlmDraft) return 'Loading…';
  const name = defaultLlmDraft.label?.trim() || providerNames[defaultLlmDraft.provider] || defaultLlmDraft.provider;
  return defaultLlmDraft.model ? `${name} · ${defaultLlmDraft.model}` : name;
}

function routeSummary(prefix) {
  const use = $(`#cfg-${prefix}-use`).value;
  const model = $(`#cfg-${prefix}-model`).value.trim();
  const connection = connectionById(use);
  const fallback = defaultLlmDraft?.label?.trim() || 'Default model';
  const name = connection ? connection.label || connection.id : fallback;
  const effective = model || connection?.model?.trim() || '';
  return effective ? `${name} · ${effective}` : name;
}

/** Rebuild the Index picker from the configured embedding providers. */
function fillEmbeddingOptions() {
  const select = $('#cfg-embedding-use');
  select.innerHTML = embeddingDrafts
    .map((e) => `<option value="${esc(e.id)}">${esc(e.label || e.id)}</option>`)
    .join('');
  select.value = embeddingDrafts.some((e) => e.id === embeddingUse) ? embeddingUse : (embeddingDrafts[0]?.id ?? '');
  embeddingUse = select.value;
}

/** Rebuild the per-route pickers from the current connection list. */
function fillRouteOptions() {
  for (const prefix of ['entity', 'concept', 'document']) {
    const select = $(`#cfg-${prefix}-use`);
    const previous = select.value;
    select.innerHTML = ['<option value="">Default reasoning model</option>']
      .concat(connectionDrafts.map((c) => `<option value="${esc(c.id)}">${esc(c.label || c.id)}</option>`))
      .join('');
    select.value = connectionDrafts.some((c) => c.id === previous) ? previous : '';
  }
  refreshResearchAgentOptions();
}

/**
 * The five stages a document passes through. The flow draws one node each, and
 * the inspector below shows the panel of whichever is selected — the long
 * explanations used to be stacked five deep and cost two screens.
 */
const PIPELINE_STAGES = [
  { key: 'document', step: 1, title: 'Convert', badge: 'vision', accent: 'accent2' },
  { key: 'index', step: 2, title: 'Index', badge: 'embedding', accent: 'accent' },
  { key: 'entity', step: 3, title: 'Extract', badge: 'volume', accent: 'accent2' },
  { key: 'concept', step: 4, title: 'Synthesize', badge: 'quality', accent: 'accent2' },
  { key: 'answer', step: 5, title: 'Answer', badge: 'interactive', accent: 'accent2' },
];
let selectedStage = 'document';

function stageTarget(key) {
  if (key === 'index') return embeddingSummaryText();
  if (key === 'answer') return defaultLlmSummaryText();
  return routeSummary(key);
}

/** The rate a node reports: only the stages that have one show anything. */
function stageRate(key) {
  const int = (sel, fallback) => Number($(sel)?.value) || fallback;
  if (key === 'document') return `×${int('#cfg-ingest-convert', 2)}`;
  if (key === 'index') return `×${int('#cfg-ingest-concurrency', 4)} · ${int('#cfg-emb-batch', 32)}/req`;
  if (key === 'entity') return `×${int('#cfg-extraction-concurrency', 1)} · ${int('#cfg-extraction-batch', 8)}/pass`;
  return '';
}

function renderStageFlow() {
  $('#stage-flow').innerHTML = PIPELINE_STAGES
    .map((stage, index) => {
      const node = `<button type="button" class="stage-node${stage.key === selectedStage ? ' selected' : ''}" data-stage="${stage.key}">
        <span class="stage-node-head"><i class="stage-step ${stage.accent}">${stage.step}</i>${esc(stage.title)}</span>
        <span class="section-badge ${stage.accent === 'accent2' ? 'accent2' : ''}">${esc(stage.badge)}</span>
        <span class="stage-node-target mono">${esc(stageTarget(stage.key))}</span>
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
  $('#pin-answer').textContent = defaultLlmSummaryText();
  renderStageFlow();
}

function routeProviderToggle(prefix) {
  const note = $(`#cfg-${prefix}-note`);
  const connection = connectionById($(`#cfg-${prefix}-use`).value);
  if (!connection) {
    const provider = defaultLlmDraft?.provider ?? 'openai';
    note.innerHTML = `<b>Inherited route.</b> Runs on the default provider (${esc(providerNames[provider] ?? provider)}).`;
  } else if (connection.provider === 'openai') {
    note.innerHTML = `<b>${esc(connection.label || connection.id)}</b> · ${esc(connection.baseUrl.trim() || 'no endpoint set')}`;
  } else {
    const meta = cliMeta[connection.provider];
    note.innerHTML = `<b>${esc(connection.label || connection.id)}</b> · ${esc(meta ? meta.command : connection.provider)}`;
  }
  updateConfigSummaries();
}

function fillRoute(prefix, route = {}) {
  const use = route.use === 'default' ? '' : route.use || '';
  const select = $(`#cfg-${prefix}-use`);
  select.value = connectionById(use) ? use : '';
  $(`#cfg-${prefix}-model`).value = route.model || '';
  routeProviderToggle(prefix);
}

const PROVIDER_OPTIONS = ['openai', 'codex-cli', 'claude-cli', 'cursor-cli'];

const optionsFor = (pairs, selected) =>
  pairs.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');

/** The shared row chrome; `fields` is the form the chevron opens. */
function providerRow({ kind, accent, id, label, placeholder, providerLabel, summary, isDefault, removable, fields }) {
  const open = expandedProviders.has(id);
  return `<div class="provider-row${open ? ' open' : ''}" data-id="${esc(id)}" data-kind="${kind}">
    <div class="provider-line">
      <button type="button" class="provider-toggle" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'}">${open ? '▾' : '▸'}</button>
      <span class="section-badge ${accent === 'accent2' ? 'accent2' : ''}">${esc(kind === 'embedding' ? 'embed' : 'llm')}</span>
      <input class="provider-name" data-field="label" value="${esc(label || '')}" placeholder="${esc(placeholder)}" />
      <span>${isDefault ? `<span class="section-badge ${accent === 'accent2' ? 'accent2' : ''}">default</span>` : ''}</span>
      <span class="provider-kind">${esc(providerLabel)}</span>
      <span class="provider-model mono">${esc(summary || 'no model set')}</span>
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
      <label>API key<input data-field="apiKey" value="${esc(entry.apiKey || '')}" placeholder="env:OPENAI_API_KEY"${api ? '' : ' disabled'} /></label>
      <label>Dimensions<input data-field="dimensions" type="number" min="1" step="1" value="${esc(entry.dimensions ?? '')}" /></label>
    </div>
    <label class="cfg-check"><input data-field="sendDimensions" type="checkbox"${entry.sendDimensions ? ' checked' : ''}${api ? '' : ' disabled'} /> Send the <span class="mono">dimensions</span> parameter with API requests</label>
    <p class="cfg-callout">${esc(EMB_NOTES[entry.provider] ?? EMB_NOTES.openai)}</p>`;
}

function llmFields(entry, route) {
  const api = entry.provider === 'openai';
  return `<div class="cfg-grid cfg-grid-2">
      <label>Provider<select data-field="provider">${optionsFor(PROVIDER_OPTIONS.map((p) => [p, providerNames[p] ?? p]), entry.provider)}</select></label>
      <label>Model<span class="model-field"><input data-field="model" value="${esc(entry.model || '')}" placeholder="${api ? 'gpt-4.1-mini' : 'Use CLI default'}" />${modelChevron(route)}</span></label>
      ${api ? `<label class="cfg-span-2">Base URL<input data-field="baseUrl" value="${esc(entry.baseUrl || '')}" placeholder="https://api.openai.com/v1" /></label>
      <label>API key<input data-field="apiKey" value="${esc(entry.apiKey || '')}" placeholder="env:OPENAI_API_KEY" /></label>
      <label>Protocol<select data-field="protocol">${optionList(PROTOCOL_OPTIONS, entry.protocol || 'auto')}</select></label>`
    : `<label>Reasoning effort<select data-field="effort">${optionList(EFFORT_OPTIONS, entry.effort || 'default')}</select></label>
      <label class="cfg-span-2">CLI executable<input data-field="cliPath" value="${esc(entry.cliPath || '')}" placeholder="Default: ${esc(cliMeta[entry.provider]?.path ?? '')}" /></label>`}
    </div>
    <p class="cfg-callout">${esc(LLM_NOTES[entry.provider] ?? LLM_NOTES.openai)}</p>`;
}

function renderProviders() {
  const rows = embeddingDrafts.map((e) =>
    providerRow({
      kind: 'embedding',
      accent: 'accent',
      id: e.id,
      label: e.label,
      placeholder: 'Name this provider',
      providerLabel: embeddingProviderLabel(e.provider),
      summary: e.provider === 'local' ? `hashing · ${e.dimensions || 384}d` : (e.model ? `${e.model} · ${e.dimensions || ''}d` : ''),
      isDefault: e.id === embeddingUse,
      // something has to embed, so the last one stays
      removable: embeddingDrafts.length > 1,
      fields: embeddingFields(e),
    }));

  if (defaultLlmDraft) {
    rows.push(providerRow({
      kind: 'llm',
      accent: 'accent2',
      id: 'default',
      label: defaultLlmDraft.label,
      placeholder: providerNames[defaultLlmDraft.provider] ?? 'Name this provider',
      providerLabel: providerNames[defaultLlmDraft.provider] ?? defaultLlmDraft.provider,
      summary: defaultLlmDraft.model,
      isDefault: true,
      removable: false,
      fields: llmFields(defaultLlmDraft, 'llm'),
    }));
  }

  for (const c of connectionDrafts) {
    rows.push(providerRow({
      kind: 'llm',
      accent: 'accent2',
      id: c.id,
      label: c.label,
      placeholder: 'Name this provider',
      providerLabel: providerNames[c.provider] ?? c.provider,
      summary: c.model,
      isDefault: false,
      removable: true,
      fields: llmFields(c, `connection:${c.id}`),
    }));
  }

  $('#cfg-providers').innerHTML = rows.join('');
  fillEmbeddingOptions();
}

/** The draft one row edits, whichever of the three lists it came from. */
function providerDraft(id) {
  if (id === 'default') return defaultLlmDraft;
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

async function loadConfigForm({ preserveStatus = false } = {}) {
  // A workspace switch can happen while this request is in flight. Ignore a
  // response for the old workspace instead of painting its routes into the
  // newly selected workspace's form.
  const workspaceId = activeWorkspace()?.id;
  try {
    const cfg = await api('/api/config');
    if (activeWorkspace()?.id !== workspaceId) return;
    loadedConfig = cfg;
    embeddingDrafts = (cfg.embeddingProviders ?? []).map((e) => ({ ...e }));
    embeddingUse = cfg.embeddingUse || embeddingDrafts[0]?.id || '';
    defaultLlmDraft = { ...cfg.llm };
    connectionDrafts = (cfg.connections ?? []).map((c) => ({ ...c }));
    renderProviders();
    fillRouteOptions();
    fillRoute('entity', cfg.extraction?.entityLlm);
    fillRoute('concept', cfg.extraction?.conceptLlm);
    fillRoute('document', cfg.extraction?.documentLlm);
    $('#cfg-extraction-budget').value = cfg.extraction?.dailyTokenBudget ?? 2000000;
    $('#cfg-extraction-batch').value = cfg.extraction?.batchSize ?? 8;
    $('#cfg-extraction-concurrency').value = cfg.extraction?.concurrency ?? 1;
    $('#cfg-extraction-claims').checked = cfg.extraction?.claims !== false;
    $('#cfg-ingest-concurrency').value = cfg.ingest?.concurrency ?? 4;
    $('#cfg-ingest-convert').value = cfg.ingest?.convertConcurrency ?? 2;
    $('#cfg-emb-batch').value = activeEmbedding()?.batchSize ?? 32;
    await loadAgentsList();
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
      batchSize: e.id === embeddingUse ? Number($('#cfg-emb-batch').value) || e.batchSize : e.batchSize,
    })),
    embeddingUse,
    ingest: {
      concurrency: Number($('#cfg-ingest-concurrency').value) || undefined,
      convertConcurrency: Number($('#cfg-ingest-convert').value) || undefined,
    },
    llm: { ...defaultLlmDraft, label: (defaultLlmDraft?.label || '').trim() },
    connections: connectionDrafts.map((c) => ({ ...c, label: c.label.trim() || c.id })),
    extraction: {
      entityLlm: gatherRoute('entity'),
      conceptLlm: gatherRoute('concept'),
      documentLlm: gatherRoute('document'),
      dailyTokenBudget: Number($('#cfg-extraction-budget').value),
      batchSize: Number($('#cfg-extraction-batch').value),
      concurrency: Number($('#cfg-extraction-concurrency').value),
      claims: $('#cfg-extraction-claims').checked,
    },
    research: gatherResearchConfig(),
    chat: gatherChatConfig(),
  };
}

/* ---------- 03 · agents: who runs a research job or a chat turn ---------- */

/**
 * Named agents. Each is its own file under `playbooks/agents/`, so unlike the
 * rest of this screen they are written the moment one is added or removed —
 * Research cannot point at a name that does not exist yet. Field edits still
 * wait for Save & apply, along with everything else.
 */
let agentDrafts = [];
const expandedAgents = new Set();

const AGENT_EFFORTS = [
  ['default', 'CLI default'], ['low', 'Low'], ['medium', 'Medium'],
  ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'],
];
const AGENT_WEB = [['inherit', 'Follow review.external'], ['on', 'On (within review.external)'], ['off', 'Off']];

function agentById(name) {
  return agentDrafts.find((a) => a.name === name);
}

function executorLabel(executor) {
  if (executor === 'default') return 'Default LLM provider';
  const connection = connectionById(executor);
  if (connection) return connection.label || connection.id;
  return providerNames[executor] ?? executor;
}

function executorOptions(selected) {
  const opts = [`<option value="default"${selected === 'default' ? ' selected' : ''}>Default LLM provider</option>`];
  for (const p of CLI_PROVIDERS) {
    opts.push(`<option value="${p}"${p === selected ? ' selected' : ''}>${esc(providerNames[p])} · from PATH</option>`);
  }
  for (const c of connectionDrafts) {
    opts.push(`<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.label || c.id)}</option>`);
  }
  return opts.join('');
}

function agentFields(agent) {
  return `<div class="cfg-grid cfg-grid-2">
      <label>Runs on<select data-field="executor">${executorOptions(agent.executor)}</select></label>
      <label>Model<span class="model-field"><input data-field="model" value="${esc(agent.model || '')}" placeholder="Its own default" />${modelChevron(agent.executor === 'default' ? 'llm' : `connection:${agent.executor}`)}</span></label>
      <label>Reasoning effort<select data-field="effort">${optionList(AGENT_EFFORTS, agent.effort)}</select></label>
      <label>Web access<select data-field="web">${optionList(AGENT_WEB, agent.tools?.web ?? 'inherit')}</select></label>
      <label>Turns per session<input data-field="maxTurns" type="number" min="0" step="1" value="${esc(agent.maxTurns ?? 0)}" placeholder="0 = the caller's default" /></label>
      <label>Timeout (minutes)<input data-field="timeoutMinutes" type="number" min="0" step="1" value="${esc(Math.round((agent.timeoutMs ?? 0) / 60000))}" placeholder="0 = the caller's default" /></label>
      <label class="cfg-span-2">Description<input data-field="description" value="${esc(agent.description || '')}" placeholder="When to pick this agent" /></label>
    </div>
    <div class="cfg-checks">
      <label class="cfg-check"><input data-field="write" type="checkbox"${agent.tools?.write ? ' checked' : ''} /> Writes pages (knode_write / knode_commit)</label>
      <label class="cfg-check"><input data-field="files" type="checkbox"${agent.tools?.files ? ' checked' : ''} /> Reads files (Read / Grep / Glob)</label>
    </div>
    <label class="agent-prompt">System prompt<textarea data-field="prompt" rows="6" class="mono" spellcheck="false" placeholder="Empty = the research protocol the run workspace already carries">${esc(agent.prompt || '')}</textarea></label>
    <p class="cfg-callout">Stored at <span class="mono">${esc(agent.path || '')}</span>.</p>`;
}

function renderAgents() {
  const host = $('#cfg-agents');
  if (!agentDrafts.length) {
    host.innerHTML = '<p class="cfg-callout">No agents yet — add one from a template: a general deep agent for Chat, or a deep-research agent that writes wiki pages.</p>';
    return;
  }
  host.innerHTML = agentDrafts
    .map((agent) => {
      const deep = agent.kind === 'deep-research';
      const open = expandedAgents.has(agent.name);
      const uses = [
        $('#cfg-research-agent')?.value === agent.name ? '<span class="section-badge accent2">research</span>' : '',
        $('#cfg-chat-agent')?.value === agent.name ? '<span class="section-badge">chat</span>' : '',
      ].join('');
      return `<div class="provider-row${open ? ' open' : ''}" data-agent="${esc(agent.name)}">
        <div class="provider-line">
          <button type="button" class="provider-toggle agent-toggle" aria-expanded="${open}">${open ? '▾' : '▸'}</button>
          <span class="section-badge${deep ? ' accent2' : ''}">${deep ? 'deep research' : 'general'}</span>
          <input class="provider-name" data-field="title" value="${esc(agent.title || '')}" placeholder="Name this agent" />
          <span>${uses}</span>
          <span class="provider-kind">${esc(executorLabel(agent.executor))}</span>
          <span class="provider-model mono">${esc(agent.model || 'its own default')}</span>
          <span class="provider-id mono">${agent.runnable ? '' : '⚠ '}${esc(agent.name)}</span>
          <button type="button" class="ghost agent-remove" title="${agent.builtin ? 'Reset this template to its built-in' : 'Remove this agent'}">${agent.builtin ? '⟲' : '✕'}</button>
        </div>
        ${open ? `<div class="provider-detail">${agentFields(agent)}</div>` : ''}
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
  refreshResearchAgentOptions();
}

/** A new agent is written straight away: Research cannot name what has no file. */
async function addAgent(kind) {
  const base = kind === 'deep-research' ? 'research' : 'agent';
  let suffix = agentDrafts.length + 1;
  while (agentDrafts.some((a) => a.name === `${base}-${suffix}`)) suffix += 1;
  const name = `${base}-${suffix}`;
  try {
    await api(`/api/agents/${name}`, {
      method: 'PUT',
      body: JSON.stringify({
        agent: {
          kind,
          title: kind === 'deep-research' ? 'New research agent' : 'New agent',
          executor: 'default',
          tools: { write: kind === 'deep-research', files: true, web: 'inherit' },
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
    await loadAgentsList();
    // the service moves research/chat off a deleted agent, so read them back
    if (!reset) {
      const cfg = await api('/api/config');
      $('#cfg-research-agent').value = cfg.research?.agent ?? '';
      $('#cfg-chat-agent').value = cfg.chat?.agent ?? '';
      refreshResearchAgentOptions();
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
          description: agent.description ?? '',
          kind: agent.kind,
          executor: agent.executor,
          model: agent.model ?? '',
          effort: agent.effort ?? 'default',
          tools: agent.tools ?? { write: false, files: true, web: 'inherit' },
          maxTurns: Number(agent.maxTurns) || 0,
          timeoutMs: Number(agent.timeoutMs) || 0,
          prompt: agent.prompt ?? '',
        },
      }),
    });
  }
}

for (const id of ['#cfg-research-agent', '#cfg-chat-agent']) {
  $(id).addEventListener('change', renderAgents);
}

$('#cfg-add-agent').addEventListener('click', (event) => {
  showMenuUnder(event.currentTarget, [
    { label: 'General agent', run: () => addAgent('general') },
    { label: 'Deep research agent', run: () => addAgent('deep-research') },
  ]);
});

$('#cfg-agents').addEventListener('input', (event) => {
  const row = event.target.closest?.('.provider-row');
  const field = event.target.dataset?.field;
  const agent = row && agentById(row.dataset.agent);
  if (!agent || !field) return;
  if (field === 'timeoutMinutes') agent.timeoutMs = (Number(event.target.value) || 0) * 60000;
  else if (field === 'maxTurns') agent.maxTurns = Number(event.target.value) || 0;
  else agent[field] = event.target.value;
  if (field === 'title') refreshResearchAgentOptions();
});

$('#cfg-agents').addEventListener('change', (event) => {
  const row = event.target.closest?.('.provider-row');
  const field = event.target.dataset?.field;
  const agent = row && agentById(row.dataset.agent);
  if (!agent || !field) return;
  if (field === 'write' || field === 'files') {
    agent.tools = { ...agent.tools, [field]: event.target.checked };
    return;
  }
  if (field === 'web') {
    agent.tools = { ...agent.tools, web: event.target.value };
    return;
  }
  if (field !== 'executor' && field !== 'effort') return;
  agent[field] = event.target.value;
  if (field === 'executor') renderAgents();
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

/* ---------- Settings · 04 research: pipeline, initialization, chat, profile ---------- */
const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'cursor-cli'];
const PROTOCOL_OPTIONS = [
  ['auto', 'Auto (Responses, else Chat)'], ['responses', 'Responses only'], ['chat', 'Chat Completions only'],
];
const EFFORT_OPTIONS = [
  ['default', 'CLI default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max (claude & codex; cursor → high)'],
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
function agentOptions(selected, fallbackLabel, kind = '') {
  const opts = fallbackLabel
    ? [`<option value="">${esc(fallbackLabel)}</option>`]
    : [`<option value=""${selected ? ' disabled' : ' selected'}>Not configured — pick an agent</option>`];
  // the named agents from section 03 first, the kind this picker is for on top
  const named = [...agentDrafts].sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind));
  for (const a of named) {
    opts.push(`<option value="${esc(a.name)}"${a.name === selected ? ' selected' : ''}>${esc(a.title || a.name)}</option>`);
  }
  // a config written before named agents points straight at an executor
  for (const p of CLI_PROVIDERS) opts.push(`<option value="${p}"${p === selected ? ' selected' : ''}>${esc(providerNames[p])} · from PATH</option>`);
  // 'default' is the section-01 connection named explicitly; a CLI there runs as
  // a CLI, an OpenAI-compatible endpoint runs the built-in agent
  const provider = defaultLlmDraft?.provider;
  opts.push(`<option value="default"${selected === 'default' ? ' selected' : ''}>Default LLM provider${provider ? ` · ${esc(providerNames[provider] || provider)}` : ''}</option>`);
  for (const c of connectionDrafts) {
    const how = CLI_PROVIDERS.includes(c.provider) ? providerNames[c.provider] : 'built-in agent';
    opts.push(`<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.label || c.id)} · ${esc(how)}</option>`);
  }
  return opts.join('');
}

/** Only the CLIs ship a web tool; the built-in agent searches the base only. */
function agentWebCapable(spec) {
  if (CLI_PROVIDERS.includes(spec)) return true;
  const provider = spec === 'default' ? defaultLlmDraft?.provider : connectionById(spec)?.provider;
  return CLI_PROVIDERS.includes(provider);
}

function refreshResearchAgentOptions() {
  const select = $('#cfg-research-agent');
  if (!select) return;
  const current = select.value;
  select.innerHTML = agentOptions(current, null, 'deep-research');
  select.value = current;
  if (select.value !== current) select.value = '';
  const chatSelect = $('#cfg-chat-agent');
  if (chatSelect) {
    const chatCurrent = chatSelect.value;
    chatSelect.innerHTML = agentOptions(chatCurrent, 'The research agent above', 'general');
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
  $('#cfg-research-agent').innerHTML = agentOptions(research.agent || '', null, 'deep-research');
  $('#cfg-research-agent').value = research.agent || '';
  $('#cfg-research-model').value = research.model || '';
  $('#cfg-research-pipeline').value = research.pipeline || 'team';
  $('#cfg-research-concurrency').value = research.concurrency ?? 1;
  $('#cfg-research-maxturns').value = research.maxTurns ?? 40;
  $('#cfg-research-timeout').value = Math.max(1, Math.round((research.timeoutMs ?? 1200000) / 60000));
  $('#cfg-research-researchers').value = research.researchers ?? 3;
  $('#cfg-research-rounds').value = research.reviewRounds ?? 1;
  $('#cfg-research-auto').checked = !!research.auto?.enabled;
  $('#cfg-research-daily').value = research.auto?.dailyJobs ?? 3;
  $('#cfg-init-extraction').value = research.init?.extraction || 'drain';
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
        <label>Model<input data-field="model" value="${esc(r.model || '')}" placeholder="Agent's model" /></label>
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
      extraction: $('#cfg-init-extraction').value,
      extractionMaxMs: (Number($('#cfg-init-maxms').value) || 15) * 60000,
    },
  };
}

function fillChatForm(chat) {
  $('#cfg-chat-agent').innerHTML = agentOptions(chat.agent || '', 'The research agent above', 'general');
  $('#cfg-chat-agent').value = chat.agent || '';
  $('#cfg-chat-model').value = chat.model || '';
  $('#cfg-chat-effort').innerHTML = optionList(EFFORT_OPTIONS, chat.effort || 'default');
  $('#cfg-chat-web').value = chat.web || 'inherit';
  $('#cfg-chat-maxturns').value = chat.maxTurns ?? 30;
  $('#cfg-chat-timeout').value = Math.max(1, Math.round((chat.timeoutMs ?? 600000) / 60000));
  $('#cfg-chat-history').value = chat.historyTurns ?? 12;
  $('#cfg-chat-keep').value = chat.keep ?? 50;
}

function gatherChatConfig() {
  return {
    agent: $('#cfg-chat-agent').value,
    model: $('#cfg-chat-model').value.trim(),
    effort: $('#cfg-chat-effort').value,
    web: $('#cfg-chat-web').value,
    maxTurns: Number($('#cfg-chat-maxturns').value) || 30,
    timeoutMs: (Number($('#cfg-chat-timeout').value) || 10) * 60000,
    historyTurns: Math.max(0, Number($('#cfg-chat-history').value) || 0),
    keep: Number($('#cfg-chat-keep').value) || 50,
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
      reasoning: { effort: $('#cfg-profile-effort').value },
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
    ['4 · Synthesize', r.conceptLlm],
    ['5 · Answer', r.llm],
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

for (const prefix of ['entity', 'concept', 'document']) {
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

$('#cfg-add-provider').addEventListener('click', (event) => {
  showMenuUnder(event.currentTarget, [
    { label: 'LLM provider', run: addConnection },
    { label: 'Embedding provider', run: addEmbeddingProvider },
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
  if (!field || !found) return;
  found.draft[field] = field === 'dimensions' ? Number(event.target.value) || undefined : event.target.value;
  if (field === 'label') {
    fillRouteOptions();
    found.row.querySelector('.provider-model').textContent = found.draft.model || 'no model set';
  }
  updateConfigSummaries();
});

$('#cfg-providers').addEventListener('change', (event) => {
  const found = rowDraft(event.target);
  if (!found) return;
  const field = event.target.dataset?.field;
  if (field === 'sendDimensions') {
    found.draft.sendDimensions = event.target.checked;
    return;
  }
  if (field !== 'provider') return;
  found.draft.provider = event.target.value;
  // the list came from the provider that is no longer selected
  modelLists.delete(found.row.dataset.kind === 'embedding' ? `embedding:${found.row.dataset.id}` : (found.row.dataset.id === 'default' ? 'llm' : `connection:${found.row.dataset.id}`));
  // an endpoint that no longer applies would otherwise be saved and tested
  if (found.row.dataset.kind === 'embedding' && found.draft.provider === 'local') {
    found.draft.baseUrl = '';
    found.draft.apiKey = '';
    found.draft.model = '';
  } else if (found.row.dataset.kind === 'llm' && found.draft.provider !== 'openai') {
    found.draft.baseUrl = '';
    found.draft.apiKey = '';
  }
  renderProviders();
  fillRouteOptions();
  updateConfigSummaries();
});

$('#cfg-providers').addEventListener('click', (event) => {
  const row = event.target.closest?.('.provider-row');
  if (!row) return;
  const id = row.dataset.id;

  if (event.target.classList.contains('provider-toggle')) {
    if (expandedProviders.has(id)) expandedProviders.delete(id); else expandedProviders.add(id);
    renderProviders();
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
  renderProviders();
  fillRouteOptions();
  // a route pointing at the removed connection falls back to the default
  for (const prefix of ['entity', 'concept', 'document']) {
    if ($(`#cfg-${prefix}-use`).value === id) $(`#cfg-${prefix}-use`).value = '';
    routeProviderToggle(prefix);
  }
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
