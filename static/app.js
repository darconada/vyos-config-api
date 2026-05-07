// static/app.js
// VyOS Config Viewer JavaScript - API REST Version

console.log('VyOS Config Viewer JS loaded (API REST version)');

// =========================================
// AUTH: redirect to /login on 401 from any fetch
// =========================================
(function installAuthInterceptor() {
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await origFetch(...args);
    if (res.status === 401) {
      window.location.href = '/login';
      // Swallow the response in practice; caller will see the redirect happen.
    }
    return res;
  };
})();

// Cache for server defaults (port, api_key) loaded lazily.
let SERVER_DEFAULTS = null;
async function loadServerDefaults() {
  if (SERVER_DEFAULTS) return SERVER_DEFAULTS;
  try {
    const res = await fetch('/api/defaults');
    if (res.ok) SERVER_DEFAULTS = await res.json();
  } catch (e) {
    console.warn('could not load /api/defaults', e);
  }
  return SERVER_DEFAULTS || {};
}

// =========================================
// DOM REFERENCES
// =========================================
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const menu = document.getElementById('menu');
const content = document.getElementById('content');
const breadcrumb = document.getElementById('breadcrumb');
const connectionStatus = document.getElementById('connectionStatus');
const toastContainer = document.getElementById('toastContainer');

// =========================================
// STATE MANAGEMENT
// =========================================
let CONFIG = null;
let currentSection = null;
let currentRulesetName = null;
let currentRulesetData = {};
let groupCache = {};
let showResolved = false;
let filters = {};
let ipFilters = { source: null, destination: null };
let natData = null;
const natTextFilters = { 'Destination NAT': {}, 'Source NAT': {} };
const natIpFilters = { 'Destination NAT': {}, 'Source NAT': {} };
const sections = ['Dashboard', 'Firewall', 'NAT', 'Groups', 'Interfaces', 'Routes', 'BGP', 'Activity'];

// Groups state
let groupsData = null;
let groupModalEntries = [];      // Current entries in the modal (array of strings)
let groupOriginalEntries = [];   // Original entries when editing (for diff)
let groupOriginalDescription = null; // Original description for diff

// Activity Log - stores all operations performed during the session
let activityLog = [];
// Each entry: { id, timestamp, type, action, target, status, message, commands }

// Estado de conexión activa (para operaciones de escritura)
let isConnected = false;
let hasUnsavedChanges = false;
let verboseMode = false;
let pendingCommandExecution = null; // Stores pending command data for verbose mode

// Cluster HA state (null if not in cluster)
// Shape: { detected, primary_name, peer_name, peer_connected, peer_host?, peer_port? }
let clusterInfo = null;
let clusterSyncState = 'unknown'; // 'unknown' | 'checking' | 'sync' | 'diverged' | 'detected' (peer not connected)
let lastClusterDiffs = [];
// When true (default), writes go to both nodes with pre-flight sync-check.
// When false, writes target only primary (no pre-flight) — use during single-node interventions.
let dualApplyEnabled = true;

// Staged mode state
let stagedMode = false;
let pendingOperations = []; // Array of { type, action, data, display }
// Track which rules have pending changes for visual marking
// Keys: "firewall:RULESET:RULEID" or "nat:TYPE:RULEID"
let pendingRuleMarkers = new Set();
// Store ORIGINAL SERVER STATE for each rule with pending changes
// This tracks the rule state BEFORE any staged changes
// Key: marker string, Value: original rule object (or null if new rule)
let originalServerStates = new Map();

// Store original rule data when editing (for differential updates)
let originalFirewallRule = null;
let originalNatRule = null;

// =========================================
// THEME MANAGEMENT
// =========================================
const savedTheme = localStorage.getItem('vyos-theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeButtons(savedTheme);

document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const theme = btn.dataset.theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vyos-theme', theme);
    updateThemeButtons(theme);
  });
});

function updateThemeButtons(activeTheme) {
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === activeTheme);
  });
}

// =========================================
// TOAST NOTIFICATIONS
// =========================================
function showToast(type, title, message, duration = 4000) {
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type]}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      ${message ? `<div class="toast-message">${message}</div>` : ''}
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// =========================================
// LOADING STATES
// =========================================
function showLoading(text = 'Loading...') {
  content.innerHTML = `
    <div class="loading-overlay">
      <div class="loading-spinner lg"></div>
      <div class="loading-text">${text}</div>
    </div>
  `;
}

function showSkeletonTable(rows = 5, cols = 6) {
  let skeletonRows = '';
  for (let i = 0; i < rows; i++) {
    skeletonRows += '<div class="skeleton-row">';
    for (let j = 0; j < cols; j++) {
      skeletonRows += `<div class="skeleton skeleton-cell" style="flex:${j === cols - 1 ? 2 : 1}"></div>`;
    }
    skeletonRows += '</div>';
  }
  return `<div class="card"><div class="card-body">${skeletonRows}</div></div>`;
}

// =========================================
// BREADCRUMB MANAGEMENT
// =========================================
function updateBreadcrumb(items) {
  if (!items || items.length === 0) {
    breadcrumb.innerHTML = '<span class="breadcrumb-item">Home</span>';
    return;
  }

  let html = '<span class="breadcrumb-link" onclick="goHome()">Home</span>';
  items.forEach((item, i) => {
    const isLast = i === items.length - 1;
    if (isLast) {
      html += `<span class="breadcrumb-item active">${item.label}</span>`;
    } else {
      html += `<span class="breadcrumb-link" onclick="${item.action}">${item.label}</span>`;
    }
  });
  breadcrumb.innerHTML = html;
}

function goHome() {
  if (CONFIG) {
    currentSection = null;
    currentRulesetName = null;
    renderDashboard();
    updateBreadcrumb([]);
  }
}

// =========================================
// CONNECTION STATUS
// =========================================
function updateConnectionStatus(connected, hostname = null) {
  isConnected = connected;
  if (connected) {
    connectionStatus.classList.add('connected');
    connectionStatus.querySelector('.status-text').textContent = hostname || 'Config loaded';
  } else {
    connectionStatus.classList.remove('connected');
    connectionStatus.querySelector('.status-text').textContent = 'No config loaded';
    // Reset cluster state on disconnect
    clusterInfo = null;
    lastClusterDiffs = [];
    dualApplyEnabled = true;
    const dualCheck = document.getElementById('dualApplyCheck');
    if (dualCheck) dualCheck.checked = true;
    document.getElementById('dualApplyToggle')?.classList.remove('sync-off');
    updateClusterBadge(null);
  }
}

// =========================================
// FILE UPLOAD
// =========================================
uploadBtn.onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files[0];
  if (!file) return;

  showLoading('Uploading configuration...');

  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/upload', { method: 'POST', body: fd });
    const j = await res.json();

    if (j.status !== 'ok') {
      showToast('error', 'Upload Failed', j.message);
      content.innerHTML = '<div class="empty-state"><p class="text-muted">Failed to load configuration</p></div>';
      return;
    }

    CONFIG = j.data;
    // File uploads are static — no live peer, reset any cluster state
    clusterInfo = null;
    lastClusterDiffs = [];
    if (typeof updateClusterBadge === 'function') updateClusterBadge(null);
    updateConnectionStatus(true, file.name);
    drawMenu();
    renderDashboard();
    showToast('success', 'Configuration Loaded', `Successfully loaded ${file.name}`);
  } catch (e) {
    console.error(e);
    showToast('error', 'Upload Error', e.message);
  }

  fileInput.value = '';
};

// =========================================
// MENU
// =========================================
function drawMenu() {
  const icons = {
    Dashboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    Firewall: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    NAT: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
    Groups: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    Interfaces: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
    Routes: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    BGP: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/></svg>',
    Activity: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>'
  };

  menu.innerHTML = sections.map(s => `
    <button class="nav-btn ${currentSection === s ? 'active' : ''}" onclick="loadSection('${s}')">
      ${icons[s] || ''}
      <span>${s}</span>
    </button>
  `).join('');
}

// =========================================
// SECTION LOADING
// =========================================
async function loadSection(sec) {
  currentSection = sec;
  drawMenu();

  if (sec === 'Dashboard') {
    updateBreadcrumb([]);
    return renderDashboard();
  }
  if (sec === 'Firewall') {
    updateBreadcrumb([{ label: 'Firewall', action: "loadSection('Firewall')" }]);
    return loadFirewall();
  }
  if (sec === 'NAT') {
    updateBreadcrumb([{ label: 'NAT', action: "loadSection('NAT')" }]);
    return loadNat();
  }
  if (sec === 'Activity') {
    updateBreadcrumb([{ label: 'Activity Log', action: "loadSection('Activity')" }]);
    return renderActivityLog();
  }
  if (sec === 'Groups') {
    updateBreadcrumb([{ label: 'Firewall Groups', action: "loadSection('Groups')" }]);
    return loadGroups();
  }
  if (sec === 'Interfaces') {
    updateBreadcrumb([{ label: 'Interfaces', action: "loadSection('Interfaces')" }]);
    return loadInterfaces();
  }
  if (sec === 'Routes') {
    updateBreadcrumb([{ label: 'Static Routes', action: "loadSection('Routes')" }]);
    return loadRoutes();
  }
  if (sec === 'BGP') {
    updateBreadcrumb([{ label: 'BGP Configuration', action: "loadSection('BGP')" }]);
    return loadBGP();
  }

  showLoading(`Loading ${sec}...`);
  const res = await fetch(`/api/${sec}`);
  const data = await res.json();
  content.innerHTML = `<div class="card"><div class="card-body"><pre style="overflow-x:auto">${JSON.stringify(data, null, 2)}</pre></div></div>`;
}

// =========================================
// NAT
// =========================================
async function loadNat() {
  content.innerHTML = showSkeletonTable(8, 5);

  try {
    const res = await fetch('/api/NAT');
    natData = await res.json();
    renderNat(natData);
  } catch (e) {
    showToast('error', 'Error', 'Failed to load NAT rules');
    content.innerHTML = '<div class="empty-state"><p class="text-muted">Failed to load NAT configuration</p></div>';
  }
}

function renderNat(nat) {
  nat = nat || {};
  content.innerHTML = '';

  // Add "New NAT Rule" buttons if connected
  if (isConnected) {
    content.innerHTML = `
      <div class="table-actions" style="margin-bottom: 1rem;">
        <button class="btn btn-success btn-sm" onclick="openNatRuleModal('create', 'destination')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New DNAT Rule
        </button>
        <button class="btn btn-success btn-sm" onclick="openNatRuleModal('create', 'source')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New SNAT Rule
        </button>
      </div>
    `;
  }

  renderNatTable('Destination NAT', 'destination', nat.destination?.rule || {}, [
    { key: 'inbound-interface', label: 'In Interface' },
    { key: 'destination.address', label: 'Destination' },
    { key: 'translation.address', label: 'Translation' },
    { key: 'exclude', label: 'Exclude' },
    { key: 'description', label: 'Description' }
  ]);

  renderNatTable('Source NAT', 'source', nat.source?.rule || {}, [
    { key: 'outbound-interface', label: 'Out Interface' },
    { key: 'source.address', label: 'Source' },
    { key: 'translation.address', label: 'Translation' },
    { key: 'exclude', label: 'Exclude' },
    { key: 'description', label: 'Description' }
  ]);
}

function get(obj, path) {
  const val = path.split('.').reduce((o, p) => (o != null ? o[p] : undefined), obj);
  if (val === undefined) return '-';
  if (path === 'exclude' && typeof val === 'object') return 'true';
  if (typeof val === 'object') {
    if ('address' in val) return val.address;
    if ('name' in val) return val.name;
    return JSON.stringify(val);
  }
  return String(val);
}

function renderNatTable(title, natType, rules, cols) {
  const txtF = natTextFilters[title];
  const ipF = natIpFilters[title];
  const hasActiveFilters = Object.keys(txtF).length > 0 || Object.keys(ipF).length > 0;
  const ruleCount = Object.keys(rules).length;

  let html = `
    <div class="card" style="margin-bottom: 1.5rem;">
      <div class="card-header">
        <div class="card-title">
          ${title}
          <span class="badge">${ruleCount} rules</span>
        </div>
        <div class="flex gap-2">
          ${hasActiveFilters ? `<button class="btn btn-ghost btn-sm" onclick="clearNatFilters('${title}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            Clear filters
          </button>` : ''}
        </div>
      </div>
      <div class="table-container">
        <table>
          <thead><tr>
            <th style="width:70px">Rule</th>
            ${cols.map(c => {
              const isIp = c.key.endsWith('.address');
              const currentVal = isIp
                ? (ipF[c.key] ? formatIPFilter(ipF[c.key]) : '')
                : (txtF[c.key] || '');
              const hasValue = currentVal !== '';
              return `<th>
                <div class="flex flex-col gap-1">
                  <span>${c.label}</span>
                  <input
                    type="text"
                    class="filter-input ${hasValue ? 'has-value' : ''}"
                    placeholder="Filter..."
                    value="${escapeHtml(currentVal)}"
                    onchange="handleNatFilterChange('${title}', '${c.key}', this.value, ${isIp})"
                    onkeydown="if(event.key==='Enter') this.blur()"
                  />
                </div>
              </th>`;
            }).join('')}
            ${isConnected ? `<th class="actions-col">Actions</th>` : ''}
          </tr></thead>
          <tbody>`;

  let visibleCount = 0;
  Object.entries(rules)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
    .forEach(([id, r]) => {
      for (let key in ipF) {
        const root = key.split('.')[0];
        if (!matchIP(r[root], ipF[key])) return;
      }
      for (let key in txtF) {
        const cell = get(r, key);
        if (!cell.toLowerCase().includes(txtF[key].toLowerCase())) return;
      }
      visibleCount++;

      // Check if this NAT rule has pending changes
      const pendingStatus = getPendingStatus('nat', natType, id);
      const pendingClass = pendingStatus === 'delete' ? 'pending-delete' : (pendingStatus ? 'pending-change' : '');
      const pendingBadge = pendingStatus ? `<span class="pending-badge">${pendingStatus === 'delete' ? 'DEL' : 'MOD'}</span>` : '';

      html += `<tr class="${pendingClass}">
        <td><span class="badge">${id}</span>${pendingBadge}</td>
        ${cols.map(c => `<td><div class="cell-wrap wide">${escapeHtml(get(r, c.key))}</div></td>`).join('')}
        ${isConnected ? `<td class="actions-col">
          <button class="btn-icon" onclick="openNatRuleModal('edit', '${natType}', '${id}')" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="btn-icon btn-danger" onclick="deleteNatRule('${natType}', '${id}')" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </td>` : ''}
      </tr>`;
    });

  if (visibleCount === 0) {
    html += `<tr><td colspan="${cols.length + 1 + (isConnected ? 1 : 0)}" class="text-center text-muted" style="padding: 2rem;">No rules match the current filters</td></tr>`;
  }

  html += `</tbody></table></div></div>`;
  content.insertAdjacentHTML('beforeend', html);
}

function handleNatFilterChange(title, key, val, isIp) {
  val = val.trim();
  if (isIp) {
    if (val) natIpFilters[title][key] = parseIPInput(val);
    else delete natIpFilters[title][key];
  } else {
    if (val) natTextFilters[title][key] = val;
    else delete natTextFilters[title][key];
  }
  content.innerHTML = '';
  renderNat(natData);
}

function clearNatFilters(title) {
  natTextFilters[title] = {};
  natIpFilters[title] = {};
  content.innerHTML = '';
  renderNat(natData);
}

// =========================================
// ACTIVITY LOG
// =========================================
let activityLogIdCounter = 0;

// Add entry to activity log
function logActivity(type, action, target, status, message, commands = []) {
  const entry = {
    id: ++activityLogIdCounter,
    timestamp: new Date(),
    type,      // 'firewall', 'nat', 'config', 'connection'
    action,    // 'create', 'update', 'delete', 'save', 'connect', 'staged', 'revert'
    target,    // e.g., 'Rule 20 in LAN-IN', 'Destination NAT rule 100'
    status,    // 'success', 'error', 'staged', 'reverted'
    message,   // Human-readable message
    commands   // Array of VyOS commands (for expandable view)
  };
  activityLog.unshift(entry); // Add to beginning (newest first)

  // Keep max 500 entries
  if (activityLog.length > 500) {
    activityLog.pop();
  }

  // If currently viewing Activity section, refresh
  if (currentSection === 'Activity') {
    renderActivityLog();
  }
}

