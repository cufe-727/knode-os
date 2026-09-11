/* knode-os web UI — vanilla JS, no build step */
'use strict';

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const headers = { 'content-type': 'application/json', ...workspaceRequestHeaders(), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
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
  $('#ask-result').innerHTML = '';
  $('#graph-side').innerHTML = '';
  $('#traces-table tbody').innerHTML = '';
  $('#suggestions').innerHTML = '';
  $('#cfg-status').innerHTML = '';
  loadStats();
  loadTree().then(() => openFile('wiki/index.md')).catch(() => {});

  const activeTab = document.querySelector('#tabs button.active')?.dataset.tab;
  if (activeTab === 'traces') loadTraces();
  if (activeTab === 'dream') loadSuggestions();
  if (activeTab === 'settings') loadConfigForm();
  if (activeTab === 'graph') loadGraph('');
}

function startAppData() {
  if (!statsTimer) statsTimer = setInterval(loadStats, 15000);
  loadWorkspaceData();
}

function enterApp() {
  $('#auth-view').hidden = true;
  $('#app-shell').hidden = false;
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

/* ------------------------------- tabs ---------------------------------- */

document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(`#tab-${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'traces') loadTraces();
    if (b.dataset.tab === 'dream') loadSuggestions();
    if (b.dataset.tab === 'settings') loadConfigForm();
    if (b.dataset.tab === 'graph' && !graphState.loaded) loadGraph('');
  });
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

/* ------------------------------- files --------------------------------- */

let currentFile = null;
let editing = false;

function renderTree(node, container) {
  if (!node.children) return;
  for (const child of node.children) {
    const div = document.createElement('div');
    div.className = child.kind === 'dir' ? 'tree-dir' : 'tree-file';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = (child.kind === 'dir' ? '▸ ' : '· ') + child.name;
    label.dataset.path = child.path;
    div.appendChild(label);
    if (child.kind === 'dir') {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      renderTree(child, kids);
      div.appendChild(kids);
      const topLevel = !child.path.includes('/');
      if (!topLevel) div.classList.add('collapsed');
      label.textContent = (div.classList.contains('collapsed') ? '▸ ' : '▾ ') + child.name;
      label.addEventListener('click', () => {
        div.classList.toggle('collapsed');
        label.textContent = (div.classList.contains('collapsed') ? '▸ ' : '▾ ') + child.name;
      });
    } else {
      label.addEventListener('click', () => openFile(child.path, label));
    }
    container.appendChild(div);
  }
}

async function loadTree() {
  const tree = await api('/api/tree');
  const el = $('#filetree');
  el.innerHTML = '';
  renderTree(tree, el);
}

async function openFile(path, labelEl) {
  try {
    const { content } = await api(`/api/file?path=${encodeURIComponent(path)}`);
    currentFile = path;
    editing = false;
    document.querySelectorAll('.tree-label.selected').forEach((x) => x.classList.remove('selected'));
    if (labelEl) labelEl.classList.add('selected');
    $('#file-path').textContent = path;
    $('#file-view').hidden = false;
    $('#file-editor').hidden = true;
    $('#file-view').innerHTML = path.endsWith('.md') ? renderMd(content) : `<pre>${esc(content)}</pre>`;
    $('#file-editor').value = content;
    $('#btn-edit').disabled = false;
    $('#btn-save').disabled = true;
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
    await openFile(resolved.path);
  } catch (e) {
    toast(`link unavailable: ${e.message}`);
  }
});

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

$('#btn-delete').addEventListener('click', async () => {
  if (!currentFile || !confirm(`Delete ${currentFile}?`)) return;
  try {
    await api(`/api/file?path=${encodeURIComponent(currentFile)}`, { method: 'DELETE' });
    toast(`deleted ${currentFile}`);
    currentFile = null;
    $('#file-path').textContent = '';
    $('#file-view').innerHTML = '';
    $('#btn-edit').disabled = $('#btn-save').disabled = $('#btn-delete').disabled = true;
    loadTree();
  } catch (e) {
    toast(`delete failed: ${e.message}`);
  }
});

$('#btn-new-file').addEventListener('click', async () => {
  const path = prompt('New file path (under wiki/ or raw/docs/):', 'wiki/concepts/new-note.md');
  if (!path) return;
  try {
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path, content: `# ${path.split('/').pop().replace(/\.md$/, '')}\n\n` }) });
    await loadTree();
    openFile(path);
  } catch (e) {
    toast(`create failed: ${e.message}`);
  }
});

