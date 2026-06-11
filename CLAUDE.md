# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VyOS Config Viewer API is a Flask-based web application that provides a visual interface for viewing and managing VyOS router configurations. It uses the official VyOS REST API (1.4+) instead of SSH for both reading and writing configurations.

### Core Capabilities
- Upload VyOS config JSON files or fetch directly from VyOS router via REST API
- View and filter firewall rulesets with group expansion
- View and filter NAT rules (destination and source)
- Search for traffic flows through firewall rules
- Resolve firewall groups (address-group, network-group, port-group) inline or via modal
- **Create, modify, and delete firewall rules** (via API)
- **Create, modify, and delete NAT rules** (via API)
- **Create, modify, and delete firewall groups** (via API)
- **Create and delete static routes** with VRF support (via API)
- **Create and delete BGP neighbors and networks** (via API)
- **View interfaces** with subinterfaces (vif) and VRF assignments
- **Dashboard** with configuration statistics
- **Global search** across all configuration sections
- **Save configuration to router** (via API)

## Development Commands

### Running the Application
```bash
python app.py
# Server runs on http://0.0.0.0:5000
```

### Install Dependencies
```bash
pip install -r requirements.txt
```

## Architecture

### VyOS REST API Client (vyos_api.py)
Complete client for VyOS 1.4+ REST API:

- **Authentication**: API key sent in POST form data
- **Read operations**: `get_config()`, `get_firewall()`, `get_nat()`, `get_firewall_group()`
- **Write operations**: `create_firewall_rule()`, `delete_firewall_rule()`, `create_nat_rule()`, `delete_nat_rule()`
- **System operations**: `save_config()`, `load_config()`

### Version Compatibility Layer (app.py:18-57)
The application handles two VyOS config formats through an adapter pattern:

- **VyOS 1.3**: Config JSON is used as-is (firewall.name structure)
- **VyOS 1.4**: Detected by presence of `firewall.ipv4` structure. The `adapt_14()` function transforms it to match 1.3 format
  - Translates `firewall.ipv4.name.*.rule` → `firewall.name.*.rule`
  - Copies `firewall.group` and `nat` sections unchanged

### Backend Structure (app.py)
- **Global state**: `CONFIG` stores parsed configuration, `ACTIVE_API` stores active connection
- **Upload flow**: `/upload` endpoint → `load_config()` → version detection → adapter
- **API fetch flow**: `/fetch-config` endpoint → VyOSAPI client → `get_config()` → `load_config()`

### API Endpoints

**Read endpoints:**
- `/api/firewall/rulesets` - Lists all firewall rule-set names
- `/api/firewall/ruleset/<rs>` - Returns rules for specific rule-set
- `/api/firewall/group/<gtype>/<gname>` - Returns group contents
- `/api/<section>` - Returns any config section
- `/api/NAT` - Returns both destination and source NAT rules

**Write endpoints:**
- `POST /api/firewall/rule` - Create/modify firewall rule
- `DELETE /api/firewall/rule` - Delete firewall rule
- `POST /api/nat/rule` - Create/modify NAT rule
- `DELETE /api/nat/rule` - Delete NAT rule
- `POST /api/save-config` - Save configuration to router

### Frontend Architecture (static/app.js)

#### State Management
- `CONFIG` (backend): Global parsed config
- `ACTIVE_API` (backend): Active VyOS API connection
- `isConnected`: Frontend connection state
- `currentRulesetName`, `currentRulesetData`: Active firewall rule-set
- `groupCache`: Preloaded firewall groups for current rule-set

#### Connection Modal
- Requests: Host, Port (default 8443), API Key
- Uses `/fetch-config` endpoint with JSON body

## VyOS API Configuration

### VyOS 1.4 (sagitta)
```vyos
configure
set service https port 8443
set service https api keys id viewer key 'your-api-key'
commit
save
```

### VyOS latest/rolling
```vyos
configure
set service https port 8443
set service https api keys id viewer key 'your-api-key'
set service https api rest
commit
save
```

### Optional: Restrict by IP
```vyos
set service https allow-client address 192.168.1.0/24
```

### Optional: Use specific VRF
```vyos
set service https vrf Management
```