// Format timestamp for display
function formatLogTimestamp(date) {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Get status badge class
function getStatusBadgeClass(status) {
  switch (status) {
    case 'success': return 'badge-success';
    case 'error': return 'badge-danger';
    case 'staged': return 'badge-warning';
    case 'reverted': return 'badge-info';
    default: return 'badge-secondary';
  }
}

// Get action icon
function getActionIcon(action) {
  switch (action) {
    case 'create':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    case 'update':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    case 'delete':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    case 'save':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>';
    case 'connect':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>';
    case 'staged':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    case 'revert':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
    default:
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
  }
}

// Render activity log view
function renderActivityLog() {
  if (activityLog.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>
        <h3 class="empty-state-title">No Activity Yet</h3>
        <p class="empty-state-text">Operations performed during this session will appear here.</p>
      </div>
    `;
    return;
  }

  const logHtml = activityLog.map(entry => {
    const hasCommands = entry.commands && entry.commands.length > 0;
    const commandsHtml = hasCommands ? `
      <div class="log-commands-toggle" onclick="toggleLogCommands(${entry.id})">
        <svg class="toggle-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span>${entry.commands.length} command${entry.commands.length > 1 ? 's' : ''}</span>
      </div>
      <div class="log-commands hidden" id="logCommands-${entry.id}">
        <pre class="log-commands-pre">${entry.commands.map(c => escapeHtml(c.cmd || c)).join('\n')}</pre>
      </div>
    ` : '';

    return `
      <div class="log-entry log-entry-${entry.status}">
        <div class="log-entry-header">
          <span class="log-time">${formatLogTimestamp(entry.timestamp)}</span>
          <span class="log-action-icon" title="${entry.action}">${getActionIcon(entry.action)}</span>
          <span class="log-type badge badge-outline">${entry.type}</span>
          <span class="log-target">${escapeHtml(entry.target)}</span>
          <span class="log-status badge ${getStatusBadgeClass(entry.status)}">${entry.status}</span>
        </div>
        <div class="log-entry-body">
          <span class="log-message">${escapeHtml(entry.message)}</span>
          ${commandsHtml}
        </div>
      </div>
    `;
  }).join('');

  content.innerHTML = `
    <div class="activity-log-container">
      <div class="activity-log-header">
        <h2>Activity Log</h2>
        <div class="activity-log-actions">
          <span class="log-count">${activityLog.length} entries</span>
          <button class="btn btn-secondary btn-sm" onclick="clearActivityLog()" title="Clear log">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            Clear
          </button>
        </div>
      </div>
      <div class="activity-log-entries">
        ${logHtml}
      </div>
    </div>
  `;
}

// Toggle commands visibility in log entry
function toggleLogCommands(id) {
  const commandsDiv = document.getElementById(`logCommands-${id}`);
  const toggleDiv = commandsDiv?.previousElementSibling;
  if (commandsDiv) {
    commandsDiv.classList.toggle('hidden');
    toggleDiv?.classList.toggle('expanded');
  }
}

// Clear activity log
async function clearActivityLog() {
  const confirmed = await openConfirmModal('Clear Activity Log?', 'This will remove all log entries from this session.');
  if (confirmed) {
    activityLog = [];
    renderActivityLog();
    showToast('info', 'Cleared', 'Activity log cleared');
  }
}

// =========================================
// INTERFACES (Read Only)
// =========================================
let interfacesData = null;

async function loadInterfaces() {
  content.innerHTML = showSkeletonTable(6, 4);

  try {
    const res = await fetch('/api/interfaces');
    interfacesData = await res.json();
    renderInterfaces();
  } catch (e) {
    showToast('error', 'Error', 'Failed to load interfaces');
    content.innerHTML = '<div class="empty-state"><p class="text-muted">Failed to load interfaces</p></div>';
  }
}

function renderInterfaces() {
  const interfaces = interfacesData || {};
  const interfaceTypes = [
    { key: 'ethernet', label: 'Ethernet', icon: 'ETH' },
    { key: 'bonding', label: 'Bonding', icon: 'BOND' },
    { key: 'bridge', label: 'Bridge', icon: 'BR' },
    { key: 'vlan', label: 'VLAN', icon: 'VLAN' },
    { key: 'loopback', label: 'Loopback', icon: 'LO' },
    { key: 'wireguard', label: 'WireGuard', icon: 'WG' },
    { key: 'openvpn', label: 'OpenVPN', icon: 'VPN' },
    { key: 'tunnel', label: 'Tunnel', icon: 'TUN' },
    { key: 'dummy', label: 'Dummy', icon: 'DUM' },
    { key: 'vti', label: 'VTI', icon: 'VTI' },
    { key: 'pppoe', label: 'PPPoE', icon: 'PPP' }
  ];

  // Check if any interfaces exist
  const hasInterfaces = interfaceTypes.some(it => Object.keys(interfaces[it.key] || {}).length > 0);

  if (!hasInterfaces) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
            <line x1="6" y1="6" x2="6.01" y2="6"/>
            <line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
        </div>
        <h3 class="empty-state-title">No Interfaces Found</h3>
        <p class="empty-state-text">No interfaces are configured on this device.</p>
      </div>
    `;
    return;
  }

  let html = '';

  for (const it of interfaceTypes) {
    const typeInterfaces = interfaces[it.key] || {};
    const ifaceNames = Object.keys(typeInterfaces);

    if (ifaceNames.length === 0) continue;

    html += `
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="card-header">
          <div class="card-title">
            <span class="badge badge-outline">${it.icon}</span>
            ${it.label}
            <span class="badge">${ifaceNames.length}</span>
          </div>
        </div>
        <div class="table-container">
          <table>
            <thead><tr>
              <th>Interface</th>
              <th>Addresses</th>
              <th>VRF</th>
              <th>Description</th>
              <th>Details</th>
            </tr></thead>
            <tbody>
    `;

    for (const ifaceName of ifaceNames.sort()) {
      const ifaceData = typeInterfaces[ifaceName];
      const addresses = getInterfaceAddresses(ifaceData);
      const description = ifaceData.description || '-';
      const details = getInterfaceDetails(it.key, ifaceData);
      const vrf = ifaceData.vrf || 'default';
      const vrfBadge = vrf === 'default'
        ? '<span class="badge badge-outline">default</span>'
        : `<span class="badge badge-primary">${escapeHtml(vrf)}</span>`;

      html += `
        <tr>
          <td><span class="badge badge-primary">${escapeHtml(ifaceName)}</span></td>
          <td>${addresses.length > 0 ? addresses.map(a => `<code>${escapeHtml(a)}</code>`).join('<br>') : '<span class="text-muted">-</span>'}</td>
          <td>${vrfBadge}</td>
          <td>${escapeHtml(description)}</td>
          <td><span class="text-muted">${escapeHtml(details)}</span></td>
        </tr>
      `;

      // Render subinterfaces (vif) if they exist
      if (ifaceData.vif) {
        const vifIds = Object.keys(ifaceData.vif).sort((a, b) => parseInt(a) - parseInt(b));
        for (const vifId of vifIds) {
          const vifData = ifaceData.vif[vifId];
          const vifAddresses = getInterfaceAddresses(vifData);
          const vifDescription = vifData.description || '-';
          const vifName = `${ifaceName}.${vifId}`;
          const vifVrf = vifData.vrf || vrf;  // Subinterface hereda VRF del padre si no tiene uno propio
          const vifVrfBadge = vifVrf === 'default'
            ? '<span class="badge badge-outline">default</span>'
            : `<span class="badge badge-primary">${escapeHtml(vifVrf)}</span>`;

          html += `
            <tr style="background: var(--bg-secondary);">
              <td><span class="badge badge-outline" style="margin-left: 1rem;">└ ${escapeHtml(vifName)}</span></td>
              <td>${vifAddresses.length > 0 ? vifAddresses.map(a => `<code>${escapeHtml(a)}</code>`).join('<br>') : '<span class="text-muted">-</span>'}</td>
              <td>${vifVrfBadge}</td>
              <td>${escapeHtml(vifDescription)}</td>
              <td><span class="text-muted">VLAN ${vifId}</span></td>
            </tr>
          `;
        }
      }
    }

    html += '</tbody></table></div></div>';
  }

  content.innerHTML = html;
}

function getInterfaceAddresses(ifaceData) {
  if (!ifaceData || !ifaceData.address) return [];
  if (typeof ifaceData.address === 'string') return [ifaceData.address];
  if (Array.isArray(ifaceData.address)) return ifaceData.address;
  if (typeof ifaceData.address === 'object') return Object.keys(ifaceData.address);
  return [];
}

function getInterfaceDetails(type, ifaceData) {
  const details = [];
  if (ifaceData['hw-id']) details.push(`MAC: ${ifaceData['hw-id']}`);
  if (ifaceData.vif) details.push(`VLANs: ${Object.keys(ifaceData.vif).join(', ')}`);
  if (ifaceData.mode) details.push(`Mode: ${ifaceData.mode}`);
  if (ifaceData.member) {
    const members = ifaceData.member?.interface;
    if (members) {
      const memberList = typeof members === 'object' ? Object.keys(members).join(', ') : members;
      details.push(`Members: ${memberList}`);
    }
  }
  if (ifaceData.interface) details.push(`Parent: ${ifaceData.interface}`);
  if (ifaceData.id) details.push(`ID: ${ifaceData.id}`);
  if (ifaceData.port) details.push(`Port: ${ifaceData.port}`);
  if (ifaceData.encapsulation) details.push(`Encap: ${ifaceData.encapsulation}`);
  if (ifaceData['source-address']) details.push(`Src: ${ifaceData['source-address']}`);
  if (ifaceData.remote) details.push(`Remote: ${ifaceData.remote}`);
  if (type === 'wireguard' && ifaceData.peer) {
    details.push(`Peers: ${Object.keys(ifaceData.peer).length}`);
  }
  return details.join(' | ') || '-';
}

// =========================================
// STATIC ROUTES
// =========================================
let routesData = null;

async function loadRoutes() {
  content.innerHTML = showSkeletonTable(6, 4);

  try {
    const res = await fetch('/api/static-routes');
    routesData = await res.json();
    renderRoutes();
  } catch (e) {
    showToast('error', 'Error', 'Failed to load static routes');
    content.innerHTML = '<div class="empty-state"><p class="text-muted">Failed to load static routes</p></div>';
  }
}

function renderRoutes() {
  const data = routesData || { default: {}, vrfs: {} };

  // Flatten all routes with their VRF info
  const allRoutes = [];

  // Default VRF routes
  for (const [network, routeData] of Object.entries(data.default || {})) {
    const parsed = parseRouteData(routeData);
    for (const route of parsed) {
      allRoutes.push({ network, vrf: 'default', ...route });
    }
  }

  // VRF-specific routes
  for (const [vrfName, routes] of Object.entries(data.vrfs || {})) {
    for (const [network, routeData] of Object.entries(routes)) {
      const parsed = parseRouteData(routeData);
      for (const route of parsed) {
        allRoutes.push({ network, vrf: vrfName, ...route });
      }
    }
  }

  if (allRoutes.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
        </div>
        <h3 class="empty-state-title">No Static Routes</h3>
        <p class="empty-state-text">No static routes are configured.</p>
        ${isConnected ? `
          <button class="btn btn-primary" onclick="openRouteModal('create')" style="margin-top: 1rem;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Static Route
          </button>
        ` : ''}
      </div>
    `;
    return;
  }

  // Sort routes: by VRF (default first), then by network
  allRoutes.sort((a, b) => {
    if (a.vrf === 'default' && b.vrf !== 'default') return -1;
    if (a.vrf !== 'default' && b.vrf === 'default') return 1;
    if (a.vrf !== b.vrf) return a.vrf.localeCompare(b.vrf);
    return a.network.localeCompare(b.network);
  });

  let html = '';

  // Add "New Route" button if connected
  if (isConnected) {
    html += `
      <div class="table-actions" style="margin-bottom: 1rem;">
        <button class="btn btn-success btn-sm" onclick="openRouteModal('create')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Static Route
        </button>
      </div>
    `;
  }

  // Count routes per VRF for display
  const vrfCounts = {};
  allRoutes.forEach(r => { vrfCounts[r.vrf] = (vrfCounts[r.vrf] || 0) + 1; });
  const vrfSummary = Object.entries(vrfCounts).map(([v, c]) => `${v}: ${c}`).join(', ');

  html += `
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          Static Routes
          <span class="badge">${allRoutes.length} routes</span>
          <span class="text-muted" style="font-size: 0.8rem; margin-left: 0.5rem;">(${vrfSummary})</span>
        </div>
      </div>
      <div class="table-container">
        <table>
          <thead><tr>
            <th>Destination</th>
            <th>VRF</th>
            <th>Type</th>
            <th>Target</th>
            <th>Distance</th>
            ${isConnected ? '<th class="actions-col">Actions</th>' : ''}
          </tr></thead>
          <tbody>
  `;

  for (const route of allRoutes) {
    const pendingStatus = getRoutePendingStatus(route.network, route.target);
    const pendingClass = pendingStatus === 'delete' ? 'pending-delete' : (pendingStatus ? 'pending-change' : '');
    const pendingBadge = pendingStatus ? `<span class="pending-badge">${pendingStatus === 'delete' ? 'DEL' : 'MOD'}</span>` : '';
    const vrfBadge = route.vrf === 'default'
      ? '<span class="badge badge-outline">default</span>'
      : `<span class="badge badge-primary">${escapeHtml(route.vrf)}</span>`;
    const targetVrf = route.targetVrf ? ` <span class="text-muted">(via ${route.targetVrf})</span>` : '';

    html += `
      <tr class="${pendingClass}">
        <td><code>${escapeHtml(route.network)}</code>${pendingBadge}</td>
        <td>${vrfBadge}</td>
        <td><span class="badge badge-outline">${route.type}</span></td>
        <td>${route.target ? `<code>${escapeHtml(route.target)}</code>${targetVrf}` : '<span class="text-muted">-</span>'}</td>
        <td>${route.distance || '<span class="text-muted">default</span>'}</td>
        ${isConnected ? `
          <td class="actions-col">
            <button class="btn-icon btn-danger" onclick="deleteRoute('${escapeHtml(route.network)}', '${escapeHtml(route.target || '')}', '${escapeHtml(route.vrf)}')" title="Delete">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </td>
        ` : ''}
      </tr>
    `;
  }

  html += '</tbody></table></div></div>';
  content.innerHTML = html;
}

function parseRouteData(routeData) {
  const routes = [];

  // Next-hop routes
  if (routeData['next-hop']) {
    for (const [nhIP, nhData] of Object.entries(routeData['next-hop'])) {
      routes.push({
        type: 'next-hop',
        target: nhIP,
        distance: nhData?.distance || null,
        targetVrf: nhData?.vrf || null  // VRF del next-hop (inter-VRF routing)
      });
    }
  }

  // Blackhole routes
  if (routeData.blackhole !== undefined) {
    routes.push({
      type: 'blackhole',
      target: null,
      distance: typeof routeData.blackhole === 'object' ? routeData.blackhole.distance : null
    });
  }

  // Interface routes
  if (routeData.interface) {
    for (const [iface, ifData] of Object.entries(routeData.interface)) {
      routes.push({
        type: 'interface',
        target: iface,
        distance: ifData?.distance || null,
        targetVrf: ifData?.vrf || null  // VRF de la interfaz (inter-VRF routing)
      });
    }
  }

  return routes.length > 0 ? routes : [{ type: 'unknown', target: null, distance: null }];
}

function getRoutePendingStatus(network, target) {
  if (!stagedMode) return null;
  const marker = `route:${network}:${target || ''}`;
  if (pendingRuleMarkers.has(marker)) {
    const op = pendingOperations.find(o => o.type === 'route' && o.data.network === network);
    return op?.action === 'delete' ? 'delete' : 'update';
  }
  return null;
}

// Open route creation modal
async function openRouteModal(mode) {
  const modal = document.getElementById('routeModal');
  if (!modal) {
    // Create modal dynamically
    createRouteModal();
  }

  document.getElementById('routeMode').value = mode;
  document.getElementById('routeNetwork').value = '';
  document.getElementById('routeType').value = 'next-hop';
  document.getElementById('routeTarget').value = '';
  document.getElementById('routeDistance').value = '';
  document.getElementById('routeTitle').textContent = mode === 'create' ? 'New Static Route' : 'Edit Static Route';

  // Populate VRF selector with available VRFs from API
  const vrfSelect = document.getElementById('routeVrf');
  if (vrfSelect) {
    vrfSelect.innerHTML = '<option value="default">default</option>';
    try {
      const res = await fetch('/api/vrfs');
      const vrfNames = await res.json();
      for (const vrf of vrfNames.sort()) {
        vrfSelect.innerHTML += `<option value="${escapeHtml(vrf)}">${escapeHtml(vrf)}</option>`;
      }
    } catch (e) {
      // Fallback: use VRFs from routes data
      const data = routesData || { default: {}, vrfs: {} };
      for (const vrf of Object.keys(data.vrfs || {}).sort()) {
        vrfSelect.innerHTML += `<option value="${escapeHtml(vrf)}">${escapeHtml(vrf)}</option>`;
      }
    }
    vrfSelect.value = 'default';
  }

  toggleRouteTargetField();
  openModal('routeModal');
}

function toggleRouteTargetField() {
  const routeType = document.getElementById('routeType').value;
  const targetGroup = document.getElementById('routeTargetGroup');
  const targetLabel = document.getElementById('routeTargetLabel');

  if (routeType === 'blackhole') {
    targetGroup.classList.add('hidden');
  } else {
    targetGroup.classList.remove('hidden');
    targetLabel.textContent = routeType === 'next-hop' ? 'Next-Hop IP *' : 'Interface Name *';
    document.getElementById('routeTarget').placeholder = routeType === 'next-hop' ? '10.0.0.1' : 'eth0';
  }
}

async function saveRoute() {
  const network = document.getElementById('routeNetwork').value.trim();
  const routeType = document.getElementById('routeType').value;
  const target = document.getElementById('routeTarget').value.trim();
  const distance = document.getElementById('routeDistance').value.trim();
  const vrf = document.getElementById('routeVrf')?.value || 'default';

  if (!network) {
    showToast('error', 'Validation Error', 'Destination network is required');
    return;
  }

  if (routeType !== 'blackhole' && !target) {
    showToast('error', 'Validation Error', 'Target is required');
    return;
  }

  const routeData = {
    network,
    type: routeType,
    target: routeType !== 'blackhole' ? target : undefined,
    distance: distance ? parseInt(distance) : undefined,
    vrf: vrf !== 'default' ? vrf : undefined
  };

  // Build commands for verbose mode and logging
  const commands = buildRouteCommands(routeData);

  if (stagedMode) {
    // Stage the operation
    const marker = `route:${vrf}:${network}:${target || ''}`;
    pendingOperations.push({
      type: 'route',
      action: 'create',
      data: routeData,
      display: `Static route ${network} via ${target || routeType}${vrf !== 'default' ? ' (VRF: ' + vrf + ')' : ''}`
    });
    pendingRuleMarkers.add(marker);
    updatePendingIndicator();
    closeModal('routeModal');
    loadRoutes();
    showToast('info', 'Staged', `Route ${network} queued for creation`);
    logActivity('route', 'staged', `Route ${network}`, 'staged', `Route staged for creation`, commands);
    return;
  }

  // Actual save function
  const doSave = async () => {
    closeModal('routeModal');
    showLoading('Creating route...');

    try {
      const j = await clusterApplyFetch('/api/static-route', 'POST', routeData);

      hasUnsavedChanges = true;
      updateSaveIndicator();
      await loadRoutes();
      showToast('success', 'Success', `Route ${network} created`);
      logActivity('route', 'create', `Route ${network}`, 'success',
                  `Created static route to ${network}${clusterNodesSuffix(j)}`, commands);
    } catch (e) {
      logActivity('route', 'create', `Route ${network}`, 'error', e.message);
      if (!e.isDivergence) showToast('error', 'Error', e.message);
      loadRoutes();
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    showCommandPreview(commands, doSave);
  } else {
    await doSave();
  }
}

// Build VyOS commands for static route
function buildRouteCommands(routeData) {
  const { network, type, target, distance, vrf } = routeData;
  const commands = [];

  // Base path depends on VRF
  const basePath = vrf && vrf !== 'default'
    ? `vrf name ${vrf} protocols static route ${network}`
    : `protocols static route ${network}`;

  if (type === 'next-hop') {
    commands.push({ cmd: `set ${basePath} next-hop ${target}` });
    if (distance) {
      commands.push({ cmd: `set ${basePath} next-hop ${target} distance ${distance}` });
    }
  } else if (type === 'blackhole') {
    commands.push({ cmd: `set ${basePath} blackhole` });
    if (distance) {
      commands.push({ cmd: `set ${basePath} blackhole distance ${distance}` });
    }
  } else if (type === 'interface') {
    commands.push({ cmd: `set ${basePath} interface ${target}` });
    if (distance) {
      commands.push({ cmd: `set ${basePath} interface ${target} distance ${distance}` });
    }
  }

  return commands;
}

async function deleteRoute(network, target, vrf = 'default') {
  const vrfLabel = vrf !== 'default' ? ` (VRF: ${vrf})` : '';
  const confirmed = await openConfirmModal(
    'Delete Static Route?',
    `Are you sure you want to delete the route to ${network}${vrfLabel}?`
  );

  if (!confirmed) return;

  const vrfParam = vrf !== 'default' ? vrf : undefined;

  // Build delete command
  const basePath = vrf !== 'default'
    ? `vrf name ${vrf} protocols static route ${network}`
    : `protocols static route ${network}`;
  const commands = [{ cmd: `delete ${basePath}` }];

  if (stagedMode) {
    const marker = `route:${vrf}:${network}:${target || ''}`;
    pendingOperations.push({
      type: 'route',
      action: 'delete',
      data: { network, next_hop: target || undefined, vrf: vrfParam },
      display: `Delete route ${network}${vrfLabel}`
    });
    pendingRuleMarkers.add(marker);
    updatePendingIndicator();
    loadRoutes();
    showToast('info', 'Staged', `Route deletion queued`);
    logActivity('route', 'staged', `Route ${network}${vrfLabel}`, 'staged', `Route staged for deletion`, commands);
    return;
  }

  // Actual delete function
  const doDelete = async () => {
    showLoading('Deleting route...');

    try {
      const j = await clusterApplyFetch('/api/static-route', 'DELETE',
        { network, next_hop: target || undefined, vrf: vrfParam });

      hasUnsavedChanges = true;
      updateSaveIndicator();
      await loadRoutes();
      showToast('success', 'Success', `Route ${network} deleted`);
      logActivity('route', 'delete', `Route ${network}${vrfLabel}`, 'success',
                  `Deleted static route to ${network}${clusterNodesSuffix(j)}`, commands);
    } catch (e) {
      logActivity('route', 'delete', `Route ${network}${vrfLabel}`, 'error', e.message);
      if (!e.isDivergence) showToast('error', 'Error', e.message);
      loadRoutes();
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    showCommandPreview(commands, doDelete);
  } else {
    await doDelete();
  }
}

function createRouteModal() {
  const modal = document.createElement('div');
  modal.id = 'routeModal';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal('routeModal')"></div>
    <div class="modal-content modal-md">
      <div class="modal-header">
        <h3 id="routeTitle">New Static Route</h3>
        <button class="modal-close" onclick="closeModal('routeModal')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="routeMode" value="create">
        <div class="form-group">
          <label>Destination Network (CIDR) *</label>
          <input type="text" id="routeNetwork" placeholder="10.0.0.0/8" required>
        </div>
        <div class="form-group">
          <label>VRF</label>
          <select id="routeVrf">
            <option value="default">default</option>
          </select>
          <small class="text-muted">Virtual Routing and Forwarding instance</small>
        </div>
        <div class="form-group">
          <label>Route Type *</label>
          <select id="routeType" onchange="toggleRouteTargetField()">
            <option value="next-hop">Next-Hop</option>
            <option value="blackhole">Blackhole</option>
            <option value="interface">Interface</option>
          </select>
        </div>
        <div class="form-group" id="routeTargetGroup">
          <label id="routeTargetLabel">Next-Hop IP *</label>
          <input type="text" id="routeTarget" placeholder="10.0.0.1">
        </div>
        <div class="form-group">
          <label>Administrative Distance</label>
          <input type="number" id="routeDistance" min="1" max="255" placeholder="1 (default)">
          <small class="text-muted">Lower values have higher priority</small>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('routeModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveRoute()">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

// =========================================
// GLOBAL SEARCH
// =========================================
let globalSearchResults = [];

function openGlobalSearch() {
  const existingModal = document.getElementById('globalSearchModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'globalSearchModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal('globalSearchModal')"></div>
    <div class="modal-content modal-lg">
      <div class="modal-header">
        <h3>Global Search</h3>
        <button class="modal-close" onclick="closeModal('globalSearchModal')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <input type="text" id="globalSearchInput" placeholder="Search IP, network, port, name..." autofocus
            oninput="performGlobalSearch(this.value)">
          <small class="text-muted">Search across firewall rules, NAT, groups, interfaces, routes, and BGP</small>
        </div>
        <div id="globalSearchResults" class="global-search-results"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Focus the input
  setTimeout(() => document.getElementById('globalSearchInput').focus(), 100);
}

function performGlobalSearch(query) {
  const resultsDiv = document.getElementById('globalSearchResults');
  if (!query || query.length < 2) {
    resultsDiv.innerHTML = '<p class="text-muted text-center">Enter at least 2 characters to search</p>';
    return;
  }

  const q = query.toLowerCase();
  const results = {
    firewall: [],
    nat: [],
    groups: [],
    interfaces: [],
    routes: [],
    bgp: []
  };

  // Search firewall rules
  const fwRulesets = CONFIG?.firewall?.name || {};
  for (const [rsName, rsData] of Object.entries(fwRulesets)) {
    for (const [ruleNum, rule] of Object.entries(rsData.rule || {})) {
      if (matchesQuery(rule, q) || rsName.toLowerCase().includes(q)) {
        results.firewall.push({
          section: 'Firewall',
          target: `${rsName} Rule ${ruleNum}`,
          match: rule.description || `Action: ${rule.action || 'not set'}`,
          action: () => { closeModal('globalSearchModal'); loadRuleset(rsName); }
        });
      }
    }
  }

  // Search NAT rules
  const natTypes = [
    { key: 'destination', label: 'DNAT' },
    { key: 'source', label: 'SNAT' }
  ];
  for (const nt of natTypes) {
    const rules = CONFIG?.nat?.[nt.key]?.rule || {};
    for (const [ruleNum, rule] of Object.entries(rules)) {
      if (matchesQuery(rule, q)) {
        results.nat.push({
          section: 'NAT',
          target: `${nt.label} Rule ${ruleNum}`,
          match: rule.description || `Translation: ${rule.translation?.address || 'not set'}`,
          action: () => { closeModal('globalSearchModal'); loadSection('NAT'); }
        });
      }
    }
  }

  // Search groups
  const groupTypes = ['address-group', 'network-group', 'port-group'];
  for (const gtype of groupTypes) {
    const groups = CONFIG?.firewall?.group?.[gtype] || {};
    for (const [gname, gdata] of Object.entries(groups)) {
      if (gname.toLowerCase().includes(q) || matchesGroupEntries(gdata, q)) {
        results.groups.push({
          section: 'Groups',
          target: gname,
          match: gtype.replace('-group', ''),
          action: () => { closeModal('globalSearchModal'); loadSection('Groups'); }
        });
      }
    }
  }

  // Search interfaces
  const interfaces = CONFIG?.interfaces || {};
  for (const [itype, ifaces] of Object.entries(interfaces)) {
    if (typeof ifaces !== 'object') continue;
    for (const [ifname, ifdata] of Object.entries(ifaces)) {
      if (ifname.toLowerCase().includes(q) || matchesInterface(ifdata, q)) {
        results.interfaces.push({
          section: 'Interfaces',
          target: ifname,
          match: ifdata.description || ifdata.address || itype,
          action: () => { closeModal('globalSearchModal'); loadSection('Interfaces'); }
        });
      }
    }
  }

  // Search routes
  const routes = CONFIG?.protocols?.static?.route || {};
  for (const [network, routeData] of Object.entries(routes)) {
    if (network.includes(q) || matchesRoute(routeData, q)) {
      results.routes.push({
        section: 'Routes',
        target: network,
        match: getRouteTarget(routeData),
        action: () => { closeModal('globalSearchModal'); loadSection('Routes'); }
      });
    }
  }

  // Search BGP
  const bgp = CONFIG?.protocols?.bgp || {};
  for (const [neighborIP, nbrData] of Object.entries(bgp.neighbor || {})) {
    if (neighborIP.includes(q) || (nbrData.description || '').toLowerCase().includes(q) ||
        String(nbrData['remote-as']).includes(q)) {
      results.bgp.push({
        section: 'BGP',
        target: `Neighbor ${neighborIP}`,
        match: `AS ${nbrData['remote-as']}`,
        action: () => { closeModal('globalSearchModal'); loadSection('BGP'); }
      });
    }
  }
  for (const network of Object.keys(bgp['address-family']?.['ipv4-unicast']?.network || {})) {
    if (network.includes(q)) {
      results.bgp.push({
        section: 'BGP',
        target: `Network ${network}`,
        match: 'Advertised network',
        action: () => { closeModal('globalSearchModal'); loadSection('BGP'); }
      });
    }
  }

  // Render results
  renderGlobalSearchResults(results);
}

function matchesQuery(obj, query) {
  if (!obj || typeof obj !== 'object') return false;
  const str = JSON.stringify(obj).toLowerCase();
  return str.includes(query);
}

function matchesGroupEntries(gdata, query) {
  const entries = gdata.address || gdata.network || gdata.port || [];
  const arr = Array.isArray(entries) ? entries : Object.keys(entries);
  return arr.some(e => String(e).toLowerCase().includes(query));
}

function matchesInterface(ifdata, query) {
  if (!ifdata) return false;
  const addresses = ifdata.address;
  if (addresses) {
    const addrs = Array.isArray(addresses) ? addresses :
      (typeof addresses === 'object' ? Object.keys(addresses) : [addresses]);
    if (addrs.some(a => String(a).includes(query))) return true;
  }
  if ((ifdata.description || '').toLowerCase().includes(query)) return true;
  if ((ifdata['hw-id'] || '').toLowerCase().includes(query)) return true;
  return false;
}

function matchesRoute(routeData, query) {
  if (routeData['next-hop']) {
    for (const nh of Object.keys(routeData['next-hop'])) {
      if (nh.includes(query)) return true;
    }
  }
  if (routeData.interface) {
    for (const iface of Object.keys(routeData.interface)) {
      if (iface.toLowerCase().includes(query)) return true;
    }
  }
  return false;
}

function getRouteTarget(routeData) {
  if (routeData['next-hop']) {
    return `via ${Object.keys(routeData['next-hop']).join(', ')}`;
  }
  if (routeData.blackhole !== undefined) return 'blackhole';
  if (routeData.interface) {
    return `via ${Object.keys(routeData.interface).join(', ')}`;
  }
  return 'unknown';
}

function renderGlobalSearchResults(results) {
  const resultsDiv = document.getElementById('globalSearchResults');
  const allResults = [
    ...results.firewall,
    ...results.nat,
    ...results.groups,
    ...results.interfaces,
    ...results.routes,
    ...results.bgp
  ];

  if (allResults.length === 0) {
    resultsDiv.innerHTML = '<p class="text-muted text-center">No results found</p>';
    return;
  }

  // Store for navigation
  globalSearchResults = allResults;

  let html = `<p class="text-muted" style="margin-bottom: 0.75rem">${allResults.length} result(s) found</p>`;

  // Group by section
  const sections = ['Firewall', 'NAT', 'Groups', 'Interfaces', 'Routes', 'BGP'];
  for (const section of sections) {
    const sectionResults = allResults.filter(r => r.section === section);
    if (sectionResults.length === 0) continue;

    html += `<div class="search-result-section">
      <div class="search-result-section-header">${section} (${sectionResults.length})</div>`;

    for (let i = 0; i < sectionResults.length; i++) {
      const r = sectionResults[i];
      const globalIdx = allResults.indexOf(r);
      html += `
        <div class="search-result-item" onclick="globalSearchResults[${globalIdx}].action()">
          <span class="search-result-target">${escapeHtml(r.target)}</span>
          <span class="search-result-match text-muted">${escapeHtml(r.match)}</span>
        </div>
      `;
    }

    html += '</div>';
  }

  resultsDiv.innerHTML = html;
}

// =========================================
// BGP CONFIGURATION
// =========================================
let bgpData = null;

async function loadBGP() {
  content.innerHTML = showSkeletonTable(6, 5);

  try {
    const res = await fetch('/api/bgp');
    bgpData = await res.json();
    renderBGP();
  } catch (e) {
    showToast('error', 'Error', 'Failed to load BGP configuration');
    content.innerHTML = '<div class="empty-state"><p class="text-muted">Failed to load BGP configuration</p></div>';
  }
}

function renderBGP() {
  const bgp = bgpData || {};
  const systemAs = bgp['system-as'] || null;
  const neighbors = bgp.neighbor || {};
  const networks = bgp['address-family']?.['ipv4-unicast']?.network || {};
  const redistribute = bgp['address-family']?.['ipv4-unicast']?.redistribute || {};

  const hasConfig = systemAs || Object.keys(neighbors).length > 0 || Object.keys(networks).length > 0;

  if (!hasConfig) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="5" r="3"/>
            <circle cx="5" cy="19" r="3"/>
            <circle cx="19" cy="19" r="3"/>
            <line x1="12" y1="8" x2="5" y2="16"/>
            <line x1="12" y1="8" x2="19" y2="16"/>
          </svg>
        </div>
        <h3 class="empty-state-title">BGP Not Configured</h3>
        <p class="empty-state-text">BGP routing protocol is not configured on this device.</p>
        ${isConnected ? `
          <button class="btn btn-primary" onclick="openBGPSystemAsModal()" style="margin-top: 1rem;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Configure BGP
          </button>
        ` : ''}
      </div>
    `;
    return;
  }

  let html = '';

  // BGP Overview Card
  html += `
    <div class="stats-grid" style="margin-bottom: 1.5rem;">
      <div class="stat-card">
        <div class="stat-icon" style="background-color: var(--info-light, #e0f2fe); color: var(--info-color, #0284c7);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-value">${systemAs || '<span class="text-muted">Not Set</span>'}</div>
          <div class="stat-label">Local AS</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background-color: var(--success-light); color: var(--success-color);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-value">${Object.keys(neighbors).length}</div>
          <div class="stat-label">Neighbors</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background-color: var(--warning-light); color: var(--warning-color);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-value">${Object.keys(networks).length}</div>
          <div class="stat-label">Advertised Networks</div>
        </div>
      </div>
    </div>
  `;

  // Redistribution info
  if (Object.keys(redistribute).length > 0) {
    const redistTypes = Object.keys(redistribute).join(', ');
    html += `
      <div class="card" style="margin-bottom: 1rem; padding: 0.75rem 1rem; display: flex; align-items: center; gap: 0.5rem;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span class="text-muted">Redistributing:</span>
        <span class="badge badge-outline">${escapeHtml(redistTypes)}</span>
      </div>
    `;
  }

  // Action buttons if connected
  if (isConnected) {
    html += `
      <div class="table-actions" style="margin-bottom: 1rem;">
        <button class="btn btn-success btn-sm" onclick="openBGPNeighborModal('create')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add Neighbor
        </button>
        <button class="btn btn-success btn-sm" onclick="openBGPNetworkModal('create')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add Network
        </button>
        ${!systemAs ? `
          <button class="btn btn-primary btn-sm" onclick="openBGPSystemAsModal()">
            Set Local AS
          </button>
        ` : ''}
      </div>
    `;
  }

  // Neighbors Table
  if (Object.keys(neighbors).length > 0) {
    html += `
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="card-header">
          <div class="card-title">BGP Neighbors</div>
        </div>
        <div class="table-container">
          <table>
            <thead><tr>
              <th>Neighbor IP</th>
              <th>Remote AS</th>
              <th>Description</th>
              <th>Update Source</th>
              <th>eBGP Multihop</th>
              ${isConnected ? '<th class="actions-col">Actions</th>' : ''}
            </tr></thead>
            <tbody>
    `;

    for (const [neighborIP, nbrData] of Object.entries(neighbors)) {
      const pendingStatus = getBGPPendingStatus('neighbor', neighborIP);
      const pendingClass = pendingStatus === 'delete' ? 'pending-delete' : (pendingStatus ? 'pending-change' : '');
      const pendingBadge = pendingStatus ? `<span class="pending-badge">${pendingStatus === 'delete' ? 'DEL' : 'MOD'}</span>` : '';

      html += `
        <tr class="${pendingClass}">
          <td><code>${escapeHtml(neighborIP)}</code>${pendingBadge}</td>
          <td><span class="badge">${nbrData['remote-as'] || '-'}</span></td>
          <td>${escapeHtml(nbrData.description || '-')}</td>
          <td>${nbrData['update-source'] ? `<code>${escapeHtml(nbrData['update-source'])}</code>` : '<span class="text-muted">-</span>'}</td>
          <td>${nbrData['ebgp-multihop'] || '<span class="text-muted">-</span>'}</td>
          ${isConnected ? `
            <td class="actions-col">
              <button class="btn-icon btn-danger" onclick="deleteBGPNeighbor('${escapeHtml(neighborIP)}')" title="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </td>
          ` : ''}
        </tr>
      `;
    }

    html += '</tbody></table></div></div>';
  }

  // Networks Table
  if (Object.keys(networks).length > 0) {
    html += `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Advertised Networks</div>
        </div>
        <div class="table-container">
          <table>
            <thead><tr>
              <th>Network</th>
              ${isConnected ? '<th class="actions-col">Actions</th>' : ''}
            </tr></thead>
            <tbody>
    `;

    for (const network of Object.keys(networks).sort()) {
      const pendingStatus = getBGPPendingStatus('network', network);
      const pendingClass = pendingStatus === 'delete' ? 'pending-delete' : (pendingStatus ? 'pending-change' : '');
      const pendingBadge = pendingStatus ? `<span class="pending-badge">${pendingStatus === 'delete' ? 'DEL' : 'MOD'}</span>` : '';

      html += `
        <tr class="${pendingClass}">
          <td><code>${escapeHtml(network)}</code>${pendingBadge}</td>
          ${isConnected ? `
            <td class="actions-col">
              <button class="btn-icon btn-danger" onclick="deleteBGPNetwork('${escapeHtml(network)}')" title="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </td>
          ` : ''}
        </tr>
      `;
    }

    html += '</tbody></table></div></div>';
  }

  content.innerHTML = html;
}

function getBGPPendingStatus(type, id) {
  if (!stagedMode) return null;
  const marker = `bgp:${type}:${id}`;
  if (pendingRuleMarkers.has(marker)) {
    const op = pendingOperations.find(o => o.type === 'bgp' && o.data.bgpType === type &&
      (o.data.neighbor === id || o.data.network === id));
    return op?.action === 'delete' ? 'delete' : 'update';
  }
  return null;
}

// BGP Modals
function openBGPSystemAsModal() {
  const existingModal = document.getElementById('bgpSystemAsModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'bgpSystemAsModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal('bgpSystemAsModal')"></div>
    <div class="modal-content modal-sm">
      <div class="modal-header">
        <h3>Set Local AS</h3>
        <button class="modal-close" onclick="closeModal('bgpSystemAsModal')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Local AS Number *</label>
          <input type="number" id="bgpSystemAs" min="1" max="4294967295" placeholder="65000" required>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('bgpSystemAsModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveBGPSystemAs()">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function saveBGPSystemAs() {
  const systemAs = document.getElementById('bgpSystemAs').value.trim();
  if (!systemAs) {
    showToast('error', 'Validation Error', 'AS number is required');
    return;
  }

  closeModal('bgpSystemAsModal');
  showLoading('Configuring BGP...');

  try {
    const res = await fetch('/api/bgp/system-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_as: parseInt(systemAs) })
    });
    const j = await res.json();

    if (!res.ok) throw new Error(j.error || 'Failed to set system AS');

    hasUnsavedChanges = true;
    updateSaveIndicator();
    await loadBGP();
    showToast('success', 'Success', `BGP local AS set to ${systemAs}`);
    logActivity('bgp', 'update', 'System AS', 'success', `Set BGP local AS to ${systemAs}`, [
      { cmd: `set protocols bgp system-as ${systemAs}` }
    ]);
  } catch (e) {
    logActivity('bgp', 'update', 'System AS', 'error', e.message);
    showToast('error', 'Error', e.message);
    loadBGP();
  }
}

function openBGPNeighborModal(mode) {
  const existingModal = document.getElementById('bgpNeighborModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'bgpNeighborModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal('bgpNeighborModal')"></div>
    <div class="modal-content modal-lg">
      <div class="modal-header">
        <h3>Add BGP Neighbor</h3>
        <button class="modal-close" onclick="closeModal('bgpNeighborModal')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label>Neighbor IP *</label>
            <input type="text" id="bgpNeighborIP" placeholder="10.0.0.1" required>
          </div>
          <div class="form-group">
            <label>Remote AS *</label>
            <input type="number" id="bgpRemoteAs" min="1" max="4294967295" placeholder="65001" required>
          </div>
        </div>
        <div class="form-group">
          <label>Description</label>
          <input type="text" id="bgpNeighborDesc" placeholder="Upstream Provider">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Update Source</label>
            <input type="text" id="bgpUpdateSource" placeholder="10.0.0.2 or eth0">
          </div>
          <div class="form-group">
            <label>eBGP Multihop</label>
            <input type="number" id="bgpMultihop" min="1" max="255" placeholder="2">
          </div>
        </div>
        <fieldset class="form-fieldset">
          <legend>Address Family IPv4</legend>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="bgpIpv4Unicast" checked>
              <span>Enable IPv4 Unicast</span>
            </label>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="bgpSoftReconfig">
              <span>Soft Reconfiguration Inbound</span>
            </label>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Route-map Import</label>
              <input type="text" id="bgpRouteMapIn" placeholder="IMPORT-MAP">
            </div>
            <div class="form-group">
              <label>Route-map Export</label>
              <input type="text" id="bgpRouteMapOut" placeholder="EXPORT-MAP">
            </div>
          </div>
        </fieldset>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('bgpNeighborModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveBGPNeighbor()">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function saveBGPNeighbor() {
  const neighborIP = document.getElementById('bgpNeighborIP').value.trim();
  const remoteAs = document.getElementById('bgpRemoteAs').value.trim();

  if (!neighborIP || !remoteAs) {
    showToast('error', 'Validation Error', 'Neighbor IP and Remote AS are required');
    return;
  }

  const neighborData = {
    neighbor: neighborIP,
    remote_as: parseInt(remoteAs),
    description: document.getElementById('bgpNeighborDesc').value.trim() || undefined,
    update_source: document.getElementById('bgpUpdateSource').value.trim() || undefined,
    ebgp_multihop: document.getElementById('bgpMultihop').value.trim() ? parseInt(document.getElementById('bgpMultihop').value) : undefined,
    ipv4_unicast: document.getElementById('bgpIpv4Unicast').checked,
    soft_reconfiguration: document.getElementById('bgpSoftReconfig').checked,
    route_map_import: document.getElementById('bgpRouteMapIn').value.trim() || undefined,
    route_map_export: document.getElementById('bgpRouteMapOut').value.trim() || undefined
  };

  if (stagedMode) {
    const marker = `bgp:neighbor:${neighborIP}`;
    pendingOperations.push({
      type: 'bgp',
      action: 'create',
      data: { bgpType: 'neighbor', ...neighborData },
      display: `BGP neighbor ${neighborIP} AS ${remoteAs}`
    });
    pendingRuleMarkers.add(marker);
    updatePendingIndicator();
    closeModal('bgpNeighborModal');
    loadBGP();
    showToast('info', 'Staged', `BGP neighbor ${neighborIP} queued for creation`);
    logActivity('bgp', 'staged', `Neighbor ${neighborIP}`, 'staged', `Neighbor staged for creation`);
    return;
  }

  closeModal('bgpNeighborModal');
  showLoading('Adding BGP neighbor...');

  try {
    const res = await fetch('/api/bgp/neighbor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(neighborData)
    });
    const j = await res.json();

    if (!res.ok) throw new Error(j.error || 'Failed to add neighbor');

    hasUnsavedChanges = true;
    updateSaveIndicator();
    await loadBGP();
    showToast('success', 'Success', `BGP neighbor ${neighborIP} added`);
    logActivity('bgp', 'create', `Neighbor ${neighborIP}`, 'success', `Added BGP neighbor ${neighborIP} AS ${remoteAs}`, [
      { cmd: `set protocols bgp neighbor ${neighborIP} remote-as ${remoteAs}` }
    ]);
  } catch (e) {
    logActivity('bgp', 'create', `Neighbor ${neighborIP}`, 'error', e.message);
    showToast('error', 'Error', e.message);
    loadBGP();
  }
}

async function deleteBGPNeighbor(neighborIP) {
  const confirmed = await openConfirmModal(
    'Delete BGP Neighbor?',
    `Are you sure you want to delete neighbor ${neighborIP}?`
  );

  if (!confirmed) return;

  if (stagedMode) {
    const marker = `bgp:neighbor:${neighborIP}`;
    pendingOperations.push({
      type: 'bgp',
      action: 'delete',
      data: { bgpType: 'neighbor', neighbor: neighborIP },
      display: `Delete BGP neighbor ${neighborIP}`
    });
    pendingRuleMarkers.add(marker);
    updatePendingIndicator();
    loadBGP();
    showToast('info', 'Staged', `Neighbor deletion queued`);
    logActivity('bgp', 'staged', `Neighbor ${neighborIP}`, 'staged', `Neighbor staged for deletion`);
    return;
  }

  showLoading('Deleting BGP neighbor...');

  try {
    const res = await fetch('/api/bgp/neighbor', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ neighbor: neighborIP })
    });
    const j = await res.json();

    if (!res.ok) throw new Error(j.error || 'Failed to delete neighbor');

    hasUnsavedChanges = true;
    updateSaveIndicator();
    await loadBGP();
    showToast('success', 'Success', `BGP neighbor ${neighborIP} deleted`);
    logActivity('bgp', 'delete', `Neighbor ${neighborIP}`, 'success', `Deleted BGP neighbor ${neighborIP}`, [
      { cmd: `delete protocols bgp neighbor ${neighborIP}` }
    ]);
  } catch (e) {
    logActivity('bgp', 'delete', `Neighbor ${neighborIP}`, 'error', e.message);
    showToast('error', 'Error', e.message);
    loadBGP();
  }
}