$('#btn-refresh-tree').addEventListener('click', loadTree);

$('#file-upload').addEventListener('change', async (ev) => {
  const files = ev.target.files;
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  try {
    const res = await fetch('/api/upload', { method: 'POST', headers: workspaceRequestHeaders(), body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`uploaded: ${data.saved.join(', ')} — ingesting…`);
    await api('/api/ingest', { method: 'POST' });
    toast('ingest complete');
    loadTree();
    loadStats();
  } catch (e) {
    toast(`upload failed: ${e.message}`);
  }
  ev.target.value = '';
});

$('#btn-ingest').addEventListener('click', async () => {
  toast('ingesting…', 60000);
  try {
    const s = await api('/api/ingest', { method: 'POST' });
    toast(`ingest: ${s.indexed} indexed, ${s.unchanged} unchanged, ${s.chunks} chunks`);
    loadStats();
  } catch (e) {
    toast(`ingest failed: ${e.message}`);
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
    const results = await api(`/api/search?q=${encodeURIComponent(q)}&mode=${mode}&k=12`);
    el.innerHTML = results.length ? '' : '<p class="hint">no results — upload docs and run ingest first.</p>';
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
        document.querySelector('#tabs button[data-tab="files"]').click();
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

/* -------------------------------- ask ---------------------------------- */

async function doAsk() {
  const q = $('#ask-q').value.trim();
  if (!q) return;
  const mode = $('#ask-mode').value;
  const el = $('#ask-result');
  el.innerHTML = '<p class="hint">thinking…</p>';
  try {
    const res = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question: q, mode }) });
    let html = `<div class="answer markdown">${renderMd(res.answer)}</div>`;
    for (const c of res.citations) html += `<div class="citation">[${c.ref}] ${esc(c.path)}</div>`;
    if (res.facts?.length) {
      html += `<p class="hint">known facts: ${res.facts.slice(0, 5).map((f) => `${esc(f.statement.slice(0, 100))} <span class="mono">[${esc(f.status)}]</span>`).join(' · ')}</p>`;
    }
    if (res.gaps?.length) html += `<p class="gap">gaps: ${res.gaps.map(esc).join(' · ')}</p>`;
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<p class="hint">ask failed: ${esc(e.message)}</p>`;
  }
}
$('#btn-ask').addEventListener('click', doAsk);
$('#ask-q').addEventListener('keydown', (e) => e.key === 'Enter' && doAsk());

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
    side.innerHTML = res.nodes.length === 0 ? '<p class="hint">graph is empty — ingest docs first (entities come from [[wikilinks]] and LLM extraction).</p>' : '';
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
        document.querySelector('#tabs button[data-tab="files"]').click();
        openFile(rb.dataset.report);
      });
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

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

function routeSummary(prefix) {
  const provider = $(`#cfg-${prefix}-provider`).value;
  const model = $(`#cfg-${prefix}-model`).value.trim();
  if (provider === 'inherit') return model ? `Default · ${model}` : 'Default model';
  return model ? `${providerNames[provider]} · ${model}` : providerNames[provider];
}

function updateConfigSummaries() {
  const embLocal = $('#cfg-emb-provider').value === 'local';
  const embModel = $('#cfg-emb-model').value.trim();
  const dims = $('#cfg-emb-dim').value;
  $('#summary-embedding').textContent = embLocal ? `Local hashing · ${dims || 384}d` : (embModel || 'API model not set');
  $('#summary-entity').textContent = routeSummary('entity');
  $('#summary-concept').textContent = routeSummary('concept');
  $('#summary-document').textContent = routeSummary('document');
  const llmProvider = $('#cfg-llm-provider').value;
  const llmModel = $('#cfg-llm-model').value.trim();
  $('#summary-default-llm').textContent = llmModel ? `${providerNames[llmProvider]} · ${llmModel}` : providerNames[llmProvider];
}

function embProviderToggle() {
  const local = $('#cfg-emb-provider').value === 'local';
  ['#cfg-emb-baseurl', '#cfg-emb-key', '#cfg-emb-model', '#cfg-emb-senddim'].forEach((s) => { $(s).disabled = local; });
  $('#cfg-emb-note').textContent = local
    ? 'The local hashing embedder is private, offline and ready immediately. Dimensions can be tuned before the first index.'
    : 'Changing the API model or dimensions re-embeds the corpus after saving. Use env:VAR_NAME to keep the key out of the config file.';
  updateConfigSummaries();
}

function llmProviderToggle() {
  const provider = $('#cfg-llm-provider').value;
  const cli = provider !== 'openai';
  document.querySelectorAll('.cfg-llm-api').forEach((el) => { el.hidden = cli; });
  document.querySelectorAll('.cfg-llm-cli').forEach((el) => { el.hidden = !cli; });
  $('#cfg-llm-model').placeholder = cli
    ? 'Optional · use the CLI default when empty'
    : 'gpt-4.1-mini';
  if (cli) {
    const meta = cliMeta[provider];
    $('#cfg-llm-clipath').placeholder = `Default: ${meta.path}`;
    $('#cfg-llm-note').innerHTML = `<b>${esc(meta.command)}</b> · ${esc(meta.note)}`;
  } else {
    $('#cfg-llm-note').textContent = 'Used by Ask, Wiki summaries and Dream analysis. An empty model disables these general LLM features.';
  }
  updateConfigSummaries();
}

function routeProviderToggle(prefix) {
  const card = document.querySelector(`.route-card[data-route="${prefix}"]`);
  const provider = $(`#cfg-${prefix}-provider`).value;
  const apiFields = card.querySelector('.route-api-fields');
  const cliFields = card.querySelector('.route-cli-fields');
  const note = $(`#cfg-${prefix}-note`);
  apiFields.hidden = provider !== 'openai';
  cliFields.hidden = !cliMeta[provider];
  const model = $(`#cfg-${prefix}-model`);
  if (provider === 'inherit') {
    model.placeholder = 'Optional model override';
    note.innerHTML = '<b>Inherited route.</b> Uses the default Provider, endpoint and credentials above.';
  } else if (provider === 'openai') {
    model.placeholder = 'Model name required';
    note.innerHTML = '<b>API route.</b> Endpoint and key may be left empty to reuse the default API connection.';
  } else {
    const meta = cliMeta[provider];
    model.placeholder = 'Optional · use the CLI default';
    $(`#cfg-${prefix}-clipath`).placeholder = `Default: ${meta.path}`;
    note.innerHTML = `<b>${esc(meta.command)}</b> · ${esc(meta.note)}`;
  }
  updateConfigSummaries();
}

function fillRoute(prefix, route = {}) {
  $(`#cfg-${prefix}-provider`).value = route.provider || 'inherit';
  $(`#cfg-${prefix}-model`).value = route.model || '';
  $(`#cfg-${prefix}-baseurl`).value = route.baseUrl || '';
  $(`#cfg-${prefix}-key`).value = route.apiKey || '';
  $(`#cfg-${prefix}-clipath`).value = route.cliPath || '';
  routeProviderToggle(prefix);
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
    $('#cfg-emb-provider').value = cfg.embedding.provider;
    $('#cfg-emb-baseurl').value = cfg.embedding.baseUrl || '';
    $('#cfg-emb-key').value = cfg.embedding.apiKey || '';
    $('#cfg-emb-model').value = cfg.embedding.model || '';
    $('#cfg-emb-dim').value = cfg.embedding.dimensions || '';
    $('#cfg-emb-senddim').checked = !!cfg.embedding.sendDimensions;
    $('#cfg-llm-provider').value = cfg.llm.provider || 'openai';
    $('#cfg-llm-baseurl').value = cfg.llm.baseUrl || '';
    $('#cfg-llm-key').value = cfg.llm.apiKey || '';
    $('#cfg-llm-model').value = cfg.llm.model || '';
    $('#cfg-llm-clipath').value = cfg.llm.cliPath || '';
    fillRoute('entity', cfg.extraction?.entityLlm);
    fillRoute('concept', cfg.extraction?.conceptLlm);
    fillRoute('document', cfg.extraction?.documentLlm);
    $('#cfg-extraction-budget').value = cfg.extraction?.dailyTokenBudget ?? 2000000;
    $('#cfg-extraction-batch').value = cfg.extraction?.batchSize ?? 8;
    $('#cfg-extraction-concurrency').value = cfg.extraction?.concurrency ?? 1;
    $('#cfg-extraction-claims').checked = cfg.extraction?.claims !== false;
    embProviderToggle();
    llmProviderToggle();
    updateConfigSummaries();
    if (!preserveStatus) $('#cfg-status').innerHTML = '';
  } catch (e) {
    if (activeWorkspace()?.id !== workspaceId) return;
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">load failed: ${esc(e.message)}</div>`;
  }
}