## File Structure
```
vyos-config-viewer-api/
├── app.py              # Flask backend with API endpoints
├── vyos_api.py         # VyOS REST API client
├── requirements.txt    # Flask>=2.2.5, requests>=2.28.0
├── templates/
│   └── index.html      # HTML shell with API key form
└── static/
    ├── app.js          # All UI logic, API connection
    ├── style.css       # Main styles
    └── modal.css       # Modal styles
```

## Key Differences from SSH Version

| Aspect | SSH Version | API REST Version |
|--------|-------------|------------------|
| Connection | paramiko SSH | requests HTTPS |
| Authentication | Password/SSH key | API key |
| Read config | `show configuration \| json` | POST `/retrieve` |
| Write config | Not supported | POST `/configure` |
| Save config | Not supported | POST `/config-file` |
| Dependencies | paramiko | requests |

## Common Development Patterns

### Adding Write Functionality for a New Entity
1. Add helper method in `vyos_api.py` (e.g., `create_X()`, `delete_X()`)
2. Add Flask endpoint in `app.py`
3. Add UI controls in `app.js`

### Testing API Connection
```bash
curl -k --location --request POST 'https://ROUTER:8443/retrieve' \
  --form data='{"op": "showConfig", "path": []}' \
  --form key='your-api-key'
```


## Current State (Jan 24, 2026)

### Recently Implemented Features

**CRUD UI for Firewall and NAT Rules:**
- Modals for create/edit firewall rules and NAT rules
- Draggable modals (click header to move)
- Support for all VyOS 1.4 actions: accept, drop, reject, return, continue, jump, queue
- Support for jump-target when action is "jump"
- Separate handling for address-group vs network-group
- NAT exclude option (for VPN/IPsec traffic bypass)

**Verbose Mode:**
- Toggle switch in header to preview commands before execution
- Shows exact VyOS commands that will be applied
- Draggable preview modal

**UX Improvements:**
- Modal closes immediately on save, shows loading overlay (consistent with delete)
- Loading messages say "Applying..." instead of "Saving..." (Save is only for router config save)
- Extended API timeouts (60s default, 120s for configure operations)

### Files Modified
- `vyos_api.py` - API client with jump-target and NAT exclude support
- `templates/index.html` - Modals with draggable support, verbose toggle, NAT exclude checkbox, staged mode toggle
- `static/app.js` - CRUD functions, verbose mode, draggable modals, staged mode, differential updates
- `static/modal.css` - Styles for forms, checkboxes, draggable modals, pending change indicators

**Staged Mode (Batch Changes):**
- Toggle switch in header to enable staged mode
- Changes queue locally instead of immediate commit
- Visual markers for pending changes (MOD/DEL badges, colored rows)
- In-memory preview of changes before applying
- "Apply All" button commits all changes in one batch via `/api/batch-configure`
- "Discard" button reverts all pending changes
- Warning when closing page with unsaved pending changes

**Differential Updates:**
- When editing existing rules, only changed fields are sent to VyOS
- Deep comparison between original and modified rule state
- Generates minimal set/delete operations
- Verbose mode shows only the differential commands when editing
- Works in both immediate and staged modes

### API Endpoints (Batch Operations)
- `POST /api/batch-configure` - Apply multiple operations in one call
  - Accepts array of operations with type, action, and data
  - Supports differential updates via `diff` parameter
  - Returns count of applied operations

**Activity Log:**
- New "Activity" section in navigation menu (alongside Firewall and NAT)
- Tracks all operations performed during the session
- Each log entry contains: timestamp, type, action, target, status, message, VyOS commands
- Expandable command details (click to show/hide)
- Clear log button with confirmation
- Session-only persistence (in-memory, clears on page reload)

**Logged Operations:**
- Router connection (success/failure)
- Firewall rule create/update/delete
- NAT rule create/update/delete
- Staged operations (when changes are queued)
- Revert detection (when rule returns to original state)
- Batch apply (when applying all staged changes)
- Config save to router
- Discard pending changes

### Frontend State (Activity Log)
```javascript
let activityLog = [];           // Array of log entries
let activityLogIdCounter = 0;   // Auto-increment ID for entries
// Entry structure: { id, timestamp, type, action, target, status, message, commands }
```

