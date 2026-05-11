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
- **Enable / disable rules**: per-row toggle button on firewall and NAT rule tables, plus a checkbox in the edit modal. A disabled rule stays in the config (`set ... rule N disable`) so traffic stops matching it without losing the definition. The UI dims and strikes through the row and shows an `OFF` badge.
- **Differential updates**: when editing, only changed fields are sent to VyOS.
- **Save to router**: runs `save` on VyOS so changes persist after reboot.

### HA Cluster (VyOS pairs)
- **Automatic cluster detection** at connect time using the naming convention `*-01` / `*-02` plus the presence of VRRP groups.
- **Fast peer connection** reusing the primary's API key; the connect call only requests `['system','host-name']` to validate the peer (instant even on large routers, where a full `get_config()` can take ~1 min). A fallback modal prompts for host / port / api-key if auto-connect fails.
- **Sync-check (parallel fetches)**: normalised deep comparison of firewall rules, firewall groups, NAT rules, and static routes (default + VRFs) between the two nodes. Both `get_config()` calls run concurrently via a `ThreadPoolExecutor`, so wall time is `max(t_primary, t_peer)` instead of the sum (≈ halves the time on large configs).
- **Dual-apply (parallel)**: writes go to primary and peer concurrently via a `ThreadPoolExecutor`, roughly halving wall time on large configs (1-2 min commits). Pre-flight sync-check still runs first. Four outcomes handled: both ok / primary only / peer only / both fail; partial successes trigger a rollback of the side that succeeded.
- **In-memory cache update**: after a successful apply the cached primary/peer config is patched in place from the ops list instead of refetching the full config (1-3 s saved per write on big configs). Falls back to a real fetch when the heuristic cannot apply the op safely.
- **Divergence modal** with per-section diffs, opened automatically when a dual-apply is blocked.
- **Cluster Sync toggle** in the header to temporarily disable dual-apply during single-node interventions. Writes go only to the primary, no pre-flight, and the HA badge shows a `SOLO` indicator.

### Multi-user
- **Per-user sessions**: each logged-in user keeps their own router connection, config snapshot, and cluster context. Two operators can work on different routers/clusters concurrently without stepping on each other.
- **Write lock per cluster**: only one writer at a time per cluster. A user with the lock can apply changes; everyone else sees a read-only banner. Locks are independent across clusters, so two users on different clusters never block each other.
- **Lock badge** in the header shows `Lock acquired @ <cluster>` (you), `Locked by <user> @ <cluster>` (someone else), or `Unlocked @ <cluster>` (free).
- **Idle-based force-take**: after 4 minutes of inactivity the badge offers a "force lock" button with confirm.
- **Pre-action gating**: opening any write modal (firewall rule, NAT rule, group, route, BGP) without holding the lock prompts you to acquire it instead of letting you fill the form for nothing.
- **Auto-release**: the lock is released on logout, on TTL expiry (5 min idle), and when the user reconnects to a different cluster.

### Audit & Workflow helpers
- **Persistent audit log**: every login, connect, lock acquire/release/force, write operation and config save is appended to `logs/audit.jsonl` with user, timestamp, target, status, cluster_id, applied nodes, and the exact VyOS commands. Rotates at 5 MB × 10 files.
- **Audit log viewer** under the "Activity" section in the side menu: filter by user, action prefix, or text search. Anyone logged in can read the full history; events are append-only (no clear-from-UI).
- **Staged mode**: queue multiple changes locally, apply them in a single batch; visual markers (MOD / DEL badges) show pending changes per rule.
- **Verbose mode**: preview the VyOS commands that will be executed before applying.
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
| GET    | `/api/connection-status`          | Connection + cluster state for the current user |
| GET    | `/api/cluster/status`             | Cluster info for the current user |
| GET    | `/api/cluster/sync-check`         | Compare primary vs peer; returns diffs |
| POST   | `/api/cluster/disconnect-peer`    | Drop the peer connection (single-node mode) |
| POST   | `/upload`                         | Load a VyOS JSON config from file |

### Lock & audit
| Method       | Endpoint | Description |
|--------------|----------|-------------|
| GET          | `/api/lock`                  | Current lock state for the user's active cluster |
| POST         | `/api/lock`                  | Acquire the lock (`{"force": true}` to take it from an idle holder) |
| POST         | `/api/lock/heartbeat`        | Refresh the holder's `last_seen` (frontend pings every 30 s) |
| DELETE       | `/api/lock`                  | Release the lock |
| GET          | `/api/audit`                 | Audit events with filters: `user`, `action` prefix, `since`, `q`, `limit` |
| GET          | `/api/audit/users`           | Distinct usernames seen in the audit log |
| GET          | `/api/audit/actions`         | Distinct action names seen in the audit log |

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
├── app.py              # Flask backend: endpoints, sessions, cluster logic, write lock
├── vyos_api.py         # VyOS REST API client (retrieve, configure, save)
├── auth.py             # LDAP authentication
├── audit_log.py        # Persistent audit log (JSONL with rotation)
├── requirements.txt    # Python dependencies
├── CLAUDE.md           # Developer notes / project state
├── config/
│   └── infra.yaml      # LDAP + VyOS defaults (gitignored)
├── logs/
│   └── audit.jsonl     # Audit events (gitignored, rotated at 5 MB × 10)
├── templates/
│   ├── index.html      # UI shell
│   └── login.html      # Login form
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
  with the REST API; review the audit log if a rollback is reported
  as failed.
- There is a small race window between the pre-flight sync-check and the
  apply. A concurrent operator editing the peer in that gap can cause
  drift. If this matters, coordinate changes or use the Cluster Sync
  toggle for explicit single-node interventions.
- The write lock is in-memory per backend process and resets on restart.
  All locks are released on graceful logout; orphaned locks (browser
  closed) auto-expire after 5 minutes of inactivity.
- The audit log is local to the backend host. For long-term retention
  copy `logs/audit.jsonl*` off the box periodically; the rotation policy
  keeps roughly 50 MB before the oldest entries are dropped.

## License

MIT License

## Contributing

Contributions are welcome; feel free to open an issue or pull request.
