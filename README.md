# VyOS Config Viewer API

Web UI for viewing and managing VyOS router configurations through the
official VyOS REST API: firewall, NAT, groups, interfaces, routing, and
HA cluster operations from a single place.

![Python](https://img.shields.io/badge/python-3.8+-blue.svg)
![Flask](https://img.shields.io/badge/flask-2.2+-green.svg)
![VyOS](https://img.shields.io/badge/VyOS-1.4+-orange.svg)

## Features

### Viewing
- **Dashboard** with counts of rulesets, rules, groups, interfaces, routes, and BGP state.
- **Firewall rulesets**: browse rules with inline or resolved group values, filter by field, IP-range searches.
- **NAT**: destination and source NAT with exclude rules for VPN/IPsec traffic.
- **Firewall groups**: address / network / port, with entry validation and usage checks before delete.
- **Interfaces** (read-only): ethernet, bonding, bridge, VLAN, loopback, WireGuard, OpenVPN, tunnel, dummy, VTI, PPPoE; with VRF assignment and sub-interfaces.
- **Static routes** across default and named VRFs.
- **BGP**: system AS, neighbors, advertised networks.
- **Global search** across all sections (firewall, NAT, groups, interfaces, routes, BGP).

### Managing
- **Full CRUD** on firewall rules, NAT rules, firewall groups, static routes, BGP neighbors and networks.
- **All VyOS 1.4 firewall actions**: accept, drop, reject, return, continue, jump, queue (including `jump-target`).
- **Differential updates**: when editing, only changed fields are sent to VyOS.
- **Save to router**: runs `save` on VyOS so changes persist after reboot.

### HA Cluster (VyOS pairs)
- **Automatic cluster detection** at connect time using the naming convention `*-01` / `*-02` plus the presence of VRRP groups.
- **Automatic peer connection** reusing the primary's API key; a fallback modal prompts for host / port / api-key if auto-connect fails.
- **Sync-check**: normalised deep comparison of firewall rules, firewall groups, NAT rules, and static routes (default + VRFs) between the two nodes.
- **Dual-apply**: every write goes to both nodes atomically after a pre-flight sync-check. If the peer fails mid-apply, a best-effort rollback is attempted on the primary.
- **Divergence modal** with per-section diffs, opened automatically when a dual-apply is blocked.
- **Cluster Sync toggle** in the header to temporarily disable dual-apply during single-node interventions. Writes go only to the primary, no pre-flight, and the HA badge shows a `SOLO` indicator.

### Workflow helpers
- **Staged mode**: queue multiple changes locally, apply them in a single batch; visual markers (MOD / DEL badges) show pending changes per rule.
- **Verbose mode**: preview the VyOS commands that will be executed before applying.
- **Activity log**: every action in the session is logged with timestamp, status, and the exact VyOS commands; dual-apply entries are suffixed with `[→ primary + peer]`.
- **Multiple themes**: light, dark, and retro.

## Requirements

- Python 3.8+
- VyOS 1.4+ with the HTTPS REST API enabled
- Modern web browser

## Installation

```bash
git clone https://github.com/darconada/vyos-config-api.git
cd vyos-config-api
pip install -r requirements.txt
python app.py
```

The server listens on `http://0.0.0.0:5001`.

## VyOS configuration

Enable the HTTPS API on your router. The app's connect modal defaults to
port `8443`.

### VyOS 1.4 (sagitta)
```
configure
set service https port 8443
set service https api keys id viewer key 'your-api-key'
commit
save
```

### VyOS rolling / latest
```
configure
set service https port 8443
set service https api keys id viewer key 'your-api-key'
set service https api rest
commit
save
```

### Optional: restrict by source IP / use management VRF
```
set service https allow-client address 192.168.1.0/24
set service https vrf mgmt
```

## Usage

1. Open `http://localhost:5001` in your browser.
2. Click **Connect** and enter host, port (`8443` by default), and API key.
3. Use the left-hand navigation to browse sections, or the keyboard shortcuts.
4. To edit, enable **Staged** mode if you want to review changes in batch, or apply immediately. Use **Verbose** mode to preview commands.
5. Click **Save** when done to persist the config to the router (runs `save` on VyOS).

### HA cluster workflow

- When you connect to a node whose hostname ends in `-01` or `-02` and that has VRRP groups configured, the app automatically tries to connect to the peer (`-02` ↔ `-01`) with the same API key.
- If auto-connect fails (DNS, different port, different key), a fallback modal appears with editable host / port / api-key.
- The **HA badge** in the header shows the current sync state:
  - `SYNC ✓` (green): both nodes identical; writes go to both.
  - `DIVERGED ✗` (red, pulsing): click to see the per-section diff; writes are blocked until divergence is resolved.
  - `PEER?` (amber): peer not connected yet; click to retry.
  - `· SOLO` suffix: Cluster Sync toggle is OFF; writes go only to the primary.
- Need to intervene on a single node only? Toggle **Cluster Sync** off in the header (or click "Aplicar solo al primary" in the divergence modal). The peer connection stays, but writes skip the pre-flight check and target the primary only.

### Keyboard shortcuts

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
| `/` | Global search |

## API endpoints

### Connection
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST   | `/fetch-config`                   | Connect to a VyOS router (primary) |
| POST   | `/fetch-peer`                     | Connect to the cluster peer (optional `host`, `port`, `api_key`) |
| GET    | `/api/connection-status`          | Connection + cluster state |
| GET    | `/api/cluster/status`             | Cluster info |
| GET    | `/api/cluster/sync-check`         | Compare primary vs peer; returns diffs |
| POST   | `/api/cluster/disconnect-peer`    | Drop the peer connection (single-node mode) |
| POST   | `/upload`                         | Load a VyOS JSON config from file |

### Read
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/dashboard-stats`                  | Counts for the dashboard |
| GET    | `/api/firewall/rulesets`                | List firewall rulesets |
| GET    | `/api/firewall/ruleset/<name>`          | Rules of a ruleset |
| GET    | `/api/firewall/groups`                  | All firewall groups |
| GET    | `/api/firewall/group/<type>/<name>`     | Contents of a group |
| GET    | `/api/firewall/group-usage/<type>/<name>` | Rules referencing a group |
| GET    | `/api/NAT`                              | Source + destination NAT |
| GET    | `/api/interfaces`                       | Interfaces config |
| GET    | `/api/vrfs`                             | Configured VRF names |
| GET    | `/api/static-routes`                    | Routes in default + named VRFs |
| GET    | `/api/bgp`                              | BGP configuration |

### Write (all accept `apply_to_peer: true|false` when in cluster)
| Method       | Endpoint | Description |
|--------------|----------|-------------|
| POST/DELETE  | `/api/firewall/rule`                    | Create / update / delete firewall rule |
| POST/DELETE  | `/api/firewall/group`                   | Create / update / delete group |
| POST/DELETE  | `/api/nat/rule`                         | Create / update / delete NAT rule |
| POST/DELETE  | `/api/static-route`                     | Create / delete static route (supports `vrf`) |
| POST/DELETE  | `/api/bgp/neighbor`                     | Manage BGP neighbor (single-node) |
| POST/DELETE  | `/api/bgp/network`                      | Manage advertised network (single-node) |
| POST         | `/api/bgp/system-as`                    | Set local AS (single-node) |
| POST         | `/api/batch-configure`                  | Apply a batch of operations (staged mode) |
| POST         | `/api/save-config`                      | Run `save` on VyOS (replicates to peer in cluster) |

> Note: BGP endpoints intentionally stay single-node because BGP state
> (router-id, neighbors) often differs legitimately between nodes of an
> active/passive cluster.

## File structure

```
vyos-config-api/
├── app.py              # Flask backend: endpoints, cluster logic, sync comparator
├── vyos_api.py         # VyOS REST API client (retrieve, configure, save)
├── requirements.txt    # Python dependencies
├── CLAUDE.md           # Developer notes / project state
├── templates/
│   └── index.html      # UI shell
└── static/
    ├── app.js          # Frontend logic
    ├── style.css       # Main styles
    └── modal.css       # Modal / forms styles
```

## Security notes

- The API key is transmitted over HTTPS; self-signed certificates are
  accepted to cope with the default VyOS setup.
- Restrict API access by source IP in VyOS (`set service https allow-client address …`).
- Don't expose this app to the public internet; it proxies write access
  to your routers.
- Dual-apply uses best-effort rollback on peer failure: if the peer
  apply fails, the app tries to reverse the primary operation with
  inverse `set`→`delete` operations. True two-phase commit isn't possible
  with the REST API; review the activity log if a rollback is reported
  as failed.
- There is a small race window between the pre-flight sync-check and the
  apply. A concurrent operator editing the peer in that gap can cause
  drift. If this matters, coordinate changes or use the Cluster Sync
  toggle for explicit single-node interventions.

## License

MIT License

## Contributing

Contributions are welcome; feel free to open an issue or pull request.