function openBGPNetworkModal(mode) {
  const existingModal = document.getElementById('bgpNetworkModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'bgpNetworkModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeModal('bgpNetworkModal')"></div>
    <div class="modal-content modal-sm">
      <div class="modal-header">
        <h3>Add BGP Network</h3>
        <button class="modal-close" onclick="closeModal('bgpNetworkModal')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Network (CIDR) *</label>
          <input type="text" id="bgpNetworkCIDR" placeholder="192.168.0.0/24" required>
          <small class="text-muted">Network to advertise via BGP</small>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('bgpNetworkModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveBGPNetwork()">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function saveBGPNetwork() {
  const network = document.getElementById('bgpNetworkCIDR').value.trim();
  if (!network) {
    showToast('error', 'Validation Error', 'Network is required');
    return;
  }

  if (stagedMode) {
    const marker = `bgp:network:${network}`;
    pendingOperations.push({
      type: 'bgp',
      action: 'create',
      data: { bgpType: 'network', network },
      display: `BGP network ${network}`
    });
    pendingRuleMarkers.add(marker);
    updatePendingIndicator();
    closeModal('bgpNetworkModal');
    loadBGP();
    showToast('info', 'Staged', `BGP network ${network} queued`);
    logActivity('bgp', 'staged', `Network ${network}`, 'staged', `Network staged for advertisement`);
    return;
  }

  closeModal('bgpNetworkModal');
  showLoading('Adding BGP network...');

  try {
    const res = await fetch('/api/bgp/network', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ network })
    });
    const j = await res.json();

    if (!res.ok) throw new Error(j.error || 'Failed to add network');

    hasUnsavedChanges = true;
    updateSaveIndicator();
    await loadBGP();
    showToast('success', 'Success', `BGP network ${network} added`);
    logActivity('bgp', 'create', `Network ${network}`, 'success', `Added BGP network ${network}`, [
      { cmd: `set protocols bgp address-family ipv4-unicast network ${network}` }
    ]);
  } catch (e) {
    logActivity('bgp', 'create', `Network ${network}`, 'error', e.message);
    showToast('error', 'Error', e.message);
    loadBGP();
  }
}

async function deleteBGPNetwork(network) {
  const confirmed = await openConfirmModal(
    'Delete BGP Network?',
    `Are you sure you want to stop advertising ${network}?`
  );

  if (!confirmed) return;

  if (stagedMode) {
    const marker = `bgp:network:${network}`;
    pendingOperations.push({
      type: 'bgp',
      action: 'delete',
      data: { bgpType: 'network', network },
      display: `Delete BGP network ${network}`
    });
    pendingRuleMarkers.add(marker);
    updatePendingIndicator();
    loadBGP();
    showToast('info', 'Staged', `Network deletion queued`);
    logActivity('bgp', 'staged', `Network ${network}`, 'staged', `Network staged for deletion`);
    return;
  }

  showLoading('Deleting BGP network...');

  try {
    const res = await fetch('/api/bgp/network', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ network })
    });
    const j = await res.json();

    if (!res.ok) throw new Error(j.error || 'Failed to delete network');

    hasUnsavedChanges = true;
    updateSaveIndicator();
    await loadBGP();
    showToast('success', 'Success', `BGP network ${network} removed`);
    logActivity('bgp', 'delete', `Network ${network}`, 'success', `Removed BGP network ${network}`, [
      { cmd: `delete protocols bgp address-family ipv4-unicast network ${network}` }
    ]);
  } catch (e) {
    logActivity('bgp', 'delete', `Network ${network}`, 'error', e.message);
    showToast('error', 'Error', e.message);
    loadBGP();
  }
}

