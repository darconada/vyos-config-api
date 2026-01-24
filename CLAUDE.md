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

---

<claude-mem-context>
# Recent Activity

<!-- This section is auto-generated by claude-mem. Edit content outside the tags. -->

*No recent activity*
</claude-mem-context>