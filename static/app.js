// static/app.js
// VyOS Config Viewer JavaScript - API REST Version

console.log('VyOS Config Viewer JS loaded (API REST version)');

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
const sections = ['Firewall', 'NAT'];

// Estado de conexión activa (para operaciones de escritura)
let isConnected = false;
let hasUnsavedChanges = false;
let verboseMode = false;
let pendingCommandExecution = null; // Stores pending command data for verbose mode

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
    Firewall: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    NAT: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>'
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

  if (sec === 'Firewall') {
    updateBreadcrumb([{ label: 'Firewall', action: "loadSection('Firewall')" }]);
    return loadFirewall();
  }
  if (sec === 'NAT') {
    updateBreadcrumb([{ label: 'NAT', action: "loadSection('NAT')" }]);
    return loadNat();
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
      html += `<tr>
        <td><span class="badge">${id}</span></td>
        ${cols.map(c => `<td>${escapeHtml(get(r, c.key))}</td>`).join('')}
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
    await Promise.all([...refs].map(async ref => {
      const [type, name] = ref.split('|');
      const key = `${type}-${name}`;
      const r = await fetch(`/api/firewall/group/${type}/${name}`);
      const obj = await r.json();
      if (type === 'address') groupCache[key] = obj.address;
      if (type === 'network') groupCache[key] = obj.network;
      if (type === 'port') groupCache[key] = obj.port;
    }));

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

      html += `<tr id="row-${id}">
        <td><span class="badge">${row.rule_id}</span></td>
        <td>${cellHTML(r.source, 'address', 'network')}</td>
        <td class="font-mono text-sm">${cellHTML(r.source, 'port')}</td>
        <td>${cellHTML(r.destination, 'address', 'network')}</td>
        <td class="font-mono text-sm">${cellHTML(r.destination, 'port')}</td>
        <td><span class="badge">${row.protocol}</span></td>
        <td><span class="action-badge ${actionClass}">${row.action}</span></td>
        <td class="text-muted">${escapeHtml(row.description)}</td>
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

function openFetchModal() {
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
                <input type="text" id="fw_port" placeholder="443" value="443" />
              </div>
            </div>
            <div class="modal-form-group">
              <label class="modal-form-label">API Key <span class="required">*</span></label>
              <input type="password" id="fw_api_key" placeholder="Your VyOS API key" />
              <span class="modal-form-hint">Configure with: set service https api keys id APP key 'YOUR-KEY'</span>
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
  const port = parseInt(document.getElementById('fw_port').value, 10) || 443;
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
    // Show Save button and Verbose toggle when connected
    document.getElementById('saveConfigBtn')?.classList.remove('hidden');
    document.getElementById('verboseToggle')?.classList.remove('hidden');
    document.getElementById('verboseDivider')?.classList.remove('hidden');
    drawMenu();
    renderDashboard();
    showToast('success', 'Connected', `Successfully fetched config from ${host}`);
  } catch (e) {
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
const STATIC_MODALS = ['shortcutsModal', 'confirmModal', 'firewallRuleModal', 'natRuleModal', 'commandPreviewModal'];

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

  currentSection = null;
  currentRulesetName = null;
  drawMenu();
  updateBreadcrumb([]);

  const fwRulesets = (CONFIG.firewall && CONFIG.firewall.name) ? CONFIG.firewall.name : {};
  let totalFwRules = 0;
  const fwStats = {};

  for (const [name, data] of Object.entries(fwRulesets)) {
    const count = data && data.rule ? Object.keys(data.rule).length : 0;
    fwStats[name] = count;
    totalFwRules += count;
  }

  let snatCount = 0;
  let dnatCount = 0;
  if (CONFIG.nat) {
    if (CONFIG.nat.source && CONFIG.nat.source.rule) {
      snatCount = Object.keys(CONFIG.nat.source.rule).length;
    }
    if (CONFIG.nat.destination && CONFIG.nat.destination.rule) {
      dnatCount = Object.keys(CONFIG.nat.destination.rule).length;
    }
  }

  const hasFwData = Object.keys(fwStats).length > 0;
  const hasNatData = snatCount > 0 || dnatCount > 0;

  const html = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-value">${Object.keys(fwStats).length}</div>
          <div class="stat-label">Firewall Rulesets</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background-color: var(--success-light); color: var(--success-color);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-value">${totalFwRules}</div>
          <div class="stat-label">Total Firewall Rules</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background-color: var(--warning-light); color: var(--warning-color);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
            <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
          </svg>
        </div>
        <div class="stat-content">
          <div class="stat-value">${snatCount + dnatCount}</div>
          <div class="stat-label">NAT Rules</div>
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

function populateGroupSelectors() {
  const groups = CONFIG?.firewall?.group || {};
  const addrGroups = Object.keys(groups['address-group'] || {});
  const netGroups = Object.keys(groups['network-group'] || {});
  const portGroups = Object.keys(groups['port-group'] || {});

  // Address groups
  ['fwRuleSrcAddrGroup', 'fwRuleDstAddrGroup'].forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = '<option value="">--</option>';
    addrGroups.forEach(g => { sel.innerHTML += `<option value="${g}">${g}</option>`; });
  });

  // Network groups (separate from address groups)
  ['fwRuleSrcNetGroup', 'fwRuleDstNetGroup'].forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = '<option value="">--</option>';
    netGroups.forEach(g => { sel.innerHTML += `<option value="${g}">${g}</option>`; });
  });

  // Port groups
  ['fwRuleSrcPortGroup', 'fwRuleDstPortGroup'].forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = '<option value="">--</option>';
    portGroups.forEach(g => { sel.innerHTML += `<option value="${g}">${g}</option>`; });
  });
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
  populateRulesetSelector('fwRuleRuleset', rulesetName || currentRulesetName);
  populateGroupSelectors();

  // Reset jump target visibility
  document.getElementById('fwJumpTargetGroup').classList.add('hidden');

  if (mode === 'edit' && rulesetName && ruleId) {
    document.getElementById('firewallRuleTitle').textContent = `Edit Rule ${ruleId}`;
    const rule = CONFIG?.firewall?.name?.[rulesetName]?.rule?.[ruleId];
    if (rule) {
      document.getElementById('fwRuleId').value = ruleId;
      document.getElementById('fwRuleAction').value = rule.action || 'accept';
      document.getElementById('fwRuleProtocol').value = rule.protocol || '';
      document.getElementById('fwRuleDescription').value = rule.description || '';
      document.getElementById('fwRuleSrcAddress').value = rule.source?.address || '';
      document.getElementById('fwRuleSrcPort').value = rule.source?.port || '';
      document.getElementById('fwRuleDstAddress').value = rule.destination?.address || '';
      document.getElementById('fwRuleDstPort').value = rule.destination?.port || '';
      // Groups - separate address-group and network-group
      document.getElementById('fwRuleSrcAddrGroup').value = rule.source?.group?.['address-group'] || '';
      document.getElementById('fwRuleSrcNetGroup').value = rule.source?.group?.['network-group'] || '';
      document.getElementById('fwRuleSrcPortGroup').value = rule.source?.group?.['port-group'] || '';
      document.getElementById('fwRuleDstAddrGroup').value = rule.destination?.group?.['address-group'] || '';
      document.getElementById('fwRuleDstNetGroup').value = rule.destination?.group?.['network-group'] || '';
      document.getElementById('fwRuleDstPortGroup').value = rule.destination?.group?.['port-group'] || '';
      // Jump target
      if (rule.action === 'jump' && rule['jump-target']) {
        toggleJumpTarget();
        document.getElementById('fwRuleJumpTarget').value = rule['jump-target'];
      }
    }
  } else {
    document.getElementById('firewallRuleTitle').textContent = 'New Firewall Rule';
    document.getElementById('fwRuleId').value = '';
  }
  openModal('firewallRuleModal');
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

  // Actual execution function
  const doSave = async () => {
    closeModal('firewallRuleModal');
    try {
      showLoading('Applying rule...');
      const res = await fetch('/api/firewall/rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleset, rule_id: ruleId, rule: ruleData })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save rule');

      showToast('success', 'Rule Saved', `Rule ${ruleId} saved successfully`);
      hasUnsavedChanges = true;
      updateSaveIndicator();
      await reloadConfig();
      viewRuleset(ruleset);
    } catch (e) {
      showToast('error', 'Error', e.message);
      content.innerHTML = '';
      viewRuleset(ruleset);
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    const commands = buildFirewallCommands(ruleset, ruleId, ruleData);
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

  // Actual execution function
  const doDelete = async () => {
    try {
      showLoading('Deleting rule...');
      const res = await fetch('/api/firewall/rule', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleset: rulesetName, rule_id: ruleId })
      });
      if (!res.ok) throw new Error((await res.json()).error);

      showToast('success', 'Rule Deleted', `Rule ${ruleId} deleted successfully`);
      hasUnsavedChanges = true;
      updateSaveIndicator();
      await reloadConfig();
      viewRuleset(rulesetName);
    } catch (e) {
      showToast('error', 'Error', e.message);
      viewRuleset(rulesetName);
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    const commands = buildDeleteCommand('firewall', rulesetName, ruleId);
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

  if (mode === 'edit' && ruleId) {
    document.getElementById('natRuleTitle').textContent = `Edit NAT Rule ${ruleId}`;
    const rule = CONFIG?.nat?.[natType]?.rule?.[ruleId];
    if (rule) {
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

  // Actual execution function
  const doSave = async () => {
    closeModal('natRuleModal');
    try {
      showLoading('Applying NAT rule...');
      const res = await fetch('/api/nat/rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nat_type: natType, rule_id: ruleId, rule: ruleData })
      });
      if (!res.ok) throw new Error((await res.json()).error);

      showToast('success', 'NAT Rule Saved', `NAT rule ${ruleId} saved successfully`);
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
      showToast('error', 'Error', e.message);
      loadNat();
    }
  };

  // If verbose mode is enabled, show preview first
  if (verboseMode) {
    const commands = buildNatCommands(natType, ruleId, ruleData);
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

  // Actual execution function
  const doDelete = async () => {
    try {
      showLoading('Deleting NAT rule...');
      const res = await fetch('/api/nat/rule', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nat_type: natType, rule_id: ruleId })
      });
      if (!res.ok) throw new Error((await res.json()).error);

      showToast('success', 'NAT Rule Deleted', `NAT rule ${ruleId} deleted successfully`);
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
      showToast('error', 'Error', e.message);
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
  const confirmed = await openConfirmModal('Save Configuration', 'Save the current configuration to the router? This will execute "save" on VyOS.');
  if (!confirmed) return;

  try {
    showLoading('Saving to router...');
    const res = await fetch('/api/save-config', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error);

    showToast('success', 'Configuration Saved', 'Configuration saved to the router successfully');
    hasUnsavedChanges = false;
    updateSaveIndicator();
  } catch (e) {
    showToast('error', 'Error', e.message);
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
});

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
    case 'f':
      if (CONFIG) loadSection('Firewall');
      break;
    case 'n':
      if (CONFIG) loadSection('NAT');
      break;
    case 's':
      if (currentRulesetName) openSearchModal();
      break;
    case 'r':
      if (currentRulesetName) {
        showResolved = !showResolved;
        renderRuleset();
      }
      break;
  }
});

// =========================================
// INITIALIZATION
// =========================================
console.log('VyOS Config Viewer initialized (API REST version)');