function gatherRoute(prefix) {
  const provider = $(`#cfg-${prefix}-provider`).value;
  return {
    provider,
    model: $(`#cfg-${prefix}-model`).value.trim(),
    baseUrl: provider === 'openai' ? $(`#cfg-${prefix}-baseurl`).value.trim() : '',
    apiKey: provider === 'openai' ? $(`#cfg-${prefix}-key`).value.trim() : '',
    cliPath: cliMeta[provider] ? $(`#cfg-${prefix}-clipath`).value.trim() : '',
    cliTimeoutMs: loadedConfig?.extraction?.[`${prefix}Llm`]?.cliTimeoutMs || 300000,
  };
}

// '***' / 'env:…' are passed through verbatim; the server keeps the real secret.
function gatherConfig() {
  return {
    embedding: {
      provider: $('#cfg-emb-provider').value,
      baseUrl: $('#cfg-emb-baseurl').value.trim(),
      apiKey: $('#cfg-emb-key').value.trim(),
      model: $('#cfg-emb-model').value.trim(),
      dimensions: Number($('#cfg-emb-dim').value) || undefined,
      sendDimensions: $('#cfg-emb-senddim').checked,
    },
    llm: {
      provider: $('#cfg-llm-provider').value,
      baseUrl: $('#cfg-llm-baseurl').value.trim(),
      apiKey: $('#cfg-llm-key').value.trim(),
      model: $('#cfg-llm-model').value.trim(),
      cliPath: $('#cfg-llm-clipath').value.trim(),
    },
    extraction: {
      entityLlm: gatherRoute('entity'),
      conceptLlm: gatherRoute('concept'),
      documentLlm: gatherRoute('document'),
      dailyTokenBudget: Number($('#cfg-extraction-budget').value),
      batchSize: Number($('#cfg-extraction-batch').value),
      concurrency: Number($('#cfg-extraction-concurrency').value),
      claims: $('#cfg-extraction-claims').checked,
    },
  };
}