// =========================================
// FIREWALL
// =========================================
async function loadFirewall() {
  content.innerHTML = showSkeletonTable(6, 4);

  try {
    const res = await fetch('/api/firewall/rulesets');
    const sets = await res.json();

    if (sets.length === 0) {
      content.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h2 class="empty-state-title">No Firewall Rulesets</h2>
          <p class="empty-state-text">No firewall rulesets found in this configuration.</p>
        </div>`;
      return;
    }

    content.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            Firewall Rulesets
            <span class="badge">${sets.length}</span>
          </div>
        </div>
        <div class="card-body">
          <div class="flex flex-wrap gap-2">
            ${sets.map(rs => `
              <button class="btn btn-secondary" onclick="viewRuleset('${rs}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
                ${rs}
              </button>
            `).join('')}
          </div>
        </div>
      </div>`;
  } catch (e) {
    showToast('error', 'Error', 'Failed to load firewall rulesets');
  }
}

// Bounded-concurrency map. Avoids slamming the backend with hundreds of
// parallel fetches on big rulesets (caused 502s from the upstream accept
// queue filling up).
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function viewRuleset(rs) {
  content.innerHTML = showSkeletonTable(10, 8);
  updateBreadcrumb([
    { label: 'Firewall', action: "loadSection('Firewall')" },
    { label: rs, action: `viewRuleset('${rs}')` }
  ]);

  try {
    const res = await fetch(`/api/firewall/ruleset/${rs}`);
    const js = await res.json();

    currentRulesetName = rs;
    currentRulesetData = js.rule || {};

    // Preload groups
    const refs = new Set();
    Object.values(currentRulesetData).forEach(r => {
      ['source', 'destination'].forEach(side => {
        const g = r[side]?.group;
        if (!g) return;
        if (g['address-group']) {
          let name = g['address-group'];
          if (name.startsWith('!')) name = name.slice(1);
          refs.add(`address|${name}`);
        }
        if (g['network-group']) {
          let name = g['network-group'];
          if (name.startsWith('!')) name = name.slice(1);
          refs.add(`network|${name}`);
        }
        if (g['port-group']) {
          refs.add(`port|${g['port-group']}`);
        }
      });
    });

    groupCache = {};
    await mapWithLimit([...refs], 8, async ref => {
      const [type, name] = ref.split('|');
      const key = `${type}-${name}`;
      const r = await fetch(`/api/firewall/group/${type}/${name}`);
      const obj = await r.json();
      if (type === 'address') groupCache[key] = obj.address;
      if (type === 'network') groupCache[key] = obj.network;
      if (type === 'port') groupCache[key] = obj.port;
    });

    filters = {};
    ipFilters = { source: null, destination: null };
    showResolved = false;

    renderRuleset();
  } catch (e) {
    showToast('error', 'Error', 'Failed to load ruleset');
  }
}

function renderRuleset() {
  const ruleCount = Object.keys(currentRulesetData).length;
  const hasActiveFilters = Object.keys(filters).length > 0 || ipFilters.source || ipFilters.destination;

  const cols = [
    { id: 'rule_id', label: 'ID', width: '70px' },
    { id: 'source', label: 'Source' },
    { id: 'src_port', label: 'Src Port', width: '120px' },
    { id: 'destination', label: 'Destination' },
    { id: 'dst_port', label: 'Dst Port', width: '120px' },
    { id: 'protocol', label: 'Proto', width: '90px' },
    { id: 'action', label: 'Action', width: '100px' },
    { id: 'description', label: 'Description' }
  ];

  let html = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          ${currentRulesetName}
          <span class="badge">${ruleCount} rules</span>
        </div>
        <div class="flex gap-2">
          ${isConnected ? `<button class="btn btn-success btn-sm" onclick="openFirewallRuleModal('create', '${currentRulesetName}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New Rule
          </button>` : ''}
          ${hasActiveFilters ? `<button class="btn btn-ghost btn-sm" onclick="clearAllFilters()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            Clear
          </button>` : ''}
          <button class="btn btn-secondary btn-sm" id="toggleBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${showResolved ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>' : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'}
            </svg>
            ${showResolved ? 'Show Groups' : 'Show Values'}
          </button>
          <button class="btn btn-primary btn-sm" id="searchBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            Search Traffic
          </button>
        </div>
      </div>
      <div id="searchResult"></div>
      <div class="table-container">
        <table>
          <thead><tr>`;

  cols.forEach(c => {
    const isIP = (c.id === 'source' || c.id === 'destination');
    const currentVal = isIP
      ? (ipFilters[c.id] ? formatIPFilter(ipFilters[c.id]) : '')
      : (filters[c.id] || '');
    const hasValue = currentVal !== '';
    const widthStyle = c.width ? `style="width:${c.width}"` : '';

    html += `<th class="col-${c.id}" ${widthStyle}>
      <div class="flex flex-col gap-1">
        <span>${c.label}</span>
        <input
          type="text"
          class="filter-input ${hasValue ? 'has-value' : ''}"
          placeholder="Filter..."
          value="${escapeHtml(currentVal)}"
          onchange="handleFilterChange('${c.id}', this.value)"
          onkeydown="if(event.key==='Enter') this.blur()"
        />
      </div>
    </th>`;
  });

  // Add Actions column header if connected
  if (isConnected) {
    html += `<th class="actions-col">Actions</th>`;
  }

  html += `</tr></thead><tbody>`;

  let visibleCount = 0;
  Object.entries(currentRulesetData)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
    .forEach(([id, r]) => {
      if (ipFilters.source && !matchIP(r.source, ipFilters.source)) return;
      if (ipFilters.destination && !matchIP(r.destination, ipFilters.destination)) return;

      const row = {
        rule_id: id,
        source: entityText(r.source, 'address', 'network'),
        src_port: portText(r.source),
        destination: entityText(r.destination, 'address', 'network'),
        dst_port: portText(r.destination),
        protocol: r.protocol || '-',
        action: r.action,
        description: r.description || '-'
      };

      for (let k in filters) {
        if (k === 'src_port' || k === 'dst_port') {
          const spec = filters[k];
          const side = k === 'src_port' ? r.source : r.destination;
          if (!matchPort(side, spec)) return;
        } else {
          if (!row[k].toLowerCase().includes(filters[k].toLowerCase())) return;
        }
      }

      visibleCount++;
      const actionClass = row.action?.toLowerCase() || '';

      // Check if this rule has pending changes
      const pendingStatus = getPendingStatus('firewall', currentRulesetName, id);
      const pendingClass = pendingStatus === 'delete' ? 'pending-delete' : (pendingStatus ? 'pending-change' : '');
      const pendingBadge = pendingStatus ? `<span class="pending-badge">${pendingStatus === 'delete' ? 'DEL' : 'MOD'}</span>` : '';

      html += `<tr id="row-${id}" class="${pendingClass}">
        <td><span class="badge">${row.rule_id}</span>${pendingBadge}</td>
        <td><div class="cell-wrap wide">${cellHTML(r.source, 'address', 'network')}</div></td>
        <td class="font-mono text-sm"><div class="cell-wrap">${cellHTML(r.source, 'port')}</div></td>
        <td><div class="cell-wrap wide">${cellHTML(r.destination, 'address', 'network')}</div></td>
        <td class="font-mono text-sm"><div class="cell-wrap">${cellHTML(r.destination, 'port')}</div></td>
        <td><span class="badge">${row.protocol}</span></td>
        <td><span class="action-badge ${actionClass}">${row.action}</span></td>
        <td class="text-muted"><div class="cell-wrap wide">${escapeHtml(row.description)}</div></td>
        ${isConnected ? `<td class="actions-col">
          <button class="btn-icon" onclick="openFirewallRuleModal('edit', '${currentRulesetName}', '${id}')" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="btn-icon btn-danger" onclick="deleteFirewallRule('${currentRulesetName}', '${id}')" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </td>` : ''}
      </tr>`;
    });

  if (visibleCount === 0) {
    html += `<tr><td colspan="${cols.length + (isConnected ? 1 : 0)}" class="text-center text-muted" style="padding: 2rem;">No rules match the current filters</td></tr>`;
  }

  html += `</tbody></table></div></div>`;
  content.innerHTML = html;

  document.getElementById('toggleBtn').onclick = () => {
    showResolved = !showResolved;
    renderRuleset();
  };
  document.getElementById('searchBtn').onclick = openSearchModal;
}

function clearAllFilters() {
  filters = {};
  ipFilters = { source: null, destination: null };
  renderRuleset();
}

// =========================================
// FILTER HANDLING
// =========================================
function handleFilterChange(field, val) {
  val = val.trim();
  if (field === 'source' || field === 'destination') {
    delete filters[field];
    ipFilters[field] = val ? parseIPInput(val) : null;
  } else {
    if (val) filters[field] = val;
    else delete filters[field];
  }
  renderRuleset();
}

// =========================================
// IP UTILITIES
// =========================================
function parseIPInput(v) {
  let [ip, mask] = v.split('/');
  mask = mask ? parseInt(mask) : 32;
  const [net, mlen] = parseCIDR(`${ip}/${mask}`);
  return { ip: ipToInt(ip), net, mask: mlen };
}

function formatIPFilter(info) {
  if (!info) return '';
  const o1 = (info.ip >>> 24) & 255, o2 = (info.ip >>> 16) & 255, o3 = (info.ip >>> 8) & 255, o4 = info.ip & 255;
  return `${o1}.${o2}.${o3}.${o4}/${info.mask}`;
}

function parseCIDR(c) {
  const [ip, maskStr] = c.split('/');
  const mask = parseInt(maskStr);
  const ipn = ipToInt(ip);
  const maskBits = mask === 0 ? 0 : (~((1 << (32 - mask)) - 1) >>> 0);
  return [ipn & maskBits, mask];
}

function ipToInt(ip) {
  return ip.split('.').reduce((a, b) => a * 256 + parseInt(b), 0);
}

function ipInSpec(ipn, spec) {
  if (spec.includes(',')) {
    return spec.split(',').some(s => ipInSpec(ipn, s.trim()));
  }
  if (spec.includes('/')) {
    const [net, mask] = parseCIDR(spec);
    const maskBits = mask === 0 ? 0 : (~((1 << (32 - mask)) - 1) >>> 0);
    return (ipn & maskBits) === net;
  }
  if (spec.includes('-')) {
    const [a, b] = spec.split('-').map(ipToInt);
    return ipn >= a && ipn <= b;
  }
  return ipn === ipToInt(spec);
}

// Nueva funcion: Verifica si una especificacion de regla se solapa con un filtro CIDR
function specOverlapsFilter(spec, filterInfo) {
  // Si spec es una lista, verificar si algun elemento se solapa
  if (spec.includes(',')) {
    return spec.split(',').some(s => specOverlapsFilter(s.trim(), filterInfo));
  }

  // Calcular el rango del filtro [filterStart, filterEnd]
  const filterStart = filterInfo.net;
  const filterSize = filterInfo.mask === 32 ? 1 : (1 << (32 - filterInfo.mask));
  const filterEnd = filterStart + filterSize - 1;

  // Si spec es un CIDR
  if (spec.includes('/')) {
    const [net, mask] = parseCIDR(spec);
    const specSize = mask === 32 ? 1 : (1 << (32 - mask));
    const specStart = net;
    const specEnd = specStart + specSize - 1;

    // Verificar si los rangos se solapan
    return specStart <= filterEnd && specEnd >= filterStart;
  }

  // Si spec es un rango (a-b)
  if (spec.includes('-')) {
    const [a, b] = spec.split('-').map(ipToInt);
    return a <= filterEnd && b >= filterStart;
  }

  // Si spec es una IP simple, verificar si esta dentro del rango del filtro
  const ipn = ipToInt(spec);
  return ipn >= filterStart && ipn <= filterEnd;
}

// =========================================
// TEXT AND CELL RENDERING
// =========================================
function entityText(obj, aKey, nKey) {
  if (!obj) return '-';
  if (obj.group) {
    const type = obj.group['address-group'] ? aKey : nKey;
    let name = obj.group[`${type}-group`];
    if (!name) return '-';
    const neg = name.startsWith('!');
    if (neg) name = name.slice(1);
    const key = `${type}-${name}`;
    const vals = groupCache[key];
    if (showResolved) {
      const txt = Array.isArray(vals) ? vals.join(', ') : String(vals);
      return neg ? `!(${txt})` : txt;
    }
    return obj.group[`${type}-group`];
  }
  return obj.address || '-';
}

function portText(obj) {
  if (!obj) return '-';
  if (obj.group && obj.group['port-group']) {
    const n = obj.group['port-group'];
    return showResolved
      ? (Array.isArray(groupCache[`port-${n}`]) ? groupCache[`port-${n}`].join(', ') : groupCache[`port-${n}`])
      : n;
  }
  if (obj.port) return Array.isArray(obj.port) ? obj.port.join(', ') : String(obj.port);
  return '-';
}

function cellHTML(obj, aKey, nKey) {
  if (!obj) return '-';
  if (arguments.length === 3) {
    if (obj.group) {
      const type = obj.group['address-group'] ? aKey : nKey;
      const name = obj.group[`${type}-group`];
      if (!name) return '-';
      return showResolved
        ? `<span class="font-mono text-sm">${escapeHtml(entityText(obj, aKey, nKey))}</span>`
        : `<a href="#" class="font-mono text-sm" onclick="showGroup('${type}','${name}');return false;">${escapeHtml(name)}</a>`;
    }
    return obj.address ? `<span class="font-mono text-sm">${escapeHtml(obj.address)}</span>` : '-';
  }
  if (obj.group && obj.group['port-group']) {
    const name = obj.group['port-group'];
    return showResolved
      ? portText(obj)
      : `<a href="#" onclick="showGroup('port','${name}');return false;">${escapeHtml(name)}</a>`;
  }
  if (obj.port) return portText(obj);
  return '-';
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// =========================================
// TRAFFIC SEARCH
// =========================================
function openSearchModal() {
  const html = `
    <div class="modal" id="searchModal">
      <div class="modal-backdrop" onclick="closeModal('searchModal')"></div>
      <div class="modal-content modal-md">
        <div class="modal-header">
          <h3>Search Traffic</h3>
          <button class="modal-close" onclick="closeModal('searchModal')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="search-traffic-form">
            <div class="search-traffic-section">
              <div class="search-traffic-section-title">Source</div>
              <div class="search-traffic-row">
                <div class="modal-form-group">
                  <label class="modal-form-label">IP Address</label>
                  <input type="text" id="s_ip" placeholder="10.0.0.5/32 or 10.0.0.0/24" />
                </div>
                <div class="modal-form-group">
                  <label class="modal-form-label">Port</label>
                  <input type="text" id="s_port" placeholder="any" />
                </div>
              </div>
            </div>
            <div class="search-traffic-section">
              <div class="search-traffic-section-title">Destination</div>
              <div class="search-traffic-row">
                <div class="modal-form-group">
                  <label class="modal-form-label">IP Address</label>
                  <input type="text" id="d_ip" placeholder="10.0.0.10/32" />
                </div>
                <div class="modal-form-group">
                  <label class="modal-form-label">Port</label>
                  <input type="text" id="d_port" placeholder="443" />
                </div>
              </div>
            </div>
            <div class="modal-form-group">
              <label class="modal-form-label">Protocol</label>
              <input type="text" id="proto" placeholder="tcp, udp, icmp, or any" />
            </div>
          </div>
          <div id="searchResultInModal"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('searchModal')">Cancel</button>
          <button class="btn btn-primary" id="execSearch">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            Search
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('execSearch').onclick = executeSearch;
  document.getElementById('s_ip').focus();

  // Enter key to search
  document.querySelectorAll('#searchModal input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') executeSearch();
    });
  });
}

function executeSearch() {
  const sip = document.getElementById('s_ip').value.trim() || 'any';
  const dip = document.getElementById('d_ip').value.trim() || 'any';
  const sp = document.getElementById('s_port').value.trim() || 'any';
  const dp = document.getElementById('d_port').value.trim() || 'any';
  let proto = document.getElementById('proto').value.trim().toLowerCase() || 'any';
  if (!['any', 'tcp', 'udp', 'icmp'].includes(proto)) proto = 'any';

  const matchId = findMatchingRule({ srcIP: sip, dstIP: dip, srcPort: sp, dstPort: dp, protocol: proto });
  const resultDiv = document.getElementById('searchResultInModal');

  if (!matchId) {
    resultDiv.innerHTML = `
      <div class="search-result not-found">
        <div class="search-result-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>
        <div class="search-result-content">
          <div class="search-result-title">No matching rule found</div>
          <div class="search-result-subtitle">Traffic would be handled by default policy</div>
        </div>
      </div>`;
    return;
  }

  const rule = currentRulesetData[matchId];
  resultDiv.innerHTML = `
    <div class="search-result found">
      <div class="search-result-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
      </div>
      <div class="search-result-content">
        <div class="search-result-title">Match: Rule ${matchId}</div>
        <div class="search-result-subtitle">Action: ${rule.action} ${rule.description ? '- ' + rule.description : ''}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="gotoRule('${matchId}');closeModal('searchModal')">
        Go to Rule
      </button>
    </div>`;
}

function gotoRule(id) {
  document.querySelectorAll('tr').forEach(r => r.classList.remove('highlight'));
  const row = document.getElementById(`row-${id}`);
  if (row) {
    row.classList.add('highlight');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// =========================================
// MATCHERS
// =========================================
function findMatchingRule(c) {
  const s = c.srcIP === 'any' ? null : parseIPInput(c.srcIP);
  const d = c.dstIP === 'any' ? null : parseIPInput(c.dstIP);
  for (const [id, r] of Object.entries(currentRulesetData).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    if (matchRule(r, s, d, c.srcPort, c.dstPort, c.protocol)) {
      return id;
    }
  }
  return null;
}

function matchRule(r, sip, dip, sp, dp, pr) {
  return matchIP(r.source, sip) &&
    matchIP(r.destination, dip) &&
    matchPort(r.source, sp) &&
    matchPort(r.destination, dp) &&
    matchProtocol(r.protocol, pr);
}

function matchIP(obj, info) {
  if (!info || !obj) return true;

  if (obj.group) {
    if (obj.group['address-group']) {
      let name = obj.group['address-group'];
      const neg = name.startsWith('!');
      if (neg) name = name.slice(1);
      const list = wrap(groupCache[`address-${name}`]);
      const hit = list.some(spec => specOverlapsFilter(spec, info));
      return neg ? !hit : hit;
    }
    if (obj.group['network-group']) {
      let name = obj.group['network-group'];
      const neg = name.startsWith('!');
      if (neg) name = name.slice(1);
      const list = wrap(groupCache[`network-${name}`]);
      const hit = list.some(spec => specOverlapsFilter(spec, info));
      return neg ? !hit : hit;
    }
  }

  if (obj.address) {
    return specOverlapsFilter(obj.address, info);
  }

  return true;
}

function wrap(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function portInSpec(pin, spec) {
  spec = String(spec).trim();
  if (spec.includes(',')) {
    return spec.split(',').some(p => portInSpec(pin, p.trim()));
  }
  if (spec.includes('-')) {
    const [a, b] = spec.split('-').map(Number);
    return pin >= a && pin <= b;
  }
  return pin === Number(spec);
}

function matchPort(obj, portIn) {
  if (portIn === 'any') return true;
  if (!obj) return false;

  const pin = parseInt(portIn, 10);
  let specs = [];

  if (obj.group && obj.group['port-group']) {
    specs.push(...wrap(groupCache[`port-${obj.group['port-group']}`] || []));
  } else if (obj.port) {
    specs.push(...wrap(obj.port));
  }

  if (!specs.length) return false;
  return specs.some(s => portInSpec(pin, s));
}

function matchProtocol(ruleProto, searchProto) {
  if (!searchProto || searchProto === 'any') return true;
  if (!ruleProto || ruleProto === 'any' || ruleProto === 'all') return true;

  const rp = ruleProto.toLowerCase();
  const sp = searchProto.toLowerCase();

  if (rp.includes('_')) {
    return rp.split('_').includes(sp);
  }
  return rp === sp;
}

// =========================================
// GROUP MODAL
// =========================================
async function showGroup(type, name) {
  const realName = name.startsWith('!') ? name.slice(1) : name;

  try {
    const res = await fetch(`/api/firewall/group/${type}/${realName}`);
    const grp = await res.json();

    let list;
    if (type === 'address') list = grp.address;
    if (type === 'network') list = grp.network;
    if (type === 'port') list = grp.port;

    const items = Array.isArray(list) ? list : [list];

    const html = `
      <div class="modal" id="groupModal">
        <div class="modal-backdrop" onclick="closeModal('groupModal')"></div>
        <div class="modal-content modal-sm">
          <div class="modal-header">
            <h3>${escapeHtml(name)}</h3>
            <button class="modal-close" onclick="closeModal('groupModal')">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="badge mb-4">${type}-group</div>
            <ul class="group-details-list">
              ${items.map(i => `<li>${escapeHtml(i ?? '-')}</li>`).join('')}
            </ul>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="closeModal('groupModal')">Close</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (e) {
    showToast('error', 'Error', 'Failed to load group details');
  }
}

// =========================================
// CONNECTION MODAL (API REST)
// =========================================
document.getElementById('fetchBtn').onclick = openFetchModal;

async function openFetchModal() {
  const defaults = (await loadServerDefaults()).vyos || {};
  const defaultPort = defaults.port || 8443;
  const defaultApiKey = defaults.api_key || '';
  const html = `
    <div class="modal" id="fetchModal">
      <div class="modal-backdrop" onclick="closeModal('fetchModal')"></div>
      <div class="modal-content modal-md">
        <div class="modal-header">
          <h3>Connect to VyOS Router (API REST)</h3>
          <button class="modal-close" onclick="closeModal('fetchModal')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="modal-alert info" style="margin-bottom: 1rem;">
            <div class="modal-alert-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </div>
            <div class="modal-alert-content">
              <div class="modal-alert-title">VyOS API Required</div>
              <div class="modal-alert-message">The router must have HTTPS API enabled with an API key configured.</div>
            </div>
          </div>
          <div class="connection-form">
            <div class="modal-form-row">
              <div class="modal-form-group">
                <label class="modal-form-label">Host / FQDN <span class="required">*</span></label>
                <input type="text" id="fw_host" placeholder="10.0.0.1 or router.example.com" />
              </div>
              <div class="modal-form-group">
                <label class="modal-form-label">HTTPS Port</label>
                <input type="text" id="fw_port" placeholder="8443" value="${defaultPort}" />
              </div>
            </div>
            <div class="modal-form-group">
              <label class="modal-form-label">API Key <span class="required">*</span></label>
              <input type="password" id="fw_api_key" placeholder="Your VyOS API key" value="${defaultApiKey.replace(/"/g, '&quot;')}" />
              <span class="modal-form-hint">Precargado desde la configuracion del servidor; sobreescribe si necesitas otra.</span>
            </div>
          </div>
          <div id="fetchStatus"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('fetchModal')">Cancel</button>
          <button class="btn btn-primary" id="doFetch">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>
            </svg>
            Connect
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('doFetch').onclick = doFetchConfig;
  document.getElementById('fw_host').focus();

  // Enter key to connect
  document.querySelectorAll('#fetchModal input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') doFetchConfig();
    });
  });
}