**Firewall Groups Management:**
- New "Groups" section in navigation menu (alongside Firewall, NAT, Activity)
- Supports three group types: address-group, network-group, port-group
- Full CRUD operations: create, view, edit, delete groups
- Entry validation with format-specific patterns (IP, CIDR, ports)
- Usage checking before delete (prevents deleting groups used by rules)
- Integrated with staged mode, verbose mode, and activity log
- Keyboard shortcut: `g` to navigate to Groups section

### API Endpoints (Firewall Groups)
- `GET /api/firewall/groups` - List all firewall groups
- `GET /api/firewall/group-usage/<gtype>/<gname>` - Find rules using a group
- `POST /api/firewall/group` - Create or update a group (supports diff)
- `DELETE /api/firewall/group` - Delete a group

### Frontend State (Groups)
```javascript
let groupsData = null;              // Cached groups from API
let groupModalEntries = [];         // Current entries in modal
let groupOriginalEntries = [];      // Original entries for diff calculation
let groupOriginalDescription = null; // Original description for diff
```

**Dashboard:**
- Statistics cards showing counts for all configuration sections
- Clickable cards that navigate to respective sections
- Router hostname display
- Responsive grid layout
- Keyboard shortcut: `d` to navigate to Dashboard

**Interfaces View (Read-Only):**
- Displays all interface types: ethernet, bonding, bridge, vlan, loopback, wireguard, openvpn, tunnel, dummy, vti, pppoe
- Grouped by interface type with collapsible sections
- Shows subinterfaces (vif/VLAN) nested under parent interfaces
- VRF column showing which VRF each interface belongs to
- Displays address, description, and type-specific details (hw-id, mode, members, etc.)
- Keyboard shortcut: `i` to navigate to Interfaces

### API Endpoints (Interfaces & VRFs)
- `GET /api/interfaces` - Returns all interfaces configuration
- `GET /api/vrfs` - Returns list of configured VRF names

**Global Search:**
- Search input accessible via `/` keyboard shortcut
- Searches across: Firewall rules, NAT rules, Groups, Interfaces, Routes, BGP
- Results dropdown grouped by section
- Click result to navigate to corresponding section

**Static Routes (CRUD):**
- Full CRUD for static routes with VRF support
- Supports route types: next-hop, blackhole, interface
- Optional administrative distance
- VRF selector in create modal (lists all configured VRFs)
- Verbose mode shows command preview before execution
- Integrated with staged mode and activity log
- Keyboard shortcut: `r` to navigate to Routes

### API Endpoints (Static Routes)
- `GET /api/static-routes` - Returns routes from default VRF and all named VRFs
  - Response format: `{ default: {...}, vrfs: { vrf_name: {...} } }`
- `POST /api/static-route` - Create static route (supports `vrf` parameter)
- `DELETE /api/static-route` - Delete static route (supports `vrf` parameter)

**BGP Configuration (CRUD):**
- System AS configuration
- Neighbors management (remote-as, description, update-source, ebgp-multihop)
- Address-family settings (IPv4 unicast, soft-reconfiguration, route-maps)
- Networks management (advertised prefixes)
- Integrated with staged mode, verbose mode, and activity log
- Keyboard shortcut: `b` to navigate to BGP

### API Endpoints (BGP)
- `GET /api/bgp` - Returns full BGP configuration
- `POST /api/bgp/neighbor` - Create/update BGP neighbor
- `DELETE /api/bgp/neighbor` - Delete BGP neighbor
- `POST /api/bgp/network` - Add advertised network
- `DELETE /api/bgp/network` - Remove advertised network
- `POST /api/bgp/system-as` - Configure local AS number

### Navigation & Keyboard Shortcuts
```javascript
const sections = ['Dashboard', 'Firewall', 'NAT', 'Groups', 'Interfaces', 'Routes', 'BGP', 'Activity'];
```

| Key | Action |
|-----|--------|
| `d` | Dashboard |
| `f` | Firewall |
| `n` | NAT |
| `g` | Groups |
| `i` | Interfaces |
| `r` | Routes |
| `b` | BGP |
| `a` | Activity |
| `/` | Global Search |

### Version Compatibility (adapt_14)
The `adapt_14()` function now copies the following sections from VyOS 1.4 config:
- `firewall` (with ipv4.name transformation)
- `nat`
- `system`
- `service`
- `protocols`
- `policy`
- `interfaces`
- `vrf`
- `high-availability` (added for HA cluster detection)