function renderCfgResult(r) {
  const items = [
    ['Embedding', r.embedding],
    ['Default model', r.llm],
    ['Entity route', r.entityLlm],
    ['Concept route', r.conceptLlm],
    ['Document vision', r.documentLlm],
  ];
  $('#cfg-status').innerHTML = items.map(([label, result]) => {
    if (!result) return '';
    if (result.ok === false) return `<div class="cfg-line bad"><b>${label}</b> · ${esc(result.error)}</div>`;
    if (!result.enabled && label !== 'Embedding') return `<div class="cfg-line warn"><b>${label}</b> · ${esc(result.note)}</div>`;
    if (label === 'Embedding') return `<div class="cfg-line good"><b>${label}</b> · ${esc(result.model)} · ${result.dimensions}d · ${result.ms}ms</div>`;
    const inherited = result.inherited ? 'inherited · ' : '';
    return `<div class="cfg-line good"><b>${label}</b> · ${inherited}${esc(result.model)} · ${result.ms ?? 0}ms</div>`;
  }).join('');
}

$('#cfg-emb-provider').addEventListener('change', embProviderToggle);
$('#cfg-llm-provider').addEventListener('change', llmProviderToggle);
$('#cfg-emb-model').addEventListener('input', updateConfigSummaries);
$('#cfg-emb-dim').addEventListener('input', updateConfigSummaries);
$('#cfg-llm-model').addEventListener('input', updateConfigSummaries);
for (const prefix of ['entity', 'concept', 'document']) {
  $(`#cfg-${prefix}-provider`).addEventListener('change', () => routeProviderToggle(prefix));
  $(`#cfg-${prefix}-model`).addEventListener('input', updateConfigSummaries);
}

function setConfigBusy(busy) {
  $('#btn-cfg-test').disabled = busy;
  $('#btn-cfg-save').disabled = busy;
}

$('#btn-cfg-test').addEventListener('click', async () => {
  setConfigBusy(true);
  $('#cfg-status').innerHTML = '<div class="cfg-line">Testing the configured routes…</div>';
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
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(gatherConfig()) });
    if (activeWorkspace()?.id !== workspaceId) {
      toast(`configuration saved for ${selectedWorkspaceLabel}`);
      return;
    }
    let html = `<div class="cfg-line good"><b>Configuration saved for ${esc(selectedWorkspaceLabel)}</b> · routes applied</div>`;
    if (r.reembedded && r.reindex) html += `<div class="cfg-line">re-embedded: ${r.reindex.indexed} docs · ${r.reindex.chunks} chunks</div>`;
    else if (r.reconverted && r.reindex) html += `<div class="cfg-line">document conversion refreshed: ${r.reindex.indexed} docs · ${r.reindex.errors} errors</div>`;
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
