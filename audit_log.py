"""
Persistent audit log for the VyOS Config Viewer.

Writes one JSON event per line to logs/audit.jsonl, rotating by size so the
file does not grow unbounded. Reading walks the active file plus the rotated
backups so the web view sees the full history.

Schema for each event:
  {
    "ts":     "2026-05-08T17:45:23Z",  // UTC ISO 8601
    "user":   "darconada",             // username (string)
    "action": "firewall.create",       // dotted action name
    "target": "WAN-IN/rule/100",       // human-readable target
    "status": "ok" | "error",
    "nodes":  ["primary", "peer"],     // optional
    "details": "..."                   // optional free text
    "commands": [...]                  // optional list of VyOS commands applied
  }
"""
import json
import os
import sys
import threading
from datetime import datetime, timezone

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
LOG_FILE = os.path.join(LOG_DIR, 'audit.jsonl')
MAX_BYTES = 5 * 1024 * 1024  # 5 MB por fichero
BACKUP_COUNT = 10            # hasta audit.jsonl.1 ... audit.jsonl.10

_lock = threading.Lock()


def _rotate_if_needed():
    """Rota audit.jsonl → audit.jsonl.1 si supera MAX_BYTES."""
    if not os.path.exists(LOG_FILE):
        return
    if os.path.getsize(LOG_FILE) < MAX_BYTES:
        return
    # Desplazar .N → .N+1, descartando el más antiguo.
    for i in range(BACKUP_COUNT - 1, 0, -1):
        src = f'{LOG_FILE}.{i}'
        dst = f'{LOG_FILE}.{i + 1}'
        if os.path.exists(src):
            try:
                if os.path.exists(dst):
                    os.remove(dst)
                os.rename(src, dst)
            except OSError:
                pass
    try:
        os.rename(LOG_FILE, f'{LOG_FILE}.1')
    except OSError:
        pass


def emit(user, action, target='', status='ok', nodes=None, details='',
         commands=None, cluster_id=None):
    """Escribe un evento al audit log. Best-effort: nunca lanza."""
    entry = {
        'ts': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'user': user or 'anonymous',
        'action': action or 'unknown',
        'target': target or '',
        'status': status or 'ok',
    }
    if cluster_id:
        entry['cluster_id'] = cluster_id
    if nodes:
        entry['nodes'] = list(nodes)
    if details:
        entry['details'] = details
    if commands:
        entry['commands'] = commands
    line = json.dumps(entry, ensure_ascii=False)
    with _lock:
        try:
            os.makedirs(LOG_DIR, exist_ok=True)
            _rotate_if_needed()
            with open(LOG_FILE, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except Exception as e:
            print(f'[audit] failed to write event: {e}', file=sys.stderr)


def _all_log_paths():
    """Lista de paths a leer: el activo más los backups, en orden recientes-primero."""
    paths = []
    if os.path.exists(LOG_FILE):
        paths.append(LOG_FILE)
    for i in range(1, BACKUP_COUNT + 1):
        p = f'{LOG_FILE}.{i}'
        if os.path.exists(p):
            paths.append(p)
    return paths


def _iter_entries():
    """Itera todos los eventos de todos los ficheros (orden indeterminado)."""
    for path in _all_log_paths():
        try:
            with open(path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue


def read_entries(user=None, action=None, since=None, limit=200, q=None,
                 cluster_id=None):
    """Devuelve los últimos `limit` eventos que pasan los filtros, recientes primero.

    user: match exacto de username.
    action: prefijo (e.g. 'firewall' captura firewall.create, firewall.delete).
    since: timestamp ISO (string); solo eventos con ts >= since.
    q: búsqueda libre case-insensitive en target/details.
    cluster_id: match exacto del cluster_id.
    """
    out = []
    qlower = q.lower() if q else None
    for e in _iter_entries():
        if user and e.get('user') != user:
            continue
        if action and not e.get('action', '').startswith(action):
            continue
        if since and e.get('ts', '') < since:
            continue
        if cluster_id and e.get('cluster_id') != cluster_id:
            continue
        if qlower:
            blob = (e.get('target', '') + ' ' + e.get('details', '')).lower()
            if qlower not in blob:
                continue
        out.append(e)
    out.sort(key=lambda e: e.get('ts', ''), reverse=True)
    return out[:max(0, int(limit))]


def list_clusters():
    """Devuelve cluster_ids únicos vistos en los logs."""
    ids = set()
    for e in _iter_entries():
        c = e.get('cluster_id')
        if c:
            ids.add(c)
    return sorted(ids)


def list_users():
    users = set()
    for e in _iter_entries():
        u = e.get('user')
        if u:
            users.add(u)
    return sorted(users)


def list_actions():
    actions = set()
    for e in _iter_entries():
        a = e.get('action')
        if a:
            actions.add(a)
    return sorted(actions)