async function doFetchConfig() {
  const host = document.getElementById('fw_host').value.trim();
  const port = parseInt(document.getElementById('fw_port').value, 10) || 8443;
  const apiKey = document.getElementById('fw_api_key').value;
  const statusDiv = document.getElementById('fetchStatus');
  const btn = document.getElementById('doFetch');

  if (!host) {
    statusDiv.innerHTML = `
      <div class="modal-alert error">
        <div class="modal-alert-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>
        <div class="modal-alert-content">
          <div class="modal-alert-title">Host is required</div>
        </div>
      </div>`;
    return;
  }

  if (!apiKey) {
    statusDiv.innerHTML = `
      <div class="modal-alert error">
        <div class="modal-alert-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>
        <div class="modal-alert-content">
          <div class="modal-alert-title">API Key is required</div>
        </div>
      </div>`;
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<div class="loading-spinner"></div> Connecting...';
  statusDiv.innerHTML = `
    <div class="connection-status-indicator connecting">
      <div class="loading-spinner"></div>
      Connecting to ${host}...
    </div>`;

  try {
    const res = await fetch('/fetch-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, api_key: apiKey })
    });
    const j = await res.json();

    if (!res.ok) throw new Error(j.error || 'Unknown error');

    CONFIG = j.data;
    closeModal('fetchModal');
    updateConnectionStatus(true, host);
    // Show Save button, Verbose toggle, and Staged toggle when connected
    document.getElementById('saveConfigBtn')?.classList.remove('hidden');
    document.getElementById('verboseToggle')?.classList.remove('hidden');
    document.getElementById('stagedToggle')?.classList.remove('hidden');
    document.getElementById('verboseDivider')?.classList.remove('hidden');
    drawMenu();
    renderDashboard();
    showToast('success', 'Connected', `Successfully fetched config from ${host}`);
    logActivity('connection', 'connect', host, 'success', `Connected to VyOS router at ${host}:${port}`);

    // Cluster detection: if primary is part of an HA cluster, try to auto-connect the peer
    clusterInfo = j.cluster_info || null;
    if (clusterInfo?.detected) {
      updateClusterBadge('detected', clusterInfo);
      autoConnectPeer();  // fire and forget (toasts on result)
    } else {
      updateClusterBadge(null);
    }
  } catch (e) {
    logActivity('connection', 'connect', host, 'error', `Connection failed: ${e.message}`);
    statusDiv.innerHTML = `
      <div class="modal-alert error">
        <div class="modal-alert-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>
        <div class="modal-alert-content">
          <div class="modal-alert-title">Connection Failed</div>
          <div class="modal-alert-message">${escapeHtml(e.message)}</div>
        </div>
      </div>`;
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>
      </svg>
      Connect`;
  }
}

// =========================================
// CLOSE MODAL
// =========================================
// Static modals that should NOT be removed from DOM
const STATIC_MODALS = ['shortcutsModal', 'confirmModal', 'firewallRuleModal', 'natRuleModal', 'commandPreviewModal', 'groupEditModal'];

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('hidden');
    // Only remove dynamically created modals, not static HTML ones
    if (!STATIC_MODALS.includes(id)) {
      setTimeout(() => modal.remove(), 200);
    }
  }
}

// Close any modal
function closeAnyModal() {
  document.querySelectorAll('.modal:not(.hidden)').forEach(modal => {
    modal.classList.add('hidden');
    // Only remove dynamically created modals
    if (!STATIC_MODALS.includes(modal.id)) {
      setTimeout(() => modal.remove(), 200);
    }
  });
}

// =========================================
// DASHBOARD
// =========================================
function renderDashboard() {
  if (!CONFIG) return;

  currentSection = 'Dashboard';
  currentRulesetName = null;
  drawMenu();
  updateBreadcrumb([]);

  // Collect statistics
  const fwRulesets = CONFIG.firewall?.name || {};
  let totalFwRules = 0;
  const fwStats = {};

  for (const [name, data] of Object.entries(fwRulesets)) {
    const count = data?.rule ? Object.keys(data.rule).length : 0;
    fwStats[name] = count;
    totalFwRules += count;
  }

  let snatCount = 0;
  let dnatCount = 0;
  if (CONFIG.nat) {
    snatCount = Object.keys(CONFIG.nat.source?.rule || {}).length;
    dnatCount = Object.keys(CONFIG.nat.destination?.rule || {}).length;
  }

  // Groups counts
  const groups = CONFIG.firewall?.group || {};
  const addressGroups = Object.keys(groups['address-group'] || {}).length;
  const networkGroups = Object.keys(groups['network-group'] || {}).length;
  const portGroups = Object.keys(groups['port-group'] || {}).length;
  const totalGroups = addressGroups + networkGroups + portGroups;

  // Interfaces count
  let interfaceCount = 0;
  for (const itype of Object.values(CONFIG.interfaces || {})) {
    if (typeof itype === 'object') interfaceCount += Object.keys(itype).length;
  }

  // Routes count
  const staticRoutes = Object.keys(CONFIG.protocols?.static?.route || {}).length;

  // BGP stats
  const bgp = CONFIG.protocols?.bgp || {};
  const bgpNeighbors = Object.keys(bgp.neighbor || {}).length;
  const bgpNetworks = Object.keys(bgp['address-family']?.['ipv4-unicast']?.network || {}).length;
  const systemAs = bgp['system-as'] || null;

  // Hostname
  const hostname = CONFIG.system?.['host-name'] || 'VyOS Router';

  const hasFwData = Object.keys(fwStats).length > 0;
  const hasNatData = snatCount > 0 || dnatCount > 0;

  const html = `
    <div class="dashboard-header" style="margin-bottom: 1.5rem; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0;">${escapeHtml(hostname)}</h2>
        <p class="text-muted" style="margin: 0.25rem 0 0 0;">Configuration Overview</p>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="openGlobalSearch()" title="Global Search (/)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        Search
      </button>
    </div>

    <div class="dashboard-cards-grid">
      <div class="dashboard-card clickable" onclick="loadSection('Firewall')">
        <div class="dashboard-card-icon" style="background-color: var(--accent-light, #dbeafe); color: var(--accent-color);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <div class="dashboard-card-content">
          <div class="dashboard-card-value">${Object.keys(fwStats).length}</div>
          <div class="dashboard-card-label">Firewall Rulesets</div>
          <div class="dashboard-card-sub">${totalFwRules} total rules</div>
        </div>
      </div>

      <div class="dashboard-card clickable" onclick="loadSection('NAT')">
        <div class="dashboard-card-icon" style="background-color: var(--warning-light); color: var(--warning-color);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
            <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
          </svg>
        </div>
        <div class="dashboard-card-content">
          <div class="dashboard-card-value">${snatCount + dnatCount}</div>
          <div class="dashboard-card-label">NAT Rules</div>
          <div class="dashboard-card-sub">${dnatCount} DNAT, ${snatCount} SNAT</div>
        </div>
      </div>

      <div class="dashboard-card clickable" onclick="loadSection('Groups')">
        <div class="dashboard-card-icon" style="background-color: var(--success-light); color: var(--success-color);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <div class="dashboard-card-content">
          <div class="dashboard-card-value">${totalGroups}</div>
          <div class="dashboard-card-label">Firewall Groups</div>
          <div class="dashboard-card-sub">${addressGroups} addr, ${networkGroups} net, ${portGroups} port</div>
        </div>
      </div>

      <div class="dashboard-card clickable" onclick="loadSection('Interfaces')">
        <div class="dashboard-card-icon" style="background-color: #fce7f3; color: #db2777;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
            <line x1="6" y1="6" x2="6.01" y2="6"/>
            <line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
        </div>
        <div class="dashboard-card-content">
          <div class="dashboard-card-value">${interfaceCount}</div>
          <div class="dashboard-card-label">Interfaces</div>
          <div class="dashboard-card-sub">Configured interfaces</div>
        </div>
      </div>

      <div class="dashboard-card clickable" onclick="loadSection('Routes')">
        <div class="dashboard-card-icon" style="background-color: #e0e7ff; color: #4f46e5;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
        </div>
        <div class="dashboard-card-content">
          <div class="dashboard-card-value">${staticRoutes}</div>
          <div class="dashboard-card-label">Static Routes</div>
          <div class="dashboard-card-sub">Configured routes</div>
        </div>
      </div>

      <div class="dashboard-card clickable" onclick="loadSection('BGP')">
        <div class="dashboard-card-icon" style="background-color: #ccfbf1; color: #0d9488;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="5" r="3"/>
            <circle cx="5" cy="19" r="3"/>
            <circle cx="19" cy="19" r="3"/>
            <line x1="12" y1="8" x2="5" y2="16"/>
            <line x1="12" y1="8" x2="19" y2="16"/>
          </svg>
        </div>
        <div class="dashboard-card-content">
          <div class="dashboard-card-value">${bgpNeighbors}</div>
          <div class="dashboard-card-label">BGP Neighbors</div>
          <div class="dashboard-card-sub">${systemAs ? `AS ${systemAs}` : 'Not configured'}${bgpNetworks > 0 ? `, ${bgpNetworks} networks` : ''}</div>
        </div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="chart-container">
        <h3>Firewall Rules per Ruleset</h3>
        ${hasFwData ? '<canvas id="fwChart"></canvas>' : '<p class="text-center text-muted" style="margin-top:3rem">No firewall rules found</p>'}
      </div>
      <div class="chart-container">
        <h3>NAT Rules Distribution</h3>
        ${hasNatData ? '<canvas id="natChart"></canvas>' : '<p class="text-center text-muted" style="margin-top:3rem">No NAT rules found</p>'}
      </div>
    </div>
  `;
  content.innerHTML = html;

  // Theme colors for charts
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const isRetro = document.documentElement.getAttribute('data-theme') === 'retro';
  const textColor = isRetro ? '#00ff41' : (isDark ? '#f1f5f9' : '#0f172a');
  const gridColor = isRetro ? '#003300' : (isDark ? '#334155' : '#e2e8f0');
  const barColor = isRetro ? '#00ff41' : '#3b82f6';

  if (hasFwData) {
    new Chart(document.getElementById('fwChart'), {
      type: 'bar',
      data: {
        labels: Object.keys(fwStats),
        datasets: [{
          label: 'Rules',
          data: Object.values(fwStats),
          backgroundColor: barColor,
          borderColor: barColor,
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: gridColor },
            ticks: { color: textColor }
          },
          x: {
            grid: { display: false },
            ticks: { color: textColor }
          }
        }
      }
    });
  }

  if (hasNatData) {
    new Chart(document.getElementById('natChart'), {
      type: 'doughnut',
      data: {
        labels: ['Source NAT', 'Destination NAT'],
        datasets: [{
          data: [snatCount, dnatCount],
          backgroundColor: isRetro ? ['#00ff41', '#008f11'] : ['#10b981', '#f59e0b'],
          borderColor: isRetro ? '#000' : (isDark ? '#1e293b' : '#fff'),
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: textColor, padding: 20 }
          }
        }
      }
    });
  }
}

// =========================================
// CRUD HELPERS
// =========================================
function updateSaveIndicator() {
  const dot = document.getElementById('unsavedDot');
  if (dot) dot.classList.toggle('hidden', !hasUnsavedChanges);
}

// =========================================
// DIFFERENTIAL UPDATE HELPERS
// =========================================

/**
 * Deep clone an object (for storing original state)
 */
function deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Compare two values for equality (handles nested objects)
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }

  return true;
}

/**
 * Get differential changes between original and modified rule
 * Returns: { sets: [{path, value}], deletes: [path] }
 */
function getRuleDiff(original, modified, basePath = []) {
  const result = { sets: [], deletes: [] };

  if (!original && !modified) return result;

  // If original is null/undefined, everything in modified is new
  if (!original) {
    flattenToSets(modified, basePath, result.sets);
    return result;
  }

  // If modified is null/undefined, everything in original should be deleted
  if (!modified) {
    result.deletes.push([...basePath]);
    return result;
  }

  // Compare each field
  const allKeys = new Set([...Object.keys(original), ...Object.keys(modified)]);

  for (const key of allKeys) {
    const origVal = original[key];
    const modVal = modified[key];
    const currentPath = [...basePath, key];

    // Field removed
    if (modVal === undefined && origVal !== undefined) {
      result.deletes.push(currentPath);
      continue;
    }

    // Field added or changed
    if (origVal === undefined && modVal !== undefined) {
      if (typeof modVal === 'object' && modVal !== null) {
        flattenToSets(modVal, currentPath, result.sets);
      } else {
        result.sets.push({ path: currentPath, value: modVal });
      }
      continue;
    }

    // Both exist - check for changes
    if (!deepEqual(origVal, modVal)) {
      if (typeof modVal === 'object' && modVal !== null && typeof origVal === 'object' && origVal !== null) {
        // Recurse into nested objects
        const nested = getRuleDiff(origVal, modVal, currentPath);
        result.sets.push(...nested.sets);
        result.deletes.push(...nested.deletes);
      } else {
        // Primitive value changed
        if (typeof modVal === 'object' && modVal !== null) {
          flattenToSets(modVal, currentPath, result.sets);
        } else {
          result.sets.push({ path: currentPath, value: modVal });
        }
      }
    }
  }

  return result;
}

/**
 * Flatten an object into set operations
 */
function flattenToSets(obj, basePath, sets) {
  if (obj === null || obj === undefined) return;

  if (typeof obj !== 'object') {
    sets.push({ path: basePath, value: obj });
    return;
  }

  for (const [key, val] of Object.entries(obj)) {
    const currentPath = [...basePath, key];
    if (typeof val === 'object' && val !== null) {
      flattenToSets(val, currentPath, sets);
    } else if (val !== undefined) {
      sets.push({ path: currentPath, value: val });
    }
  }
}

/**
 * Check if this is an edit operation (has original data)
 */
function isEditMode(type) {
  if (type === 'firewall') return originalFirewallRule !== null;
  if (type === 'nat') return originalNatRule !== null;
  return false;
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('hidden');
}

function openConfirmModal(title, message) {
  return new Promise((resolve) => {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    const okBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');
    const cleanup = () => {
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      closeModal('confirmModal');
    };
    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
    openModal('confirmModal');
  });
}

function populateRulesetSelector(selectId, selectedValue = null) {
  const select = document.getElementById(selectId);
  select.innerHTML = '';
  Object.keys(CONFIG?.firewall?.name || {}).forEach(rs => {
    const opt = document.createElement('option');
    opt.value = rs;
    opt.textContent = rs;
    if (rs === selectedValue) opt.selected = true;
    select.appendChild(opt);
  });
}

// Cache of generated <option> HTML per group type, keyed by a signature of the
// group names. Avoids the O(n^2) innerHTML+= rebuild on every modal open and
// rebuilds only when the set of group names changes.
const groupSelectorCache = {
  'address-group': { sig: null, html: null },
  'network-group': { sig: null, html: null },
  'port-group':    { sig: null, html: null }
};

function populateGroupSelectors() {
  const groups = CONFIG?.firewall?.group || {};

  const htmlFor = (type) => {
    const keys = Object.keys(groups[type] || {});
    const sig = keys.join('|');
    const cache = groupSelectorCache[type];
    if (cache.sig !== sig) {
      const parts = ['<option value="">--</option>'];
      for (const g of keys) parts.push(`<option value="${g}">${g}</option>`);
      cache.sig = sig;
      cache.html = parts.join('');
    }
    return cache.html;
  };

  const addrHTML = htmlFor('address-group');
  const netHTML  = htmlFor('network-group');
  const portHTML = htmlFor('port-group');

  document.getElementById('fwRuleSrcAddrGroup').innerHTML = addrHTML;
  document.getElementById('fwRuleDstAddrGroup').innerHTML = addrHTML;
  document.getElementById('fwRuleSrcNetGroup').innerHTML  = netHTML;
  document.getElementById('fwRuleDstNetGroup').innerHTML  = netHTML;
  document.getElementById('fwRuleSrcPortGroup').innerHTML = portHTML;
  document.getElementById('fwRuleDstPortGroup').innerHTML = portHTML;
}

async function reloadConfig() {
  try {
    const res = await fetch('/api/firewall/rulesets');
    if (res.ok) {
      // Refetch full config to update local state
      const cfgRes = await fetch('/api/firewall');
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (CONFIG) CONFIG.firewall = cfg;
      }
    }
  } catch (e) {
    console.error('Error reloading config:', e);
  }
}

// =========================================
// FIREWALL CRUD
// =========================================

// Toggle jump target field visibility based on action
function toggleJumpTarget() {
  const action = document.getElementById('fwRuleAction').value;
  const jumpGroup = document.getElementById('fwJumpTargetGroup');
  if (action === 'jump') {
    jumpGroup.classList.remove('hidden');
    // Populate jump target selector with available rulesets
    populateRulesetSelector('fwRuleJumpTarget');
  } else {
    jumpGroup.classList.add('hidden');
  }
}

function openFirewallRuleModal(mode = 'create', rulesetName = null, ruleId = null) {
  if (!isConnected) {
    showToast('warning', 'Not Connected', 'Connect to the router first');
    return;
  }

  const form = document.getElementById('firewallRuleForm');
  form.reset();
  document.getElementById('fwRuleMode').value = mode;

  // Set title and reset state up-front so the modal has meaningful content
  // the moment it appears, before the heavier population work runs.
  if (mode === 'edit' && rulesetName && ruleId) {
    document.getElementById('firewallRuleTitle').textContent = `Edit Rule ${ruleId}`;
  } else {
    document.getElementById('firewallRuleTitle').textContent = 'New Firewall Rule';
    document.getElementById('fwRuleId').value = '';
  }
  document.getElementById('fwJumpTargetGroup').classList.add('hidden');
  originalFirewallRule = null;

  // Open the modal first so the user gets immediate visual feedback on click.
  // The selector population and field assignments are deferred to the next
  // animation frame, letting the browser paint the modal before doing work
  // that scales with the number of firewall groups.
  openModal('firewallRuleModal');

  requestAnimationFrame(() => {
    populateRulesetSelector('fwRuleRuleset', rulesetName || currentRulesetName);
    populateGroupSelectors();

    if (mode !== 'edit' || !rulesetName || !ruleId) return;

    const rule = CONFIG?.firewall?.name?.[rulesetName]?.rule?.[ruleId];
    if (!rule) return;

    const marker = `firewall:${rulesetName}:${ruleId}`;
    if (originalServerStates.has(marker)) {
      originalFirewallRule = deepClone(originalServerStates.get(marker));
    } else {
      originalFirewallRule = deepClone(rule);
    }

    document.getElementById('fwRuleId').value = ruleId;
    document.getElementById('fwRuleAction').value = rule.action || 'accept';
    document.getElementById('fwRuleProtocol').value = rule.protocol || '';
    document.getElementById('fwRuleDescription').value = rule.description || '';
    document.getElementById('fwRuleSrcAddress').value = rule.source?.address || '';
    document.getElementById('fwRuleSrcPort').value = rule.source?.port || '';
    document.getElementById('fwRuleDstAddress').value = rule.destination?.address || '';
    document.getElementById('fwRuleDstPort').value = rule.destination?.port || '';
    document.getElementById('fwRuleSrcAddrGroup').value = rule.source?.group?.['address-group'] || '';
    document.getElementById('fwRuleSrcNetGroup').value = rule.source?.group?.['network-group'] || '';
    document.getElementById('fwRuleSrcPortGroup').value = rule.source?.group?.['port-group'] || '';
    document.getElementById('fwRuleDstAddrGroup').value = rule.destination?.group?.['address-group'] || '';
    document.getElementById('fwRuleDstNetGroup').value = rule.destination?.group?.['network-group'] || '';
    document.getElementById('fwRuleDstPortGroup').value = rule.destination?.group?.['port-group'] || '';
    if (rule.action === 'jump' && rule['jump-target']) {
      toggleJumpTarget();
      document.getElementById('fwRuleJumpTarget').value = rule['jump-target'];
    }
  });
}

async function saveFirewallRule() {
  const ruleset = document.getElementById('fwRuleRuleset').value;
  const ruleId = document.getElementById('fwRuleId').value;

  if (!ruleset || !ruleId) {
    showToast('error', 'Validation Error', 'Ruleset and Rule ID are required');
    return;
  }

  const action = document.getElementById('fwRuleAction').value;
  const jumpTarget = document.getElementById('fwRuleJumpTarget').value;

  // Validate jump target if action is jump
  if (action === 'jump' && !jumpTarget) {
    showToast('error', 'Validation Error', 'Jump target is required when action is "jump"');
    return;
  }

  const ruleData = {
    action: action,
    protocol: document.getElementById('fwRuleProtocol').value || undefined,
    description: document.getElementById('fwRuleDescription').value || undefined,
    source: {},
    destination: {}
  };

  // Add jump-target if action is jump
  if (action === 'jump' && jumpTarget) {
    ruleData['jump-target'] = jumpTarget;
  }

  // Source
  const srcAddr = document.getElementById('fwRuleSrcAddress').value.trim();
  const srcPort = document.getElementById('fwRuleSrcPort').value.trim();
  const srcAddrGrp = document.getElementById('fwRuleSrcAddrGroup').value;
  const srcNetGrp = document.getElementById('fwRuleSrcNetGroup').value;
  const srcPortGrp = document.getElementById('fwRuleSrcPortGroup').value;
  if (srcAddr) ruleData.source.address = srcAddr;
  if (srcPort) ruleData.source.port = srcPort;
  if (srcAddrGrp || srcNetGrp || srcPortGrp) {
    ruleData.source.group = {};
    if (srcAddrGrp) ruleData.source.group['address-group'] = srcAddrGrp;
    if (srcNetGrp) ruleData.source.group['network-group'] = srcNetGrp;
    if (srcPortGrp) ruleData.source.group['port-group'] = srcPortGrp;
  }

  // Destination
  const dstAddr = document.getElementById('fwRuleDstAddress').value.trim();
  const dstPort = document.getElementById('fwRuleDstPort').value.trim();
  const dstAddrGrp = document.getElementById('fwRuleDstAddrGroup').value;
  const dstNetGrp = document.getElementById('fwRuleDstNetGroup').value;
  const dstPortGrp = document.getElementById('fwRuleDstPortGroup').value;
  if (dstAddr) ruleData.destination.address = dstAddr;
  if (dstPort) ruleData.destination.port = dstPort;
  if (dstAddrGrp || dstNetGrp || dstPortGrp) {
    ruleData.destination.group = {};
    if (dstAddrGrp) ruleData.destination.group['address-group'] = dstAddrGrp;
    if (dstNetGrp) ruleData.destination.group['network-group'] = dstNetGrp;
    if (dstPortGrp) ruleData.destination.group['port-group'] = dstPortGrp;
  }

  // Clean empty objects
  if (!Object.keys(ruleData.source).length) delete ruleData.source;
  if (!Object.keys(ruleData.destination).length) delete ruleData.destination;
  Object.keys(ruleData).forEach(k => ruleData[k] === undefined && delete ruleData[k]);

  // Check if this is an edit (differential update) or create (full write)
  const isEdit = originalFirewallRule !== null;
  let diff = null;

  if (isEdit) {
    // Compute differential changes
    diff = getRuleDiff(originalFirewallRule, ruleData);

    // If no changes from original
    if (diff.sets.length === 0 && diff.deletes.length === 0) {
      // In staged mode, check if there's a pending operation to revert
      const marker = `firewall:${ruleset}:${ruleId}`;
      if (stagedMode && pendingRuleMarkers.has(marker)) {
        // There's a pending operation - call addPendingOperation to handle revert
        const operationData = {
          type: 'firewall',
          action: 'update',
          data: { ruleset, rule_id: ruleId, rule: ruleData }
        };
        addPendingOperation(operationData);
        closeModal('firewallRuleModal');
        originalFirewallRule = null;
        return;
      }
      // No pending operation - just show "No Changes"
      showToast('info', 'No Changes', 'No changes detected');
      closeModal('firewallRuleModal');
      originalFirewallRule = null;
      return;
    }
  }

  // If staged mode is enabled, queue the operation
  if (stagedMode) {
    const operationData = {
      type: 'firewall',
      action: isEdit ? 'update' : 'create',
      data: {
        ruleset,
        rule_id: ruleId,
        rule: ruleData,
        ...(isEdit && diff ? { diff } : {})
      },
      display: `${isEdit ? 'Update' : 'Create'} firewall rule ${ruleId} in ${ruleset}`
    };
    addPendingOperation(operationData);
    closeModal('firewallRuleModal');
    originalFirewallRule = null;
    return;
  }

  // Actual execution function
  const doSave = async () => {
    closeModal('firewallRuleModal');
    // Compute commands for logging
    let commands;
    if (isEdit && diff) {
      const basePath = `firewall ipv4 name ${ruleset} rule ${ruleId}`;
      commands = buildDiffCommands(basePath, diff);
    } else {
      commands = buildFirewallCommands(ruleset, ruleId, ruleData);
    }
    const action = isEdit ? 'update' : 'create';
    const target = `Rule ${ruleId} in ${ruleset}`;

    try {
      showLoading('Applying rule...');
      const requestBody = {
        ruleset,
        rule_id: ruleId,
        rule: ruleData,
        ...(isEdit && diff ? { diff } : {})
      };
      const data = await clusterApplyFetch('/api/firewall/rule', 'POST', requestBody);

      showToast('success', 'Rule Saved', `Rule ${ruleId} saved successfully`);
      logActivity('firewall', action, target, 'success',
                  `Firewall rule ${ruleId} ${action}d successfully${clusterNodesSuffix(data)}`, commands);
      hasUnsavedChanges = true;
      updateSaveIndicator();
      await reloadConfig();
      viewRuleset(ruleset);
    } catch (e) {
      if (!e.isDivergence) showToast('error', 'Error', e.message);
      logActivity('firewall', action, target, 'error', `Failed to ${action} firewall rule: ${e.message}`, commands);
      content.innerHTML = '';
      viewRuleset(ruleset);
    } finally {
      originalFirewallRule = null;
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    // Use diff commands when editing (differential update)
    let commands;
    if (isEdit && diff) {
      const basePath = `firewall ipv4 name ${ruleset} rule ${ruleId}`;
      commands = buildDiffCommands(basePath, diff);
    } else {
      commands = buildFirewallCommands(ruleset, ruleId, ruleData);
    }
    showCommandPreview(commands, doSave);
  } else {
    await doSave();
  }
}

async function deleteFirewallRule(rulesetName, ruleId) {
  if (!isConnected) {
    showToast('warning', 'Not Connected', 'Connect to the router first');
    return;
  }

  const confirmed = await openConfirmModal('Delete Rule?', `Are you sure you want to delete rule ${ruleId} from ${rulesetName}?`);
  if (!confirmed) return;

  // If staged mode is enabled, queue the operation
  if (stagedMode) {
    addPendingOperation({
      type: 'firewall',
      action: 'delete',
      data: { ruleset: rulesetName, rule_id: ruleId },
      display: `Delete firewall rule ${ruleId} from ${rulesetName}`
    });
    return;
  }

  // Actual execution function
  const commands = buildDeleteCommand('firewall', rulesetName, ruleId);
  const target = `Rule ${ruleId} in ${rulesetName}`;

  const doDelete = async () => {
    try {
      showLoading('Deleting rule...');
      const data = await clusterApplyFetch('/api/firewall/rule', 'DELETE',
        { ruleset: rulesetName, rule_id: ruleId });

      showToast('success', 'Rule Deleted', `Rule ${ruleId} deleted successfully`);
      logActivity('firewall', 'delete', target, 'success',
                  `Firewall rule ${ruleId} deleted successfully${clusterNodesSuffix(data)}`, commands);
      hasUnsavedChanges = true;
      updateSaveIndicator();
      await reloadConfig();
      viewRuleset(rulesetName);
    } catch (e) {
      if (!e.isDivergence) showToast('error', 'Error', e.message);
      logActivity('firewall', 'delete', target, 'error', `Failed to delete firewall rule: ${e.message}`, commands);
      viewRuleset(rulesetName);
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    showCommandPreview(commands, doDelete);
  } else {
    await doDelete();
  }
}

// =========================================
// NAT CRUD
// =========================================
function toggleNatExclude() {
  const excludeChecked = document.getElementById('natRuleExclude').checked;
  const translationFieldset = document.getElementById('natTranslationFieldset');
  const transAddressLabel = document.getElementById('natTransAddressLabel');

  if (excludeChecked) {
    translationFieldset.classList.add('disabled');
    transAddressLabel.textContent = 'Address';
  } else {
    translationFieldset.classList.remove('disabled');
    transAddressLabel.textContent = 'Address *';
  }
}

function openNatRuleModal(mode = 'create', natType = 'destination', ruleId = null) {
  if (!isConnected) {
    showToast('warning', 'Not Connected', 'Connect to the router first');
    return;
  }

  const form = document.getElementById('natRuleForm');
  form.reset();
  document.getElementById('natRuleMode').value = mode;
  document.getElementById('natRuleType').value = natType;

  // Reset original rule state
  originalNatRule = null;

  if (mode === 'edit' && ruleId) {
    document.getElementById('natRuleTitle').textContent = `Edit NAT Rule ${ruleId}`;
    const rule = CONFIG?.nat?.[natType]?.rule?.[ruleId];
    if (rule) {
      // Store original rule for differential updates
      // Use original server state if available (for rules with pending changes)
      const marker = `nat:${natType}:${ruleId}`;
      if (originalServerStates.has(marker)) {
        originalNatRule = deepClone(originalServerStates.get(marker));
      } else {
        originalNatRule = deepClone(rule);
      }

      document.getElementById('natRuleId').value = ruleId;
      document.getElementById('natRuleDescription').value = rule.description || '';
      document.getElementById('natRuleProtocol').value = rule.protocol || '';
      document.getElementById('natRuleInterface').value =
        (natType === 'destination' ? rule['inbound-interface']?.name : rule['outbound-interface']?.name) || '';
      document.getElementById('natRuleSrcAddress').value = rule.source?.address || '';
      document.getElementById('natRuleSrcPort').value = rule.source?.port || '';
      document.getElementById('natRuleDstAddress').value = rule.destination?.address || '';
      document.getElementById('natRuleDstPort').value = rule.destination?.port || '';
      document.getElementById('natRuleTransAddress').value = rule.translation?.address || '';
      document.getElementById('natRuleTransPort').value = rule.translation?.port || '';
      // Exclude flag (VyOS stores it as an empty object or string when set)
      document.getElementById('natRuleExclude').checked = rule.exclude !== undefined;
    }
  } else {
    document.getElementById('natRuleTitle').textContent = 'New NAT Rule';
    document.getElementById('natRuleId').value = '';
    document.getElementById('natRuleExclude').checked = false;
  }
  toggleNatExclude();
  openModal('natRuleModal');
}

async function saveNatRule() {
  const natType = document.getElementById('natRuleType').value;
  const ruleId = document.getElementById('natRuleId').value;
  const excludeChecked = document.getElementById('natRuleExclude').checked;
  const transAddr = document.getElementById('natRuleTransAddress').value.trim();

  if (!natType || !ruleId) {
    showToast('error', 'Validation Error', 'Type and Rule ID are required');
    return;
  }

  // Translation address only required if not an exclude rule
  if (!excludeChecked && !transAddr) {
    showToast('error', 'Validation Error', 'Translation address is required (unless Exclude is enabled)');
    return;
  }

  const ruleData = {
    description: document.getElementById('natRuleDescription').value || undefined,
    protocol: document.getElementById('natRuleProtocol').value || undefined
  };

  // Add exclude flag or translation based on checkbox
  if (excludeChecked) {
    ruleData.exclude = true;
  } else {
    ruleData.translation = { address: transAddr };
    const transPort = document.getElementById('natRuleTransPort').value.trim();
    if (transPort) ruleData.translation.port = transPort;
  }

  const iface = document.getElementById('natRuleInterface').value.trim();
  if (iface) {
    const key = natType === 'destination' ? 'inbound-interface' : 'outbound-interface';
    ruleData[key] = { name: iface };
  }

  const srcAddr = document.getElementById('natRuleSrcAddress').value.trim();
  const srcPort = document.getElementById('natRuleSrcPort').value.trim();
  if (srcAddr || srcPort) {
    ruleData.source = {};
    if (srcAddr) ruleData.source.address = srcAddr;
    if (srcPort) ruleData.source.port = srcPort;
  }

  const dstAddr = document.getElementById('natRuleDstAddress').value.trim();
  const dstPort = document.getElementById('natRuleDstPort').value.trim();
  if (dstAddr || dstPort) {
    ruleData.destination = {};
    if (dstAddr) ruleData.destination.address = dstAddr;
    if (dstPort) ruleData.destination.port = dstPort;
  }

  Object.keys(ruleData).forEach(k => ruleData[k] === undefined && delete ruleData[k]);

  // Check if this is an edit (differential update) or create (full write)
  const isEdit = originalNatRule !== null;
  let diff = null;

  if (isEdit) {
    // Compute differential changes
    diff = getRuleDiff(originalNatRule, ruleData);

    // If no changes from original
    if (diff.sets.length === 0 && diff.deletes.length === 0) {
      // In staged mode, check if there's a pending operation to revert
      const marker = `nat:${natType}:${ruleId}`;
      if (stagedMode && pendingRuleMarkers.has(marker)) {
        // There's a pending operation - call addPendingOperation to handle revert
        const operationData = {
          type: 'nat',
          action: 'update',
          data: { nat_type: natType, rule_id: ruleId, rule: ruleData }
        };
        addPendingOperation(operationData);
        closeModal('natRuleModal');
        originalNatRule = null;
        return;
      }
      // No pending operation - just show "No Changes"
      showToast('info', 'No Changes', 'No changes detected');
      closeModal('natRuleModal');
      originalNatRule = null;
      return;
    }
  }

  // If staged mode is enabled, queue the operation
  if (stagedMode) {
    const operationData = {
      type: 'nat',
      action: isEdit ? 'update' : 'create',
      data: {
        nat_type: natType,
        rule_id: ruleId,
        rule: ruleData,
        ...(isEdit && diff ? { diff } : {})
      },
      display: `${isEdit ? 'Update' : 'Create'} ${natType} NAT rule ${ruleId}`
    };
    addPendingOperation(operationData);
    closeModal('natRuleModal');
    originalNatRule = null;
    return;
  }

  // Actual execution function
  const doSave = async () => {
    closeModal('natRuleModal');
    // Compute commands for logging
    let commands;
    if (isEdit && diff) {
      const basePath = `nat ${natType} rule ${ruleId}`;
      commands = buildDiffCommands(basePath, diff);
    } else {
      commands = buildNatCommands(natType, ruleId, ruleData);
    }
    const action = isEdit ? 'update' : 'create';
    const target = `${natType} NAT rule ${ruleId}`;

    try {
      showLoading('Applying NAT rule...');
      const requestBody = {
        nat_type: natType,
        rule_id: ruleId,
        rule: ruleData,
        ...(isEdit && diff ? { diff } : {})
      };
      const data = await clusterApplyFetch('/api/nat/rule', 'POST', requestBody);

      showToast('success', 'NAT Rule Saved', `NAT rule ${ruleId} saved successfully`);
      logActivity('nat', action, target, 'success',
                  `NAT rule ${ruleId} ${action}d successfully${clusterNodesSuffix(data)}`, commands);
      hasUnsavedChanges = true;
      updateSaveIndicator();
      // Reload NAT data
      const natRes = await fetch('/api/NAT');
      if (natRes.ok) {
        natData = await natRes.json();
        if (CONFIG) CONFIG.nat = natData;
      }
      loadNat();
    } catch (e) {
      if (!e.isDivergence) showToast('error', 'Error', e.message);
      logActivity('nat', action, target, 'error', `Failed to ${action} NAT rule: ${e.message}`, commands);
      loadNat();
    } finally {
      originalNatRule = null;
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    // Use diff commands when editing (differential update)
    let commands;
    if (isEdit && diff) {
      const basePath = `nat ${natType} rule ${ruleId}`;
      commands = buildDiffCommands(basePath, diff);
    } else {
      commands = buildNatCommands(natType, ruleId, ruleData);
    }
    showCommandPreview(commands, doSave);
  } else {
    await doSave();
  }
}

async function deleteNatRule(natType, ruleId) {
  if (!isConnected) {
    showToast('warning', 'Not Connected', 'Connect to the router first');
    return;
  }

  const confirmed = await openConfirmModal('Delete NAT Rule?', `Are you sure you want to delete NAT rule ${ruleId} (${natType})?`);
  if (!confirmed) return;

  // If staged mode is enabled, queue the operation
  if (stagedMode) {
    addPendingOperation({
      type: 'nat',
      action: 'delete',
      data: { nat_type: natType, rule_id: ruleId },
      display: `Delete ${natType} NAT rule ${ruleId}`
    });
    return;
  }

  // Actual execution function
  const commands = buildDeleteCommand('nat', natType, ruleId);
  const target = `${natType} NAT rule ${ruleId}`;

  const doDelete = async () => {
    try {
      showLoading('Deleting NAT rule...');
      const data = await clusterApplyFetch('/api/nat/rule', 'DELETE',
        { nat_type: natType, rule_id: ruleId });

      showToast('success', 'NAT Rule Deleted', `NAT rule ${ruleId} deleted successfully`);
      logActivity('nat', 'delete', target, 'success',
                  `NAT rule ${ruleId} deleted successfully${clusterNodesSuffix(data)}`, commands);
      hasUnsavedChanges = true;
      updateSaveIndicator();
      // Reload NAT data
      const natRes = await fetch('/api/NAT');
      if (natRes.ok) {
        natData = await natRes.json();
        if (CONFIG) CONFIG.nat = natData;
      }
      loadNat();
    } catch (e) {
      if (!e.isDivergence) showToast('error', 'Error', e.message);
      logActivity('nat', 'delete', target, 'error', `Failed to delete NAT rule: ${e.message}`, commands);
      loadNat();
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    const commands = buildDeleteCommand('nat', natType, ruleId);
    showCommandPreview(commands, doDelete);
  } else {
    await doDelete();
  }
}

// =========================================
// SAVE CONFIG TO ROUTER
// =========================================
async function saveConfigToRouter() {
  const dual = shouldDualApply();
  const clusterHint = isInCluster()
    ? (dual ? ' La configuración se guardará en ambos nodos del cluster.'
            : ' Cluster Sync OFF → solo se guardará en el primary.')
    : '';
  const confirmed = await openConfirmModal('Save Configuration',
    `Save the current configuration to the router? This will execute "save" on VyOS.${clusterHint}`);
  if (!confirmed) return;

  try {
    showLoading('Saving to router...');
    const body = isInCluster() ? { apply_to_peer: dual } : {};
    const res = await fetch('/api/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);

    const where = (j.nodes && j.nodes.length === 2) ? ' on both nodes' : '';
    showToast('success', 'Configuration Saved', `Configuration saved${where}`);
    hasUnsavedChanges = false;
    updateSaveIndicator();
    logActivity('config', 'save', 'Router config', 'success',
                `Configuration saved to router (config.boot)${where ? ' [→ primary + peer]' : ''}`);
  } catch (e) {
    showToast('error', 'Error', e.message);
    logActivity('config', 'save', 'Router config', 'error', `Failed to save config: ${e.message}`);
  } finally {
    // Restore content
    if (currentSection === 'Firewall' && currentRulesetName) {
      viewRuleset(currentRulesetName);
    } else if (currentSection === 'NAT') {
      loadNat();
    } else if (currentSection === 'Firewall') {
      loadFirewall();
    } else {
      renderDashboard();
    }
  }
}

// Event listener for Save button
document.getElementById('saveConfigBtn')?.addEventListener('click', saveConfigToRouter);

// =========================================
// VERBOSE MODE
// =========================================

// Toggle verbose mode
document.getElementById('verboseModeCheck')?.addEventListener('change', (e) => {
  verboseMode = e.target.checked;
  showToast('info', 'Verbose Mode', verboseMode ? 'Command preview enabled' : 'Command preview disabled');
});

// =========================================
// CLUSTER SYNC TOGGLE (per-session override for dual-apply)
// =========================================
document.getElementById('dualApplyCheck')?.addEventListener('change', (e) => {
  dualApplyEnabled = e.target.checked;
  const toggle = document.getElementById('dualApplyToggle');
  if (dualApplyEnabled) {
    toggle?.classList.remove('sync-off');
    showToast('info', 'Cluster Sync', 'Los cambios se aplicarán a ambos nodos');
  } else {
    toggle?.classList.add('sync-off');
    showToast('warning', 'Cluster Sync OFF',
              'Solo escribirás en el primary. Sin pre-flight de sync.');
  }
  // Re-render badge so the SOLO suffix appears/disappears
  if (clusterSyncState && clusterSyncState !== 'unknown') {
    updateClusterBadge(clusterSyncState);
  }
});

// =========================================
// STAGED MODE
// =========================================

// Toggle staged mode
document.getElementById('stagedModeCheck')?.addEventListener('change', async (e) => {
  const wasEnabled = stagedMode;
  stagedMode = e.target.checked;
  const toggle = document.getElementById('stagedToggle');

  if (stagedMode) {
    toggle?.classList.add('staged-active');
    showToast('info', 'Staged Mode', 'Changes will be queued - click Apply All to commit');
  } else {
    toggle?.classList.remove('staged-active');

    // If disabling and there are pending changes, ask what to do
    if (wasEnabled && pendingOperations.length > 0) {
      const confirmed = await openConfirmModal(
        'Pending Changes',
        `You have ${pendingOperations.length} pending change(s). Apply them now?`
      );
      if (confirmed) {
        await applyAllChanges();
      } else {
        await discardAllChangesQuiet();
      }
    }
    showToast('info', 'Staged Mode', 'Changes apply immediately');
  }
});

// Add operation to pending queue (consolidates operations for the same rule)
function addPendingOperation(operation) {
  const marker = buildRuleMarker(operation);

  // Check if there's already a pending operation for this rule
  const existingIndex = pendingOperations.findIndex(op => buildRuleMarker(op) === marker);

  if (existingIndex >= 0) {
    // Remove existing operation - we'll replace it with the new one
    pendingOperations.splice(existingIndex, 1);
  } else {
    // First time modifying this rule - store original server state
    const originalState = getOriginalServerState(operation);
    if (originalState !== undefined) {
      originalServerStates.set(marker, originalState);
    }
  }

  // For updates, check if new state matches original server state
  if (operation.action === 'update' || operation.action === 'create') {
    const origState = originalServerStates.get(marker);
    if (origState !== undefined && origState !== null) {
      // Compare new rule with original server state
      const diff = getRuleDiff(origState, operation.data.rule);
      if (diff.sets.length === 0 && diff.deletes.length === 0) {
        // No changes from original - remove the pending operation entirely
        pendingRuleMarkers.delete(marker);
        // Restore original state in CONFIG
        restoreOriginalInConfig(operation, origState);
        originalServerStates.delete(marker);
        updatePendingIndicator();
        showToast('info', 'Reverted', 'Rule restored to original state');
        // Log the revert
        const target = operation.type === 'firewall'
          ? `Rule ${operation.data.rule_id} in ${operation.data.ruleset}`
          : `${operation.data.nat_type} NAT rule ${operation.data.rule_id}`;
        logActivity(operation.type, 'revert', target, 'reverted', 'Pending change reverted - rule matches original state');
        refreshCurrentViewSoft();
        return;
      }
      // Update the diff in the operation to reflect changes from original
      operation.data.diff = diff;
    }
  }

  // Add the operation
  pendingOperations.push(operation);
  pendingRuleMarkers.add(marker);

  // Update local CONFIG to show changes immediately
  applyOperationToLocalConfig(operation);

  updatePendingIndicator();
  showToast('info', 'Staged', operation.display);

  // Log the staged operation
  const target = operation.type === 'firewall'
    ? `Rule ${operation.data.rule_id} in ${operation.data.ruleset}`
    : `${operation.data.nat_type} NAT rule ${operation.data.rule_id}`;
  const commands = buildCommandsForOperation(operation);
  logActivity(operation.type, 'staged', target, 'staged', `Staged: ${operation.display}`, commands);

  // Re-render current view to show the changes
  refreshCurrentViewSoft();
}

// Get original server state for a rule before any pending changes
function getOriginalServerState(operation) {
  if (!CONFIG) return undefined;

  if (operation.type === 'firewall') {
    const { ruleset, rule_id } = operation.data;
    const rules = CONFIG.firewall?.name?.[ruleset]?.rule;
    if (rules && rules[rule_id]) {
      return deepClone(rules[rule_id]);
    }
    return null; // Rule doesn't exist on server (new rule)
  } else if (operation.type === 'nat') {
    const { nat_type, rule_id } = operation.data;
    const rules = (nat_type === 'destination' ? natData?.destination : natData?.source)?.rule;
    if (rules && rules[rule_id]) {
      return deepClone(rules[rule_id]);
    }
    return null; // Rule doesn't exist on server (new rule)
  }
  return undefined;
}

// Restore original state in CONFIG when reverting a change
function restoreOriginalInConfig(operation, originalState) {
  if (!CONFIG) return;

  if (operation.type === 'firewall') {
    const { ruleset, rule_id } = operation.data;
    if (CONFIG.firewall?.name?.[ruleset]?.rule) {
      if (originalState === null) {
        delete CONFIG.firewall.name[ruleset].rule[rule_id];
      } else {
        CONFIG.firewall.name[ruleset].rule[rule_id] = originalState;
      }
      if (currentRulesetName === ruleset) {
        currentRulesetData = CONFIG.firewall.name[ruleset].rule || {};
      }
    }
  } else if (operation.type === 'nat') {
    const { nat_type, rule_id } = operation.data;
    const natSection = nat_type === 'destination' ? 'destination' : 'source';
    if (natData?.[natSection]?.rule) {
      if (originalState === null) {
        delete natData[natSection].rule[rule_id];
      } else {
        natData[natSection].rule[rule_id] = originalState;
      }
      if (CONFIG) CONFIG.nat = natData;
    }
  }
}

// Build marker key for a rule
function buildRuleMarker(operation) {
  if (operation.type === 'firewall') {
    return `firewall:${operation.data.ruleset}:${operation.data.rule_id}`;
  } else if (operation.type === 'nat') {
    return `nat:${operation.data.nat_type}:${operation.data.rule_id}`;
  }
  return '';
}

// Get pending status for a rule
function getPendingStatus(type, ...args) {
  let marker;
  if (type === 'firewall') {
    const [ruleset, ruleId] = args;
    marker = `firewall:${ruleset}:${ruleId}`;
  } else if (type === 'nat') {
    const [natType, ruleId] = args;
    marker = `nat:${natType}:${ruleId}`;
  }

  if (!pendingRuleMarkers.has(marker)) return null;

  // Find the operation to determine if it's a create/update or delete
  const op = pendingOperations.find(o => buildRuleMarker(o) === marker);
  return op ? op.action : null;
}

// Apply operation to local CONFIG (in-memory preview)
function applyOperationToLocalConfig(operation) {
  if (!CONFIG) return;

  if (operation.type === 'firewall') {
    const { ruleset, rule_id, rule } = operation.data;

    // Ensure path exists
    if (!CONFIG.firewall) CONFIG.firewall = {};
    if (!CONFIG.firewall.name) CONFIG.firewall.name = {};
    if (!CONFIG.firewall.name[ruleset]) CONFIG.firewall.name[ruleset] = { rule: {} };
    if (!CONFIG.firewall.name[ruleset].rule) CONFIG.firewall.name[ruleset].rule = {};

    if (operation.action === 'delete') {
      // Mark for deletion but keep for display with strikethrough
      // The actual deletion happens on apply
    } else {
      // Create or update
      CONFIG.firewall.name[ruleset].rule[rule_id] = rule;
    }

    // Update currentRulesetData if we're viewing this ruleset
    if (currentRulesetName === ruleset) {
      currentRulesetData = CONFIG.firewall.name[ruleset].rule || {};
    }

  } else if (operation.type === 'nat') {
    const { nat_type, rule_id, rule } = operation.data;

    // Ensure path exists
    if (!CONFIG.nat) CONFIG.nat = {};
    if (!CONFIG.nat[nat_type]) CONFIG.nat[nat_type] = { rule: {} };
    if (!CONFIG.nat[nat_type].rule) CONFIG.nat[nat_type].rule = {};

    if (operation.action === 'delete') {
      // Mark for deletion but keep for display
    } else {
      // Create or update
      CONFIG.nat[nat_type].rule[rule_id] = rule;
    }

    // Update natData
    if (natData) {
      if (!natData[nat_type]) natData[nat_type] = { rule: {} };
      if (!natData[nat_type].rule) natData[nat_type].rule = {};
      if (operation.action !== 'delete') {
        natData[nat_type].rule[rule_id] = rule;
      }
    }
  }
}

// Soft refresh - just re-render without fetching from server
function refreshCurrentViewSoft() {
  if (currentSection === 'Firewall' && currentRulesetName) {
    renderRuleset();
  } else if (currentSection === 'NAT') {
    renderNat(natData);
  }
}

// Update the pending indicator UI
function updatePendingIndicator() {
  const indicator = document.getElementById('pendingChangesIndicator');
  const countEl = document.getElementById('pendingCount');

  if (pendingOperations.length > 0) {
    indicator?.classList.remove('hidden');
    if (countEl) countEl.textContent = pendingOperations.length;
  } else {
    indicator?.classList.add('hidden');
  }
}

// Apply all pending changes
async function applyAllChanges() {
  if (pendingOperations.length === 0) {
    showToast('info', 'No Changes', 'No pending changes to apply');
    return;
  }

  // If verbose mode is enabled, show preview of all commands first
  if (verboseMode) {
    const allCommands = pendingOperations.flatMap(op => buildCommandsForOperation(op));
    showCommandPreview(allCommands, executeAllPending);
    return;
  }

  await executeAllPending();
}

// Execute all pending operations
async function executeAllPending() {
  if (pendingOperations.length === 0) return;

  const count = pendingOperations.length;
  // Build all commands for logging
  const allCommands = pendingOperations.flatMap(op => buildCommandsForOperation(op));

  try {
    showLoading(`Applying ${count} change(s)...`);

    const data = await clusterApplyFetch('/api/batch-configure', 'POST',
      { operations: pendingOperations });

    // Clear pending operations, markers, and original states
    pendingOperations = [];
    pendingRuleMarkers.clear();
    originalServerStates.clear();
    updatePendingIndicator();

    showToast('success', 'Applied', `${count} change(s) applied successfully`);
    logActivity('config', 'update', `Batch: ${count} operations`, 'success',
                `Applied ${count} staged change(s) to router${clusterNodesSuffix(data)}`, allCommands);
    hasUnsavedChanges = true;
    updateSaveIndicator();

    // Reload current view from server (get fresh data)
    await reloadCurrentView();

  } catch (e) {
    if (!e.isDivergence) showToast('error', 'Error', e.message);
    logActivity('config', 'update', `Batch: ${count} operations`, 'error', `Failed to apply batch changes: ${e.message}`, allCommands);
    // Keep pending operations on error for retry
    await reloadCurrentView();
  }
}

// Discard all pending changes (with confirmation)
async function discardAllChanges() {
  if (pendingOperations.length === 0) {
    showToast('info', 'No Changes', 'No pending changes to discard');
    return;
  }

  const confirmed = await openConfirmModal(
    'Discard Changes?',
    `Are you sure you want to discard ${pendingOperations.length} pending change(s)?`
  );

  if (confirmed) {
    await discardAllChangesQuiet();
  }
}

// Discard without confirmation (used internally)
async function discardAllChangesQuiet() {
  const count = pendingOperations.length;
  const discardedOps = [...pendingOperations]; // Keep copy for logging
  pendingOperations = [];
  pendingRuleMarkers.clear();
  originalServerStates.clear();
  updatePendingIndicator();

  if (count > 0) {
    showToast('info', 'Discarded', `${count} pending change(s) discarded`);
    // Log the discarded operations
    const descriptions = discardedOps.map(op => op.display).join(', ');
    logActivity('config', 'discard', `${count} operation(s)`, 'reverted', `Discarded pending changes: ${descriptions}`);
    // Reload from server to revert in-memory changes
    await reloadCurrentView();
  }
}

// Build VyOS commands for a single operation (for verbose mode preview)
function buildCommandsForOperation(op) {
  if (op.type === 'firewall') {
    if (op.action === 'delete') {
      return buildDeleteCommand('firewall', op.data.ruleset, op.data.rule_id);
    } else if (op.data.diff && op.action === 'update') {
      // Use diff commands for updates
      const basePath = `firewall ipv4 name ${op.data.ruleset} rule ${op.data.rule_id}`;
      return buildDiffCommands(basePath, op.data.diff);
    } else {
      return buildFirewallCommands(op.data.ruleset, op.data.rule_id, op.data.rule);
    }
  } else if (op.type === 'nat') {
    if (op.action === 'delete') {
      return buildDeleteCommand('nat', op.data.nat_type, op.data.rule_id);
    } else if (op.data.diff && op.action === 'update') {
      // Use diff commands for updates
      const basePath = `nat ${op.data.nat_type} rule ${op.data.rule_id}`;
      return buildDiffCommands(basePath, op.data.diff);
    } else {
      return buildNatCommands(op.data.nat_type, op.data.rule_id, op.data.rule);
    }
  }
  return [];
}

// Helper to reload current view after batch apply
async function reloadCurrentView() {
  if (currentSection === 'Firewall' && currentRulesetName) {
    await reloadConfig();
    viewRuleset(currentRulesetName);
  } else if (currentSection === 'NAT') {
    const natRes = await fetch('/api/NAT');
    if (natRes.ok) {
      natData = await natRes.json();
      if (CONFIG) CONFIG.nat = natData;
    }
    renderNat(natData);
  } else if (currentSection === 'Firewall') {
    await reloadConfig();
    loadFirewall();
  } else {
    await reloadConfig();
    renderDashboard();
  }
}

// Build VyOS set commands from firewall rule data
function buildFirewallCommands(ruleset, ruleId, ruleData) {
  const commands = [];
  const basePath = `firewall ipv4 name ${ruleset} rule ${ruleId}`;

  if (ruleData.action) {
    commands.push({ op: 'set', cmd: `set ${basePath} action '${ruleData.action}'` });
  }
  if (ruleData['jump-target']) {
    commands.push({ op: 'set', cmd: `set ${basePath} jump-target '${ruleData['jump-target']}'` });
  }
  if (ruleData.protocol) {
    commands.push({ op: 'set', cmd: `set ${basePath} protocol '${ruleData.protocol}'` });
  }
  if (ruleData.description) {
    commands.push({ op: 'set', cmd: `set ${basePath} description '${ruleData.description}'` });
  }

  // Source
  if (ruleData.source) {
    if (ruleData.source.address) {
      commands.push({ op: 'set', cmd: `set ${basePath} source address '${ruleData.source.address}'` });
    }
    if (ruleData.source.port) {
      commands.push({ op: 'set', cmd: `set ${basePath} source port '${ruleData.source.port}'` });
    }
    if (ruleData.source.group) {
      for (const [gtype, gname] of Object.entries(ruleData.source.group)) {
        commands.push({ op: 'set', cmd: `set ${basePath} source group ${gtype} '${gname}'` });
      }
    }
  }

  // Destination
  if (ruleData.destination) {
    if (ruleData.destination.address) {
      commands.push({ op: 'set', cmd: `set ${basePath} destination address '${ruleData.destination.address}'` });
    }
    if (ruleData.destination.port) {
      commands.push({ op: 'set', cmd: `set ${basePath} destination port '${ruleData.destination.port}'` });
    }
    if (ruleData.destination.group) {
      for (const [gtype, gname] of Object.entries(ruleData.destination.group)) {
        commands.push({ op: 'set', cmd: `set ${basePath} destination group ${gtype} '${gname}'` });
      }
    }
  }

  return commands;
}

// Build VyOS set commands from NAT rule data
function buildNatCommands(natType, ruleId, ruleData) {
  const commands = [];
  const basePath = `nat ${natType} rule ${ruleId}`;

  if (ruleData.description) {
    commands.push({ op: 'set', cmd: `set ${basePath} description '${ruleData.description}'` });
  }
  if (ruleData.protocol) {
    commands.push({ op: 'set', cmd: `set ${basePath} protocol '${ruleData.protocol}'` });
  }

  // Exclude flag
  if (ruleData.exclude) {
    commands.push({ op: 'set', cmd: `set ${basePath} exclude` });
  }

  // Source
  if (ruleData.source) {
    if (ruleData.source.address) {
      commands.push({ op: 'set', cmd: `set ${basePath} source address '${ruleData.source.address}'` });
    }
    if (ruleData.source.port) {
      commands.push({ op: 'set', cmd: `set ${basePath} source port '${ruleData.source.port}'` });
    }
  }

  // Destination
  if (ruleData.destination) {
    if (ruleData.destination.address) {
      commands.push({ op: 'set', cmd: `set ${basePath} destination address '${ruleData.destination.address}'` });
    }
    if (ruleData.destination.port) {
      commands.push({ op: 'set', cmd: `set ${basePath} destination port '${ruleData.destination.port}'` });
    }
  }

  // Translation
  if (ruleData.translation) {
    if (ruleData.translation.address) {
      commands.push({ op: 'set', cmd: `set ${basePath} translation address '${ruleData.translation.address}'` });
    }
    if (ruleData.translation.port) {
      commands.push({ op: 'set', cmd: `set ${basePath} translation port '${ruleData.translation.port}'` });
    }
  }

  // Interfaces
  if (ruleData['inbound-interface']?.name) {
    commands.push({ op: 'set', cmd: `set ${basePath} inbound-interface name '${ruleData['inbound-interface'].name}'` });
  }
  if (ruleData['outbound-interface']?.name) {
    commands.push({ op: 'set', cmd: `set ${basePath} outbound-interface name '${ruleData['outbound-interface'].name}'` });
  }

  return commands;
}

// Build delete command
function buildDeleteCommand(type, ...args) {
  if (type === 'firewall') {
    const [ruleset, ruleId] = args;
    return [{ op: 'delete', cmd: `delete firewall ipv4 name ${ruleset} rule ${ruleId}` }];
  } else if (type === 'nat') {
    const [natType, ruleId] = args;
    return [{ op: 'delete', cmd: `delete nat ${natType} rule ${ruleId}` }];
  }
  return [];
}

// Build commands from a diff object (for differential updates)
function buildDiffCommands(basePath, diff) {
  const commands = [];

  // Process set operations
  for (const setOp of diff.sets || []) {
    const pathStr = setOp.path.join(' ');
    const value = setOp.value;

    if (value !== null && value !== undefined) {
      if (typeof value === 'boolean') {
        if (value) {
          commands.push({ op: 'set', cmd: `set ${basePath} ${pathStr}` });
        }
      } else {
        commands.push({ op: 'set', cmd: `set ${basePath} ${pathStr} '${value}'` });
      }
    } else {
      commands.push({ op: 'set', cmd: `set ${basePath} ${pathStr}` });
    }
  }

  // Process delete operations
  for (const delPath of diff.deletes || []) {
    const pathStr = delPath.join(' ');
    commands.push({ op: 'delete', cmd: `delete ${basePath} ${pathStr}` });
  }

  return commands;
}

// Show command preview modal
function showCommandPreview(commands, executeCallback) {
  const content = document.getElementById('commandPreviewContent');
  content.innerHTML = commands.map(c => {
    const cssClass = c.op === 'delete' ? 'cmd-delete' : 'cmd-set';
    return `<span class="${cssClass}">${escapeHtml(c.cmd)}</span>`;
  }).join('\n');

  pendingCommandExecution = executeCallback;
  openModal('commandPreviewModal');
}

// Cancel command preview
function cancelCommandPreview() {
  pendingCommandExecution = null;
  closeModal('commandPreviewModal');
}

// Execute previewed commands
async function executePreviewedCommands() {
  closeModal('commandPreviewModal');
  if (pendingCommandExecution) {
    await pendingCommandExecution();
    pendingCommandExecution = null;
  }
}

// =========================================
// DRAGGABLE MODAL
// =========================================
function initDraggableModal(modalId, headerId, contentId) {
  const modal = document.getElementById(modalId);
  const header = document.getElementById(headerId);
  const content = document.getElementById(contentId);

  if (!modal || !header || !content) return;

  let isDragging = false;
  let startX, startY, initialX, initialY;

  // Center the modal initially when opened
  const centerModal = () => {
    const rect = content.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    content.style.left = `${(viewportWidth - rect.width) / 2}px`;
    content.style.top = `${(viewportHeight - rect.height) / 2}px`;
  };

  // Observe when modal becomes visible
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        if (!modal.classList.contains('hidden')) {
          // Reset position when modal opens
          content.style.left = '';
          content.style.top = '';
          setTimeout(centerModal, 10);
        }
      }
    });
  });
  observer.observe(modal, { attributes: true });

  header.addEventListener('mousedown', (e) => {
    // Don't drag if clicking on buttons
    if (e.target.closest('button')) return;

    isDragging = true;
    const rect = content.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    initialX = rect.left;
    initialY = rect.top;

    document.body.classList.add('modal-dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    let newX = initialX + deltaX;
    let newY = initialY + deltaY;

    // Keep modal within viewport bounds
    const rect = content.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;

    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));

    content.style.left = `${newX}px`;
    content.style.top = `${newY}px`;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.classList.remove('modal-dragging');
    }
  });
}

// Initialize draggable modals after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initDraggableModal('commandPreviewModal', 'commandPreviewModalHeader', 'commandPreviewModalContent');
  initDraggableModal('firewallRuleModal', 'firewallRuleModalHeader', 'firewallRuleModalContent');
  initDraggableModal('natRuleModal', 'natRuleModalHeader', 'natRuleModalContent');
  initDraggableModal('groupEditModal', 'groupEditModalHeader', 'groupEditModalContent');
});

// =========================================
// FIREWALL GROUPS
// =========================================

// Load groups data from API
async function loadGroups() {
  content.innerHTML = showSkeletonTable(6, 3);

  try {
    const res = await fetch('/api/firewall/groups');
    groupsData = await res.json();
    renderGroups();
  } catch (e) {
    showToast('error', 'Error', 'Failed to load firewall groups');
    content.innerHTML = '<div class="empty-state"><p class="text-muted">Failed to load firewall groups</p></div>';
  }
}

// Render groups view
function renderGroups() {
  const groups = groupsData || {};
  const groupTypes = [
    { key: 'address-group', label: 'Address Groups', entryKey: 'address', icon: 'IP' },
    { key: 'network-group', label: 'Network Groups', entryKey: 'network', icon: 'NET' },
    { key: 'port-group', label: 'Port Groups', entryKey: 'port', icon: 'PORT' }
  ];

  // Check if any groups exist
  const hasGroups = groupTypes.some(gt => Object.keys(groups[gt.key] || {}).length > 0);

  if (!hasGroups) {
    content.innerHTML = `
      <div class="groups-empty">
        <div class="groups-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <div class="groups-empty-title">No Firewall Groups</div>
        <p class="groups-empty-description">Create groups to organize IP addresses, networks, and ports for use in firewall rules.</p>
        ${isConnected ? `
          <button class="btn btn-primary" onclick="openGroupModal('create')" style="margin-top: 1rem;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Create First Group
          </button>
        ` : ''}
      </div>
    `;
    return;
  }

  // Render group sections
  let html = '';

  // Add "New Group" button if connected
  if (isConnected) {
    html += `
      <div class="table-actions" style="margin-bottom: 1.5rem;">
        <button class="btn btn-success btn-sm" onclick="openGroupModal('create', 'address')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Address Group
        </button>
        <button class="btn btn-success btn-sm" onclick="openGroupModal('create', 'network')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Network Group
        </button>
        <button class="btn btn-success btn-sm" onclick="openGroupModal('create', 'port')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Port Group
        </button>
      </div>
    `;
  }

  for (const gt of groupTypes) {
    const typeGroups = groups[gt.key] || {};
    const groupNames = Object.keys(typeGroups);

    if (groupNames.length === 0) continue;

    html += `
      <div class="groups-section">
        <div class="groups-section-header">
          <h3>${gt.label}</h3>
          <span class="groups-section-count">${groupNames.length} group${groupNames.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="groups-grid">
    `;

    for (const groupName of groupNames.sort()) {
      const groupData = typeGroups[groupName];
      const entries = getGroupEntries(groupData, gt.entryKey);
      const description = groupData.description || '';
      const pendingStatus = getGroupPendingStatus(gt.key.replace('-group', ''), groupName);
      const pendingClass = pendingStatus === 'delete' ? 'pending-delete' :
        (pendingStatus ? 'pending-change' : '');
      const pendingBadge = pendingStatus ? `<span class="pending-badge">${pendingStatus === 'delete' ? 'DEL' : 'MOD'}</span>` : '';

      html += `
        <div class="group-card ${pendingClass}">
          <div class="group-card-info">
            <div class="group-card-name">${escapeHtml(groupName)}${pendingBadge}</div>
            <div class="group-card-meta">
              <span class="group-card-entries-count">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                  <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
                ${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'}
              </span>
              ${description ? `<span class="group-card-description">${escapeHtml(description)}</span>` : ''}
            </div>
          </div>
          <div class="group-card-actions">
            <button class="btn-icon" onclick="showGroupDetails('${gt.key.replace('-group', '')}', '${escapeHtml(groupName)}')" title="View entries">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
            ${isConnected ? `
              <button class="btn-icon" onclick="openGroupModal('edit', '${gt.key.replace('-group', '')}', '${escapeHtml(groupName)}')" title="Edit group">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              <button class="btn-icon btn-danger" onclick="deleteGroup('${gt.key.replace('-group', '')}', '${escapeHtml(groupName)}')" title="Delete group">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }

    html += '</div></div>';
  }

  content.innerHTML = html;
}

// Get entries from a group object
function getGroupEntries(groupData, entryKey) {
  if (!groupData || !groupData[entryKey]) return [];
  const entry = groupData[entryKey];
  if (Array.isArray(entry)) return entry;
  if (typeof entry === 'string') return [entry];
  if (typeof entry === 'object') return Object.keys(entry);
  return [];
}

// Show group details modal (view only)
function showGroupDetails(groupType, groupName) {
  const groups = groupsData?.[`${groupType}-group`];
  if (!groups || !groups[groupName]) {
    showToast('error', 'Error', 'Group not found');
    return;
  }

  const groupData = groups[groupName];
  const entryKey = { address: 'address', network: 'network', port: 'port' }[groupType];
  const entries = getGroupEntries(groupData, entryKey);

  // Use existing group modal but in view mode
  const modal = document.getElementById('groupEditModal');
  const title = document.getElementById('groupEditTitle');
  const entriesList = document.getElementById('groupEntriesList');
  const footer = modal.querySelector('.modal-footer');

  title.textContent = `${groupName} (${groupType}-group)`;

  if (entries.length === 0) {
    entriesList.innerHTML = '<li class="group-entries-empty">No entries in this group</li>';
  } else {
    entriesList.innerHTML = entries.map(e => `
      <li><span class="entry-value">${escapeHtml(e)}</span></li>
    `).join('');
  }

  // Switch form to view-only mode (keep entries list visible, hide editable inputs via CSS)
  const form = document.getElementById('groupEditForm');
  form.style.display = 'block';
  form.classList.add('view-mode');
  document.getElementById('groupUsageInfo').classList.add('hidden');
  footer.innerHTML = '<button class="btn btn-secondary" onclick="closeModal(\'groupEditModal\')">Close</button>';

  openModal('groupEditModal');
}

// Open group modal for create/edit
async function openGroupModal(mode, groupType = 'address', groupName = '') {
  const modal = document.getElementById('groupEditModal');
  const form = document.getElementById('groupEditForm');
  const title = document.getElementById('groupEditTitle');
  const footer = modal.querySelector('.modal-footer');

  // Reset form visibility
  form.style.display = 'block';
  form.classList.remove('view-mode');

  // Set mode
  document.getElementById('groupEditMode').value = mode;
  document.getElementById('groupEditOriginalName').value = groupName;

  // Reset state
  groupModalEntries = [];
  groupOriginalEntries = [];
  groupOriginalDescription = null;

  // Set form values
  const typeSelect = document.getElementById('groupEditType');
  const nameInput = document.getElementById('groupEditName');
  const descInput = document.getElementById('groupEditDescription');

  typeSelect.value = groupType;
  typeSelect.disabled = (mode === 'edit');
  nameInput.value = groupName;
  nameInput.readOnly = (mode === 'edit');

  if (mode === 'create') {
    title.textContent = 'New Group';
    descInput.value = '';
    updateGroupEntryHint();
    renderGroupEntriesList();
  } else {
    title.textContent = `Edit Group: ${groupName}`;

    // Load existing group data
    const groups = groupsData?.[`${groupType}-group`];
    if (groups && groups[groupName]) {
      const groupData = groups[groupName];
      const entryKey = { address: 'address', network: 'network', port: 'port' }[groupType];
      const entries = getGroupEntries(groupData, entryKey);

      groupModalEntries = [...entries];
      groupOriginalEntries = [...entries];
      descInput.value = groupData.description || '';
      groupOriginalDescription = groupData.description || '';

      // Check for usage
      await loadGroupUsage(groupType, groupName);
    }

    updateGroupEntryHint();
    renderGroupEntriesList();
  }

  // Restore footer buttons
  footer.innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal('groupEditModal')">Cancel</button>
    <button class="btn btn-primary" onclick="saveGroup()">Save</button>
  `;

  openModal('groupEditModal');
}

// Update the entry hint based on group type
function updateGroupEntryHint() {
  const groupType = document.getElementById('groupEditType').value;
  const hints = {
    address: 'Format: IP address or IP range (e.g., 10.0.0.1 or 10.0.0.1-10.0.0.10)',
    network: 'Format: Network in CIDR notation (e.g., 192.168.0.0/24)',
    port: 'Format: Port number, range, or name (e.g., 443, 8000-8100, http)'
  };
  document.getElementById('groupEntryValidationHint').textContent = hints[groupType] || '';
  document.getElementById('groupNewEntry').placeholder = {
    address: '10.0.0.1 or 10.0.0.1-10.0.0.10',
    network: '192.168.0.0/24',
    port: '443 or 8000-8100'
  }[groupType] || 'Add entry...';
}

// Load and display group usage
async function loadGroupUsage(groupType, groupName) {
  try {
    const res = await fetch(`/api/firewall/group-usage/${groupType}/${groupName}`);
    const usage = await res.json();
    const usageInfo = document.getElementById('groupUsageInfo');
    const usageList = document.getElementById('groupUsageList');

    const refs = [...(usage.firewall || []), ...(usage.nat || [])];
    if (refs.length > 0) {
      usageList.innerHTML = refs.map(ref => {
        if (ref.ruleset) {
          return `<li>Firewall: ${ref.ruleset} rule ${ref.rule_id} (${ref.side})</li>`;
        } else {
          return `<li>NAT: ${ref.nat_type} rule ${ref.rule_id} (${ref.side})</li>`;
        }
      }).join('');
      usageInfo.classList.remove('hidden');
    } else {
      usageInfo.classList.add('hidden');
    }
  } catch (e) {
    console.error('Failed to load group usage:', e);
  }
}

// Render the entries list in the modal
function renderGroupEntriesList() {
  const list = document.getElementById('groupEntriesList');
  const mode = document.getElementById('groupEditMode').value;

  if (groupModalEntries.length === 0) {
    list.innerHTML = '<li class="group-entries-empty">No entries yet. Add entries above.</li>';
    return;
  }

  list.innerHTML = groupModalEntries.map((entry, index) => {
    // Determine if this is a new entry (not in original)
    const isNew = mode === 'edit' && !groupOriginalEntries.includes(entry);
    const entryClass = isNew ? 'entry-added' : '';

    return `
      <li class="${entryClass}">
        <span class="entry-value">${escapeHtml(entry)}</span>
        <button class="entry-remove" onclick="removeGroupEntry(${index})" title="Remove entry">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </li>
    `;
  }).join('');
}

// Add entry to the modal list
function addGroupEntry() {
  const input = document.getElementById('groupNewEntry');
  const value = input.value.trim();

  if (!value) return;

  // Validate entry format
  const groupType = document.getElementById('groupEditType').value;
  if (!validateGroupEntry(groupType, value)) {
    showToast('warning', 'Invalid Format', `"${value}" is not a valid ${groupType} entry`);
    return;
  }

  // Check for duplicates
  if (groupModalEntries.includes(value)) {
    showToast('warning', 'Duplicate', 'This entry already exists in the group');
    return;
  }

  groupModalEntries.push(value);
  input.value = '';
  renderGroupEntriesList();
}

// Remove entry from the modal list
function removeGroupEntry(index) {
  groupModalEntries.splice(index, 1);
  renderGroupEntriesList();
}

// Validate group entry format
function validateGroupEntry(groupType, value) {
  const patterns = {
    // IP: single IP or range (e.g., 10.0.0.1 or 10.0.0.1-10.0.0.10)
    address: /^(\d{1,3}\.){3}\d{1,3}(-(\d{1,3}\.){3}\d{1,3})?$/,
    // CIDR: network/prefix (e.g., 192.168.0.0/24)
    network: /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
    // Port: number, range, or service name (e.g., 443, 8000-8100, http)
    port: /^(\d+(-\d+)?|[a-z][a-z0-9-]*)$/i
  };

  return patterns[groupType]?.test(value) ?? true;
}

// Save group (create or update)
async function saveGroup() {
  const mode = document.getElementById('groupEditMode').value;
  const groupType = document.getElementById('groupEditType').value;
  const groupName = document.getElementById('groupEditName').value.trim();
  const description = document.getElementById('groupEditDescription').value.trim();

  // Validation
  if (!groupName) {
    showToast('warning', 'Validation', 'Group name is required');
    return;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(groupName)) {
    showToast('warning', 'Validation', 'Group name can only contain letters, numbers, underscores, and hyphens');
    return;
  }

  if (groupModalEntries.length === 0) {
    showToast('warning', 'Validation', 'Group must have at least one entry');
    return;
  }

  // Build the group data
  const groupData = {
    group_type: groupType,
    group_name: groupName,
    entries: groupModalEntries,
    description: description || undefined
  };

  // Calculate diff if editing
  let diff = null;
  if (mode === 'edit') {
    diff = getGroupDiff(groupType, groupOriginalEntries, groupModalEntries, groupOriginalDescription, description);
    if (diff.sets.length === 0 && diff.deletes.length === 0) {
      showToast('info', 'No Changes', 'No changes to save');
      closeModal('groupEditModal');
      return;
    }
    groupData.diff = diff;
  }

  // Build commands for logging/verbose
  const commands = buildGroupCommands(groupType, groupName, groupModalEntries, description, diff, mode === 'edit');

  closeModal('groupEditModal');

  // Check if staged mode
  if (stagedMode) {
    const operation = {
      type: 'group',
      action: mode === 'create' ? 'create' : 'update',
      data: groupData,
      display: mode === 'create' ? `Create ${groupType}-group ${groupName}` : `Update ${groupType}-group ${groupName}`
    };
    addGroupPendingOperation(operation);
    return;
  }

  // Verbose mode - show preview
  if (verboseMode) {
    showCommandPreview(commands, async () => {
      await executeGroupSave(groupData, mode, commands);
    });
    return;
  }

  // Direct save
  await executeGroupSave(groupData, mode, commands);
}

// Execute group save to API
async function executeGroupSave(groupData, mode, commands) {
  try {
    showLoading('Applying...');

    const data = await clusterApplyFetch('/api/firewall/group', 'POST', groupData);

    // Update local data
    const groupRes = await fetch('/api/firewall/groups');
    if (groupRes.ok) {
      groupsData = await groupRes.json();
      if (CONFIG) CONFIG.firewall = CONFIG.firewall || {};
      if (CONFIG) CONFIG.firewall.group = groupsData;
    }

    showToast('success', 'Success', `Group ${mode === 'create' ? 'created' : 'updated'} successfully`);
    hasUnsavedChanges = true;
    updateSaveIndicator();

    // Log activity
    logActivity('group', mode === 'create' ? 'create' : 'update',
      `${groupData.group_type}-group: ${groupData.group_name}`,
      'success', `${mode === 'create' ? 'Created' : 'Updated'} firewall group${clusterNodesSuffix(data)}`, commands);

    renderGroups();
  } catch (e) {
    if (!e.isDivergence) showToast('error', 'Error', e.message);
    logActivity('group', mode === 'create' ? 'create' : 'update',
      `${groupData.group_type}-group: ${groupData.group_name}`,
      'error', `Failed: ${e.message}`, commands);
    renderGroups();
  }
}

// Delete a group
async function deleteGroup(groupType, groupName) {
  // Check usage first
  try {
    const res = await fetch(`/api/firewall/group-usage/${groupType}/${groupName}`);
    const usage = await res.json();
    const refs = [...(usage.firewall || []), ...(usage.nat || [])];

    if (refs.length > 0) {
      const refList = refs.slice(0, 5).map(ref => {
        if (ref.ruleset) return `${ref.ruleset} rule ${ref.rule_id}`;
        return `${ref.nat_type} NAT rule ${ref.rule_id}`;
      }).join(', ');
      showToast('error', 'Cannot Delete', `Group is used by: ${refList}${refs.length > 5 ? '...' : ''}`);
      return;
    }
  } catch (e) {
    console.error('Failed to check group usage:', e);
  }

  const confirmed = await openConfirmModal(
    'Delete Group?',
    `Are you sure you want to delete the group "${groupName}"? This action cannot be undone.`
  );

  if (!confirmed) return;

  const commands = [{ op: 'delete', cmd: `delete firewall group ${groupType}-group ${groupName}` }];

  // Check if staged mode
  if (stagedMode) {
    const operation = {
      type: 'group',
      action: 'delete',
      data: { group_type: groupType, group_name: groupName },
      display: `Delete ${groupType}-group ${groupName}`
    };
    addGroupPendingOperation(operation);
    return;
  }

  // Verbose mode
  if (verboseMode) {
    showCommandPreview(commands, async () => {
      await executeGroupDelete(groupType, groupName, commands);
    });
    return;
  }

  await executeGroupDelete(groupType, groupName, commands);
}

// Execute group delete
async function executeGroupDelete(groupType, groupName, commands) {
  try {
    showLoading('Deleting...');

    const data = await clusterApplyFetch('/api/firewall/group', 'DELETE',
      { group_type: groupType, group_name: groupName });

    // Update local data
    const groupRes = await fetch('/api/firewall/groups');
    if (groupRes.ok) {
      groupsData = await groupRes.json();
      if (CONFIG) CONFIG.firewall.group = groupsData;
    }

    showToast('success', 'Deleted', `Group "${groupName}" deleted`);
    hasUnsavedChanges = true;
    updateSaveIndicator();

    logActivity('group', 'delete', `${groupType}-group: ${groupName}`,
      'success', `Deleted firewall group${clusterNodesSuffix(data)}`, commands);

    renderGroups();
  } catch (e) {
    if (!e.isDivergence) showToast('error', 'Error', e.message);
    logActivity('group', 'delete', `${groupType}-group: ${groupName}`,
      'error', `Failed: ${e.message}`, commands);
    renderGroups();
  }
}

// Calculate diff between original and new group entries
function getGroupDiff(groupType, originalEntries, newEntries, originalDesc, newDesc) {
  const entryKey = { address: 'address', network: 'network', port: 'port' }[groupType];
  const diff = { sets: [], deletes: [] };

  // Find added entries
  for (const entry of newEntries) {
    if (!originalEntries.includes(entry)) {
      diff.sets.push({ path: [entryKey, entry], value: null });
    }
  }

  // Find removed entries
  for (const entry of originalEntries) {
    if (!newEntries.includes(entry)) {
      diff.deletes.push([entryKey, entry]);
    }
  }

  // Check description change
  if (newDesc !== originalDesc) {
    if (newDesc) {
      diff.sets.push({ path: ['description'], value: newDesc });
    } else if (originalDesc) {
      diff.deletes.push(['description']);
    }
  }

  return diff;
}

// Build VyOS commands for a group operation
function buildGroupCommands(groupType, groupName, entries, description, diff, isEdit) {
  const commands = [];
  const basePath = `firewall group ${groupType}-group ${groupName}`;
  const entryKey = { address: 'address', network: 'network', port: 'port' }[groupType];

  if (diff && isEdit) {
    // Differential update
    for (const setOp of diff.sets || []) {
      const pathStr = setOp.path.join(' ');
      if (setOp.value !== null && setOp.value !== undefined) {
        commands.push({ op: 'set', cmd: `set ${basePath} ${pathStr} '${setOp.value}'` });
      } else {
        commands.push({ op: 'set', cmd: `set ${basePath} ${pathStr}` });
      }
    }
    for (const delPath of diff.deletes || []) {
      const pathStr = delPath.join(' ');
      commands.push({ op: 'delete', cmd: `delete ${basePath} ${pathStr}` });
    }
  } else {
    // Full create
    for (const entry of entries) {
      commands.push({ op: 'set', cmd: `set ${basePath} ${entryKey} '${entry}'` });
    }
    if (description) {
      commands.push({ op: 'set', cmd: `set ${basePath} description '${description}'` });
    }
  }

  return commands;
}

// Get pending status for a group
function getGroupPendingStatus(groupType, groupName) {
  const marker = `group:${groupType}:${groupName}`;
  if (!pendingRuleMarkers.has(marker)) return null;
  const op = pendingOperations.find(o => buildGroupMarker(o) === marker);
  return op ? op.action : null;
}

// Build marker for a group operation
function buildGroupMarker(operation) {
  if (operation.type !== 'group') return '';
  return `group:${operation.data.group_type}:${operation.data.group_name}`;
}

// Add group operation to pending queue (staged mode)
function addGroupPendingOperation(operation) {
  const marker = buildGroupMarker(operation);

  // Check if there's already a pending operation for this group
  const existingIndex = pendingOperations.findIndex(op =>
    op.type === 'group' && buildGroupMarker(op) === marker
  );

  if (existingIndex >= 0) {
    pendingOperations.splice(existingIndex, 1);
  } else {
    // Store original server state
    const originalState = getGroupOriginalServerState(operation);
    if (originalState !== undefined) {
      originalServerStates.set(marker, originalState);
    }
  }

  // For updates, check if reverted to original
  if (operation.action === 'update') {
    const origState = originalServerStates.get(marker);
    if (origState !== undefined && origState !== null) {
      // Compare entries
      const origEntries = getGroupEntries(origState, { address: 'address', network: 'network', port: 'port' }[operation.data.group_type]);
      const newEntries = operation.data.entries;
      const origDesc = origState.description || '';
      const newDesc = operation.data.description || '';

      if (arraysEqual(origEntries, newEntries) && origDesc === newDesc) {
        // Reverted to original
        pendingRuleMarkers.delete(marker);
        restoreGroupOriginalInConfig(operation, origState);
        originalServerStates.delete(marker);
        updatePendingIndicator();
        showToast('info', 'Reverted', 'Group restored to original state');
        logActivity('group', 'revert', `${operation.data.group_type}-group: ${operation.data.group_name}`,
          'reverted', 'Pending change reverted - group matches original state');
        renderGroups();
        return;
      }
    }
  }

  // Add the operation
  pendingOperations.push(operation);
  pendingRuleMarkers.add(marker);

  // Update local config
  applyGroupOperationToLocalConfig(operation);

  updatePendingIndicator();
  showToast('info', 'Staged', operation.display);

  // Log
  const commands = buildGroupCommands(
    operation.data.group_type,
    operation.data.group_name,
    operation.data.entries || [],
    operation.data.description,
    operation.data.diff,
    operation.action === 'update'
  );
  logActivity('group', 'staged', `${operation.data.group_type}-group: ${operation.data.group_name}`,
    'staged', `Staged: ${operation.display}`, commands);

  renderGroups();
}

// Get original server state for a group
function getGroupOriginalServerState(operation) {
  if (!groupsData) return undefined;
  const { group_type, group_name } = operation.data;
  const groups = groupsData[`${group_type}-group`];
  if (groups && groups[group_name]) {
    return deepClone(groups[group_name]);
  }
  return null; // Group doesn't exist on server
}

// Restore group original state in local config
function restoreGroupOriginalInConfig(operation, originalState) {
  if (!groupsData) return;
  const { group_type, group_name } = operation.data;
  const groupKey = `${group_type}-group`;

  if (!groupsData[groupKey]) groupsData[groupKey] = {};

  if (originalState === null) {
    delete groupsData[groupKey][group_name];
  } else {
    groupsData[groupKey][group_name] = originalState;
  }

  if (CONFIG) CONFIG.firewall.group = groupsData;
}

// Apply group operation to local config
function applyGroupOperationToLocalConfig(operation) {
  if (!groupsData) groupsData = {};

  const { group_type, group_name, entries, description } = operation.data;
  const groupKey = `${group_type}-group`;
  const entryKey = { address: 'address', network: 'network', port: 'port' }[group_type];

  if (!groupsData[groupKey]) groupsData[groupKey] = {};

  if (operation.action === 'delete') {
    // Mark for deletion but keep for display
  } else {
    // Create or update
    const groupData = groupsData[groupKey][group_name] || {};
    groupData[entryKey] = entries;
    if (description) {
      groupData.description = description;
    } else {
      delete groupData.description;
    }
    groupsData[groupKey][group_name] = groupData;
  }

  if (CONFIG) CONFIG.firewall = CONFIG.firewall || {};
  if (CONFIG) CONFIG.firewall.group = groupsData;
}

// Helper: compare arrays for equality
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

// Update buildRuleMarker to handle groups
const _originalBuildRuleMarker = buildRuleMarker;
buildRuleMarker = function(operation) {
  if (operation.type === 'group') {
    return buildGroupMarker(operation);
  }
  return _originalBuildRuleMarker(operation);
};

// Update buildCommandsForOperation to handle groups
const _originalBuildCommandsForOperation = buildCommandsForOperation;
buildCommandsForOperation = function(op) {
  if (op.type === 'group') {
    if (op.action === 'delete') {
      return [{ op: 'delete', cmd: `delete firewall group ${op.data.group_type}-group ${op.data.group_name}` }];
    } else {
      return buildGroupCommands(
        op.data.group_type,
        op.data.group_name,
        op.data.entries || [],
        op.data.description,
        op.data.diff,
        op.action === 'update'
      );
    }
  }
  return _originalBuildCommandsForOperation(op);
};

// Update refreshCurrentViewSoft to handle groups
const _originalRefreshCurrentViewSoft = refreshCurrentViewSoft;
refreshCurrentViewSoft = function() {
  if (currentSection === 'Groups') {
    renderGroups();
    return;
  }
  _originalRefreshCurrentViewSoft();
};

// Update reloadCurrentView to handle groups
const _originalReloadCurrentView = reloadCurrentView;
reloadCurrentView = async function() {
  if (currentSection === 'Groups') {
    const groupRes = await fetch('/api/firewall/groups');
    if (groupRes.ok) {
      groupsData = await groupRes.json();
      if (CONFIG) CONFIG.firewall.group = groupsData;
    }
    renderGroups();
    return;
  }
  await _originalReloadCurrentView();
};

// =========================================
// KEYBOARD SHORTCUTS
// =========================================
document.addEventListener('keydown', (e) => {
  // Don't trigger shortcuts when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Escape') {
      e.target.blur();
    }
    return;
  }

  // Check for open modals
  const openModal = document.querySelector('.modal:not(.hidden)');

  if (e.key === 'Escape') {
    if (openModal) {
      closeAnyModal();
    }
    return;
  }

  // Don't process other shortcuts if modal is open
  if (openModal) return;

  switch (e.key) {
    case '?':
      document.getElementById('shortcutsModal').classList.remove('hidden');
      break;
    case 'c':
      document.getElementById('fetchBtn').click();
      break;
    case 'u':
      document.getElementById('fileInput').click();
      break;
    case 'd':
      if (CONFIG) loadSection('Dashboard');
      break;
    case 'f':
      if (CONFIG) loadSection('Firewall');
      break;
    case 'n':
      if (CONFIG) loadSection('NAT');
      break;
    case 'g':
      if (CONFIG) loadSection('Groups');
      break;
    case 'i':
      if (CONFIG) loadSection('Interfaces');
      break;
    case 'r':
      if (currentRulesetName) {
        // Toggle resolved state when viewing ruleset
        showResolved = !showResolved;
        renderRuleset();
      } else if (CONFIG) {
        loadSection('Routes');
      }
      break;
    case 'b':
      if (CONFIG) loadSection('BGP');
      break;
    case 'a':
      if (CONFIG) loadSection('Activity');
      break;
    case 's':
      if (currentRulesetName) openSearchModal();
      break;
    case '/':
      // Global search shortcut
      e.preventDefault();
      openGlobalSearch();
      break;
  }
});

// =========================================
// BEFOREUNLOAD WARNING
// =========================================

// Warn before closing if there are pending staged changes
window.addEventListener('beforeunload', (e) => {
  if (pendingOperations.length > 0) {
    e.preventDefault();
    // Most browsers ignore custom messages, but we set it anyway
    e.returnValue = `You have ${pendingOperations.length} pending change(s) that will be lost.`;
    return e.returnValue;
  }
});

// =========================================
// CLUSTER HA (detection, peer connect, sync check)
// =========================================
function isInCluster() {
  return !!(clusterInfo && clusterInfo.detected && clusterInfo.peer_connected);
}

// True only when we should actually propagate writes to the peer right now.
// isInCluster() is the environment check; this adds the user's toggle override.
function shouldDualApply() {
  return isInCluster() && dualApplyEnabled;
}

function updateClusterBadge(state, info = null) {
  const badge = document.getElementById('clusterBadge');
  const label = document.getElementById('clusterBadgeLabel');
  const stateEl = document.getElementById('clusterBadgeState');
  const dualToggle = document.getElementById('dualApplyToggle');
  if (!badge) return;

  if (!state) {
    badge.classList.add('hidden');
    badge.classList.remove('state-detected', 'state-sync', 'state-diverged', 'state-checking', 'state-solo');
    dualToggle?.classList.add('hidden');
    clusterSyncState = 'unknown';
    return;
  }

  badge.classList.remove('hidden', 'state-detected', 'state-sync', 'state-diverged', 'state-checking', 'state-solo');
  const primary = (info?.primary_name || clusterInfo?.primary_name || '').split('-').pop();
  const peer = (info?.peer_name || clusterInfo?.peer_name || '').split('-').pop();
  label.textContent = `HA ${primary}↔${peer}`;

  // Show the Cluster Sync toggle in the header when we have a peer connected
  if (clusterInfo?.peer_connected) {
    dualToggle?.classList.remove('hidden');
  } else {
    dualToggle?.classList.add('hidden');
  }

  const soloSuffix = (!dualApplyEnabled && clusterInfo?.peer_connected) ? ' · SOLO' : '';

  clusterSyncState = state;
  if (state === 'detected') {
    badge.classList.add('state-detected');
    stateEl.textContent = 'PEER?';
    badge.title = `Cluster detectado. Click para conectar al peer ${clusterInfo?.peer_name || ''}`;
    badge.onclick = () => autoConnectPeer(true);
  } else if (state === 'checking') {
    badge.classList.add('state-checking');
    stateEl.textContent = 'CHECKING…';
    badge.onclick = null;
  } else if (state === 'sync') {
    badge.classList.add('state-sync');
    stateEl.textContent = 'SYNC ✓' + soloSuffix;
    badge.title = soloSuffix
      ? 'Ambos nodos en sync, pero Cluster Sync está OFF: los cambios irán solo al primary.'
      : 'Ambos nodos sincronizados. Click para re-verificar.';
    badge.onclick = () => runSyncCheck(true);
  } else if (state === 'diverged') {
    badge.classList.add('state-diverged');
    stateEl.textContent = 'DIVERGED ✗' + soloSuffix;
    badge.title = `Los nodos no están sincronizados. Click para ver diferencias.`;
    badge.onclick = () => showDivergenceModal(lastClusterDiffs);
  }

  if (soloSuffix) badge.classList.add('state-solo');
}

async function autoConnectPeer(forceRetry = false) {
  if (!clusterInfo?.detected) return;
  if (!forceRetry && clusterInfo.peer_connected) return;

  updateClusterBadge('checking');
  try {
    const res = await fetch('/fetch-peer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})  // backend uses peer_name + primary api-key/port
    });
    const j = await res.json();
    if (!res.ok) {
      // Auto-connect falló: abrir modal de fallback manual
      showToast('warning', 'Peer auto-connect failed',
                `No se pudo conectar automáticamente a ${clusterInfo.peer_name}. Introduce los datos.`);
      openPeerFallbackModal(j.error || 'Auto-connect falló');
      updateClusterBadge('detected');
      return;
    }
    clusterInfo = j.cluster_info || clusterInfo;
    clusterInfo.peer_connected = true;
    logActivity('cluster', 'peer-connect', clusterInfo.peer_name, 'success',
                `Peer conectado en ${clusterInfo.peer_host}:${clusterInfo.peer_port}`);
    if (j.hostname_mismatch) {
      showToast('warning', 'Hostname mismatch',
                `Peer responde como ${j.peer_hostname}, esperaba ${j.expected}. Continuamos.`);
    } else {
      showToast('success', 'Peer connected', `Conectado a ${clusterInfo.peer_name}`);
    }
    runSyncCheck();
  } catch (e) {
    showToast('error', 'Peer connect error', e.message);
    updateClusterBadge('detected');
  }
}

function openPeerFallbackModal(initialError = '') {
  const existing = document.getElementById('peerFallbackModal');
  if (existing) existing.remove();
  const html = `
    <div class="modal" id="peerFallbackModal">
      <div class="modal-backdrop" onclick="closeModal('peerFallbackModal')"></div>
      <div class="modal-content modal-md">
        <div class="modal-header">
          <h3>Conectar al peer del cluster</h3>
          <button class="modal-close" onclick="closeModal('peerFallbackModal')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="modal-body">
          ${initialError ? `<div class="modal-alert error" style="margin-bottom:1rem;">
            <div class="modal-alert-content">
              <div class="modal-alert-title">Auto-connect falló</div>
              <div class="modal-alert-message">${escapeHtml(initialError)}</div>
            </div>
          </div>` : ''}
          <div class="modal-alert info" style="margin-bottom: 1rem;">
            <div class="modal-alert-content">
              <div class="modal-alert-title">Peer esperado: ${escapeHtml(clusterInfo?.peer_name || '')}</div>
              <div class="modal-alert-message">Por defecto se reutiliza la api-key del primario. Editable si fuera distinta.</div>
            </div>
          </div>
          <div class="modal-form-group">
            <label class="modal-form-label">Host / IP <span class="required">*</span></label>
            <input type="text" id="peerFallbackHost" placeholder="10.0.0.2 o ${escapeHtml(clusterInfo?.peer_name || '')}"
                   value="${escapeHtml(clusterInfo?.peer_name || '')}" />
          </div>
          <div class="modal-form-row">
            <div class="modal-form-group">
              <label class="modal-form-label">HTTPS Port</label>
              <input type="text" id="peerFallbackPort" placeholder="8443" />
            </div>
            <div class="modal-form-group" style="flex: 2;">
              <label class="modal-form-label">API Key (opcional — usa la del primario si vacía)</label>
              <input type="password" id="peerFallbackKey" placeholder="deja vacío para reutilizar" />
            </div>
          </div>
          <div id="peerFallbackStatus"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('peerFallbackModal')">Cancelar</button>
          <button class="btn btn-primary" id="peerFallbackSubmit">Conectar</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('peerFallbackSubmit').onclick = submitPeerFallback;
}

async function submitPeerFallback() {
  const host = document.getElementById('peerFallbackHost').value.trim();
  const port = document.getElementById('peerFallbackPort').value.trim();
  const key = document.getElementById('peerFallbackKey').value;
  const statusDiv = document.getElementById('peerFallbackStatus');
  const btn = document.getElementById('peerFallbackSubmit');

  if (!host) {
    statusDiv.innerHTML = `<div class="modal-alert error"><div class="modal-alert-content"><div class="modal-alert-title">Host requerido</div></div></div>`;
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<div class="loading-spinner"></div> Conectando…';

  const body = { host };
  if (port) body.port = parseInt(port, 10);
  if (key) body.api_key = key;

  try {
    const res = await fetch('/fetch-peer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    if (!res.ok) {
      statusDiv.innerHTML = `<div class="modal-alert error"><div class="modal-alert-content"><div class="modal-alert-title">Conexión fallida</div><div class="modal-alert-message">${escapeHtml(j.error || 'unknown')}</div></div></div>`;
      btn.disabled = false;
      btn.textContent = 'Reintentar';
      return;
    }
    clusterInfo = j.cluster_info || clusterInfo;
    clusterInfo.peer_connected = true;
    closeModal('peerFallbackModal');
    logActivity('cluster', 'peer-connect', clusterInfo.peer_name, 'success',
                `Peer conectado (manual) en ${clusterInfo.peer_host}:${clusterInfo.peer_port}`);
    showToast('success', 'Peer connected', `Conectado a ${clusterInfo.peer_name}`);
    runSyncCheck();
  } catch (e) {
    statusDiv.innerHTML = `<div class="modal-alert error"><div class="modal-alert-content"><div class="modal-alert-title">Error</div><div class="modal-alert-message">${escapeHtml(e.message)}</div></div></div>`;
    btn.disabled = false;
    btn.textContent = 'Reintentar';
  }
}

async function runSyncCheck(verbose = false) {
  if (!isInCluster()) {
    updateClusterBadge(clusterInfo?.detected ? 'detected' : null);
    return { synchronized: true };
  }
  updateClusterBadge('checking');
  try {
    const res = await fetch('/api/cluster/sync-check');
    const j = await res.json();
    if (!res.ok) {
      showToast('error', 'Sync check failed', j.error || 'unknown');
      updateClusterBadge('detected');
      return { synchronized: false, error: j.error };
    }
    lastClusterDiffs = j.differences || [];
    if (j.synchronized) {
      updateClusterBadge('sync');
      if (verbose) showToast('success', 'In sync', 'Ambos nodos están sincronizados');
    } else {
      updateClusterBadge('diverged');
      if (verbose) {
        showDivergenceModal(lastClusterDiffs);
      } else {
        showToast('warning', 'Cluster diverged', `${lastClusterDiffs.length} diferencias. Click en el badge HA para verlas.`);
      }
    }
    return j;
  } catch (e) {
    showToast('error', 'Sync check error', e.message);
    updateClusterBadge('detected');
    return { synchronized: false, error: e.message };
  }
}

function showDivergenceModal(diffs) {
  const existing = document.getElementById('clusterDiffModal');
  if (existing) existing.remove();

  const rowsBySection = {};
  for (const d of diffs) {
    (rowsBySection[d.section] = rowsBySection[d.section] || []).push(d);
  }

  const sections = Object.keys(rowsBySection).sort();
  const body = sections.length === 0
    ? `<p class="text-muted">No hay divergencias. Los nodos están sincronizados.</p>`
    : sections.map(sec => `
        <fieldset class="form-fieldset" style="margin-bottom:0.75rem;">
          <legend>${escapeHtml(sec)} <span class="badge badge-danger">${rowsBySection[sec].length}</span></legend>
          <ul class="group-entries-list">
            ${rowsBySection[sec].map(d => `
              <li><span class="entry-value">${escapeHtml(d.id)}</span>
                <span class="text-muted" style="margin-left:0.75rem;">${escapeHtml(d.kind)}</span>
              </li>`).join('')}
          </ul>
        </fieldset>`).join('');

  const html = `
    <div class="modal" id="clusterDiffModal">
      <div class="modal-backdrop" onclick="closeModal('clusterDiffModal')"></div>
      <div class="modal-content modal-lg">
        <div class="modal-header">
          <h3>Diferencias entre nodos del cluster</h3>
          <button class="modal-close" onclick="closeModal('clusterDiffModal')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="modal-alert warning" style="margin-bottom:1rem;">
            <div class="modal-alert-content">
              <div class="modal-alert-title">${diffs.length} diferencias detectadas</div>
              <div class="modal-alert-message">
                El dual-apply queda bloqueado hasta que los nodos estén sincronizados.
                Puedes sincronizar manualmente (por SSH o por la UI, nodo a nodo) y volver a verificar.
              </div>
            </div>
          </div>
          ${body}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('clusterDiffModal')">Cerrar</button>
          <button class="btn btn-danger" onclick="disconnectPeer(true)">Aplicar solo al primary</button>
          <button class="btn btn-primary" onclick="runSyncCheck(true); closeModal('clusterDiffModal')">Re-verificar</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function disconnectPeer(closeDivergenceModal = false) {
  try {
    const res = await fetch('/api/cluster/disconnect-peer', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (clusterInfo) clusterInfo = { ...clusterInfo, peer_connected: false };
    lastClusterDiffs = [];
    updateClusterBadge(clusterInfo?.detected ? 'detected' : null);
    if (closeDivergenceModal) closeModal('clusterDiffModal');
    showToast('info', 'Peer desconectado',
              'Las próximas operaciones irán solo al primary. Reconecta el peer cuando resuelvas la divergencia.');
    logActivity('cluster', 'peer-disconnect', clusterInfo?.peer_name || '',
                'success', 'Peer desconectado: modo single-node activado');
  } catch (e) {
    showToast('error', 'Error', e.message);
  }
}

// Helper: include apply_to_peer in write requests when in cluster (default ON)
function withClusterApply(body) {
  if (!isInCluster()) return body;
  return { ...body, apply_to_peer: true };
}

/**
 * Fetch wrapper for write endpoints that transparently handles cluster mode:
 *   - Adds apply_to_peer=true when in cluster
 *   - Handles 409 (cluster diverged) by showing the divergence modal
 *   - Throws with the server's error message on other failures
 *   - Triggers a post-apply sync-check to keep the badge fresh
 * Returns parsed JSON body on success.
 */
async function clusterApplyFetch(url, method, bodyObj) {
  const inCluster = isInCluster();
  const dual = shouldDualApply();
  // Send apply_to_peer explicitly when in cluster:
  //   true  → backend runs pre-flight sync-check and applies to both
  //   false → backend skips peer (single-node write, no pre-flight)
  const merged = inCluster
    ? { ...(bodyObj || {}), apply_to_peer: dual }
    : (bodyObj || {});
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(merged)
  });
  let data = null;
  try { data = await res.json(); } catch {}

  if (res.status === 409 && data?.differences) {
    lastClusterDiffs = data.differences;
    updateClusterBadge('diverged');
    showDivergenceModal(data.differences);
    const err = new Error('Cluster no sincronizado — apply bloqueado');
    err.isDivergence = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }

  // Refresh the HA badge after any write when we're in a cluster (even if we
  // only hit the primary — the sync state probably drifted).
  if (inCluster) setTimeout(() => runSyncCheck(false), 0);

  return data;
}

// Suffix for activity log messages to reflect where the change was applied
function clusterNodesSuffix(responseData) {
  const applied = responseData?.applied_to;
  if (Array.isArray(applied) && applied.length === 2) return ' [→ primary + peer]';
  if (Array.isArray(applied) && applied.length === 1) return ' [→ primary]';
  return '';
}

// =========================================
// INITIALIZATION
// =========================================
console.log('VyOS Config Viewer initialized (API REST version)');