---

**Rule Enable / Disable (Firewall + NAT):**
- Per-rule toggle button (power icon) between Edit and Delete in the firewall and NAT tables.
- "Disable rule" checkbox in the create/edit modals.
- Backend: `disable` is treated as a VyOS boolean flag (added to `_VYOS_BOOLEAN_FLAGS` in `app.py`).
- Re-enabling sends a `delete .../disable` op in a diff-style POST (no whole-rule rewrite).
- Disabled rows are dimmed, line-through, with an `OFF` badge near the rule ID.
- Respects staged mode and verbose mode, like the other write actions.

**Cluster latency reduction (May 2026):**
- `fetch-peer` requests only `['system','host-name']` to validate the peer; it no longer downloads the full peer config. Drops the connect-peer step from ~1 min to ~1 s on big routers like `es-por-ded2-cgw01-01`. `sess['peer_config']` is populated by the first `runSyncCheck()` that the frontend auto-fires after a successful connect (cluster_sync_check refetches both nodes anyway).
- `cluster_sync_check` runs the two `get_config()` calls in parallel via `ThreadPoolExecutor`. Wall time = `max(t_primary, t_peer)` instead of the sum.
- Combined: on the largest in-use router (`es-por-ded2-cgw01-01`), the connect + first-sync-check chain dropped from ~3 min to ~45 s, and per the user this is now acceptable. No further optimisation planned — the remaining cost is VyOS-side JSON rendering of the config tree.

**Manual / forced cluster peer naming (Jun 2026):**
Some HA clusters don't follow the `-01/-02` hostname convention (e.g. `vyos-cb-lgr-dr-07` ↔ `-08`), so `detect_cluster` (regex `^(.+)-(01|02)$`) doesn't auto-detect them. Three ways to declare the peer now:
- **Connect dialog**: checkbox "Especificar peer del cluster manualmente" → sends `force_cluster` + `peer_name_override` to `/fetch-config`. Builds `cluster_info` even when auto-detection fails (skips the regex and the VRRP requirement).
- **Post-connect hint**: if no cluster is auto-detected but `high-availability.vrrp.group` exists, `/fetch-config` returns `cluster_hint:true`; the frontend shows a toast plus a persistent `HA? · SET PEER` badge in the header. Clicking it opens a modal that calls `POST /api/cluster/set-peer` to declare the peer and activate HA **without reconnecting**, then auto-connects the peer.
- **Peer fallback modal**: accepts `expected_name` so you can connect to a peer by IP whose `host-name` differs, without the `hostname_mismatch` warning firing falsely.

All manual paths set `peer_name_manual:true`. `_cluster_id_for` then derives the write-lock id from the sorted `{primary, peer}` pair (instead of the `-01/-02` base), so two operators entering the same cluster from opposite nodes still share one lock — provided both declare the peer manually.

New endpoint: `POST /api/cluster/set-peer` (`{peer_name}`) — declares the cluster peer on an already-open connection.

**Hardening round (Jun 2026):**
- **Dual-apply rollback is now real**: inverse ops are computed against the pre-apply
  cached state (`build_rollback_ops` + `_inverse_ops_for` + `_subtree_to_set_ops` in
  app.py). Value replacements restore the old value; deletes are re-created via the
  subtree serializer. If no safe inverse exists, rollback reports `unavailable` instead
  of doing something destructive. Write endpoints call `_set_audit` BEFORE
  `apply_ops_dual`, so failed/partial applies reach `logs/audit.jsonl` with status=error.
- **Per-session thread safety**: each USER_SESSIONS entry carries a `threading.RLock`
  (`_session_lock`); `apply_ops_dual` runs fully under it. Cache patches are
  copy-on-write (`_patch_cache_cow`): patch a deepcopy, swap the reference; readers
  never see a half-mutated tree.
- **False 409 fix**: `_deep_equal` treats `['x']` == `'x'` (VyOS single-value render);
  `_delete_op` collapses 1-element lists and handles string-leaf value deletion.
- **Symmetric pre-flight**: dual-apply pre-flight refetches primary AND peer in
  parallel (wall time unchanged vs the old peer-only fetch).
- **BGP is read-only** (decision): cluster nodes legitimately differ in BGP config
  (update-source, local IPs), so dual-apply would be wrong by design. Write endpoints
  removed; UI shows a read-only notice. BGP is edited on the router directly.
- **Per-tab sessions**: frontend sends `X-Tab-Id` (sessionStorage UUID) on same-origin
  fetches; backend keys USER_SESSIONS by `user::tab_id`. Each browser tab can connect
  to a different router. No header → legacy per-user key. Duplicated tabs share the
  original tab's connection (sessionStorage is copied on duplicate).
- **XSS hardening**: `showToast` escapes title/message; `jsArg()` helper for dynamic
  args inside inline `onclick` (escapeHtml(JSON.stringify())); breadcrumb is DOM-based
  with function actions; config-derived cells escaped; encodeURIComponent on fetch
  URLs built from router data.
- **Staged mode fixes**: delete of a staged-new rule/route cancels both ops (no more
  poisoned batches); lock loss reloads the current view (previews were stale); route
  pending markers unified to `route:vrf:network:target` and deduped; valueless flags
  (`{}` vs `true`) normalized in diffs (`normFlagValue`) so revert detection converges.

## Known improvements / future work

### Drag & drop rule reordering (Jun 2026 — implemented)
- See `docs/drag-and-drop-reorder.md`. Drag the rule-id badge to reorder within a
  ruleset: gap → midpoint id; no gap → minimal cascade (or temp-id swap); always a
  confirmation modal with shifted rules, group-name warnings and exact commands.
  Backend `POST /api/firewall/rules/move` re-validates the client plan step by step
  against a sequential simulation (a set onto an occupied id would MERGE silently in
  VyOS). Staged mode queues composite move ops; batch-configure simulates the batch
  sequentially so chained moves validate against the prior move's outcome.
  Insert above/below buttons precompute the gap id for new rules.
- `docs/firewall-field-gaps.md` — VyOS firewall matchers not yet in the modal
  (state, log, interfaces, negation, 1.4 hooks, IPv6...), prioritized. New modal
  fields MUST be added to `FW_FORM_FIELDS`/`NAT_FORM_FIELDS` in app.js.

### Renumber without field loss (Jun 2026 — implemented)
- Rule ID changes are recreated SERVER-SIDE from the raw config tree
  (`_build_renumber_ops` + `_subtree_to_set_ops`), preserving CLI-only fields
  (state, log...). Endpoints: `POST /api/firewall/rule/renumber`,
  `POST /api/nat/rule/renumber`; staged mode queues a composite `renumber` op
  resolved at Apply All time. Edits made in the same save travel as `diff`.
- Edit diffs are whitelisted to form-managed fields (`getFormRuleDiff`):
  previously a normal edit DELETED any CLI-only field of the rule because the
  diff compared the full config subtree against the form payload.
  See `docs/renumber-subtree-serializer.md`.

### HA cluster sync-check — further reductions (deferred)

The dual-apply write path still fetches the peer config a couple of times per write:

1. Pre-flight `PEER_API.get_config()` inside `apply_ops_dual` (before applying).
2. Refresh after applying (best-effort, partly avoided by `apply_ops_in_memory` when the patch can be applied locally).
3. Frontend `runSyncCheck(false)` after `clusterApplyFetch` — one more `PEER_API.get_config()` × 2 (paralelised since May 2026).

**Potential optimizations (not implemented — deferred by user):**
- Short TTL cache (~15-30s) on `PEER_CONFIG` so consecutive writes reuse the fetch.
- Drop the post-write `runSyncCheck` — a successful dual-apply implies sync.
- Reuse the pre-flight snapshot as "post state" until the next operation starts.

**Why deferred**: optimizations reduce coverage against a concurrent operator editing the peer mid-session. Current behavior trades extra HTTP calls for guaranteed freshness. The largest router in use (`es-por-ded2-cgw01-01`) is already inside acceptable timings after the May 2026 latency work, so further tuning is on hold.

**Escape hatches that already exist** (don't require code changes):
- Cluster Sync toggle OFF → no pre-flight, writes go only to primary.
- Not connecting the peer → no dual-apply at all, zero overhead.

---

<claude-mem-context>
# Recent Activity

<!-- This section is auto-generated by claude-mem. Edit content outside the tags. -->

*No recent activity*
</claude-mem-context>