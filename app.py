# app.py
"""
VyOS Config Viewer - API REST Version
Flask backend con conexión a VyOS via API REST oficial (1.4+)
"""
import os
import re
import sys
import time
import threading
import functools
import concurrent.futures
import secrets as _secrets
from flask import Flask, render_template, request, jsonify, redirect, session, url_for, g
import json
from vyos_api import VyOSAPI, VyOSAPIError
from auth import authenticate_with_ldap, login_required, load_vyos_defaults
import audit_log

app = Flask(__name__)

_session_secret = os.environ.get("VYOS_VIEWER_SESSION_SECRET")
if not _session_secret:
    _session_secret = _secrets.token_hex(32)
    print(
        "[warn] VYOS_VIEWER_SESSION_SECRET not set; using an ephemeral random key. "
        "Existing sessions will be invalidated on each restart.",
        file=sys.stderr,
    )
app.secret_key = _session_secret
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)

# ──────────────────────────────────────────────────────────────
#  Sesiones por usuario
# ──────────────────────────────────────────────────────────────
# Cada usuario logueado mantiene su propia conexión a un router (o cluster).
# Antes había globales (CONFIG, ACTIVE_API, ...) que se pisaban entre usuarios
# que conectaban a routers distintos; ahora viven aquí indexadas por username.
#
# Estructura por usuario:
#   {
#     'active_api':       VyOSAPI | None,    # cliente del primary
#     'peer_api':         VyOSAPI | None,    # cliente del peer (si en cluster)
#     'config':           dict | None,       # config interna (post adapt_14)
#     'raw_config':       dict | None,       # raw tal cual de la API
#     'peer_config':      dict | None,
#     'raw_peer_config':  dict | None,
#     'cluster_info':     dict | None,
#     'last_seen':        float (epoch),     # para purgar zombies
#   }
USER_SESSIONS = {}
_USER_SESSIONS_MUTEX = threading.Lock()
USER_SESSION_TTL = 1800  # 30 min sin actividad → la sesión se descarta


def _get_session(create=False):
    """Devuelve la sesión del usuario actual; crea vacía si create=True."""
    user = _current_user()
    if not user:
        return None
    with _USER_SESSIONS_MUTEX:
        sess = USER_SESSIONS.get(user)
        if sess is None and create:
            sess = USER_SESSIONS[user] = {}
        if sess is not None:
            sess['last_seen'] = time.time()
        return sess


def _purge_idle_sessions():
    """Limpia sesiones que no han recibido peticiones recientes."""
    now = time.time()
    with _USER_SESSIONS_MUTEX:
        for u in list(USER_SESSIONS.keys()):
            if now - USER_SESSIONS[u].get('last_seen', now) > USER_SESSION_TTL:
                USER_SESSIONS.pop(u, None)


def _cluster_id_for(sess):
    """Devuelve un identificador estable del cluster del usuario.

    En cluster HA: la base del hostname (ej. 'es-por-ded2-cgw01' a partir de
    'es-por-ded2-cgw01-01'). Compartido por -01 y -02 → un solo lock para
    los dos nodos. En single-node: el host del primary.
    """
    if not sess:
        return None
    info = sess.get('cluster_info')
    if info and info.get('detected'):
        pn = info.get('primary_name', '') or ''
        m = _CLUSTER_NAME_RE.match(pn)
        if m:
            return m.group(1)
        return pn or None
    api = sess.get('active_api')
    return getattr(api, 'host', None) if api else None


# ──────────────────────────────────────────────────────────────
#  Write-lock por cluster (un escritor a la vez por cluster)
# ──────────────────────────────────────────────────────────────
# Lock por cluster_id. Permite que dos usuarios trabajen en clusters distintos
# en paralelo sin pisarse. Tras WRITE_LOCK_TTL sin heartbeat se libera solo.
WRITE_LOCKS = {}  # cluster_id -> {'user', 'acquired_at', 'last_seen'}
_WRITE_LOCK_MUTEX = threading.Lock()
WRITE_LOCK_TTL = 300


def _lock_state_for(cluster_id):
    """Devuelve el estado del lock de `cluster_id` aplicando auto-expiración."""
    if not cluster_id:
        return None
    state = WRITE_LOCKS.get(cluster_id)
    if state is None:
        return None
    if time.time() - state['last_seen'] > WRITE_LOCK_TTL:
        WRITE_LOCKS.pop(cluster_id, None)
        return None
    return dict(state)


def _current_user():
    """Devuelve el username (string). session['user'] es un dict {'username': ...}."""
    raw = session.get('user')
    if isinstance(raw, dict):
        return raw.get('username') or ''
    return raw or ''


# ──────────────────────────────────────────────────────────────
#  Emisión automática del audit log para endpoints de escritura
# ──────────────────────────────────────────────────────────────
@app.before_request
def _audit_init():
    g.audit_action = None
    g.audit_target = None
    g.audit_nodes = None
    g.audit_commands = None
    g.audit_details = None
    g.audit_cluster_id = None
    # Aprovechamos esta hook para purgar sesiones zombies de forma perezosa.
    try:
        _purge_idle_sessions()
    except Exception:
        pass


@app.after_request
def _audit_emit(response):
    action = getattr(g, 'audit_action', None)
    if not action:
        return response
    target = getattr(g, 'audit_target', '') or ''
    nodes = getattr(g, 'audit_nodes', None)
    commands = getattr(g, 'audit_commands', None)
    details = getattr(g, 'audit_details', '') or ''
    cluster_id = getattr(g, 'audit_cluster_id', None)
    status = 'ok'
    if response.status_code >= 400:
        status = 'error'
        if not details:
            try:
                payload = response.get_json(silent=True) or {}
                details = payload.get('error', '') or ''
            except Exception:
                pass
    try:
        audit_log.emit(
            user=_current_user(),
            action=action,
            target=target,
            status=status,
            nodes=nodes,
            details=details,
            commands=commands,
            cluster_id=cluster_id,
        )
    except Exception as e:
        print(f'[audit] emit failed: {e}', file=sys.stderr)
    return response


def _set_audit(action, target='', nodes=None, commands=None):
    """Helper para llamar desde cada endpoint de escritura."""
    g.audit_action = action
    g.audit_target = target
    g.audit_nodes = nodes
    g.audit_commands = commands
    if not getattr(g, 'audit_cluster_id', None):
        sess = _get_session()
        g.audit_cluster_id = _cluster_id_for(sess) if sess else None


def write_lock_required(f):
    """Endpoint protegido: solo el dueño del lock del cluster activo puede invocarlo."""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        user = _current_user()
        sess = _get_session()
        cluster_id = _cluster_id_for(sess)
        if not cluster_id:
            return jsonify({
                'error': 'No active connection. Connect to a router first.',
                'lock': None, 'me': user, 'cluster_id': None,
            }), 423
        with _WRITE_LOCK_MUTEX:
            state = _lock_state_for(cluster_id)
            if state is None or state['user'] != user:
                return jsonify({
                    'error': 'Write lock required',
                    'lock': state,
                    'me': user,
                    'cluster_id': cluster_id,
                }), 423  # Locked
            WRITE_LOCKS[cluster_id]['last_seen'] = time.time()
        return f(*args, **kwargs)
    return wrapper


@app.route('/api/lock', methods=['GET'])
@login_required
def get_lock():
    sess = _get_session()
    cluster_id = _cluster_id_for(sess) if sess else None
    with _WRITE_LOCK_MUTEX:
        state = _lock_state_for(cluster_id) if cluster_id else None
    return jsonify({
        'lock': state,
        'me': _current_user(),
        'ttl': WRITE_LOCK_TTL,
        'cluster_id': cluster_id,
    })


@app.route('/api/lock', methods=['POST'])
@login_required
def acquire_lock():
    """Adquirir el lock del cluster activo. Si está libre o expirado lo toma.
    Si está ocupado por otro y `force=true`, lo roba."""
    sess = _get_session()
    cluster_id = _cluster_id_for(sess) if sess else None
    if not cluster_id:
        return jsonify({
            'error': 'No active connection. Connect to a router first.',
            'lock': None, 'me': _current_user(), 'cluster_id': None,
        }), 400
    body = request.get_json(silent=True) or {}
    force = bool(body.get('force'))
    user = _current_user()
    now = time.time()
    with _WRITE_LOCK_MUTEX:
        state = _lock_state_for(cluster_id)
        if state and state['user'] != user and not force:
            return jsonify({
                'error': 'Lock held by another user',
                'lock': state,
                'me': user,
                'cluster_id': cluster_id,
            }), 409
        WRITE_LOCKS[cluster_id] = {'user': user, 'acquired_at': now, 'last_seen': now}
        forced_from = state['user'] if (state and state['user'] != user) else None
    if forced_from:
        print(f'[lock] {user} forced lock on {cluster_id} from {forced_from}', file=sys.stderr)
        _set_audit('lock.force', target=f'{cluster_id} from={forced_from}')
    else:
        _set_audit('lock.acquire', target=cluster_id)
    return jsonify({
        'lock': WRITE_LOCKS[cluster_id], 'me': user,
        'cluster_id': cluster_id, 'forced_from': forced_from,
    })


@app.route('/api/lock/heartbeat', methods=['POST'])
@login_required
def heartbeat_lock():
    """Mantiene vivo el lock del dueño actual. 409 si lo perdió (TTL/forzado)."""
    sess = _get_session()
    cluster_id = _cluster_id_for(sess) if sess else None
    user = _current_user()
    if not cluster_id:
        return jsonify({'error': 'No active connection', 'lock': None,
                        'cluster_id': None}), 409
    with _WRITE_LOCK_MUTEX:
        state = _lock_state_for(cluster_id)
        if state and state['user'] == user:
            WRITE_LOCKS[cluster_id]['last_seen'] = time.time()
            return jsonify({'lock': WRITE_LOCKS[cluster_id], 'cluster_id': cluster_id})
    return jsonify({'error': 'Lock not held by you', 'lock': state,
                    'cluster_id': cluster_id}), 409


@app.route('/api/lock', methods=['DELETE'])
@login_required
def release_lock():
    sess = _get_session()
    cluster_id = _cluster_id_for(sess) if sess else None
    user = _current_user()
    released = False
    if cluster_id:
        with _WRITE_LOCK_MUTEX:
            state = WRITE_LOCKS.get(cluster_id)
            if state and state['user'] == user:
                WRITE_LOCKS.pop(cluster_id, None)
                released = True
    if released:
        _set_audit('lock.release', target=cluster_id)
    return jsonify({'lock': None, 'me': user, 'cluster_id': cluster_id})


# ──────────────────────────────────────────────────────────────
#  Audit log (vista web persistente compartida)
# ──────────────────────────────────────────────────────────────
@app.route('/api/audit')
@login_required
def audit_list():
    """Devuelve eventos del audit, recientes primero, con filtros opcionales."""
    user = (request.args.get('user') or '').strip() or None
    action = (request.args.get('action') or '').strip() or None
    since = (request.args.get('since') or '').strip() or None
    q = (request.args.get('q') or '').strip() or None
    try:
        limit = int(request.args.get('limit', 200))
    except (TypeError, ValueError):
        limit = 200
    limit = max(1, min(limit, 2000))
    try:
        entries = audit_log.read_entries(user=user, action=action, since=since,
                                         limit=limit, q=q)
    except Exception as e:
        return jsonify({'error': f'Audit read failed: {e}', 'entries': []}), 500
    return jsonify({'entries': entries, 'count': len(entries)})


@app.route('/api/audit/users')
@login_required
def audit_users():
    return jsonify({'users': audit_log.list_users()})


@app.route('/api/audit/actions')
@login_required
def audit_actions():
    return jsonify({'actions': audit_log.list_actions()})


# ──────────────────────────────────────────────────────────────
#  Adaptador VyOS 1.4 → formato interno (igual que 1.3)
# ──────────────────────────────────────────────────────────────
def adapt_14(raw14):
    """
    Convierte el JSON de VyOS 1.4 al mismo esquema que usa la UI (1.3).
    Solo adaptamos lo que hoy consume la interfaz: firewall y nat.
    """
    cfg = {
        # En 1.3 teníamos firewall.name y firewall.group; recreamos ambos
        "firewall": {
            "name":  {},                                       # se rellena abajo
            "group": raw14.get("firewall", {}).get("group", {})# ← copia grupos
        },
        # NAT mantiene la misma forma entre 1.3 y 1.4
        "nat":  raw14.get("nat", {}),

        # Copiamos el resto tal cual (por si la UI los usa)
        "system":            raw14.get("system",            {}),
        "service":           raw14.get("service",           {}),
        "protocols":         raw14.get("protocols",         {}),
        "policy":            raw14.get("policy",            {}),
        "interfaces":        raw14.get("interfaces",        {}),
        "vrf":               raw14.get("vrf",               {}),
        "high-availability": raw14.get("high-availability", {})
    }

    # —— trasladamos los rule-sets IPv4 (firewall.ipv4.name.*.rule) ——
    fw14 = raw14.get("firewall", {}).get("ipv4", {})
    for rs_name, rs_data in fw14.get("name", {}).items():
        cfg["firewall"]["name"][rs_name] = {
            "default-action": rs_data.get("default-action"),
            "rule": rs_data.get("rule", {})
        }

    # (Si quisieras IPv6, repite lo mismo para firewall.ipv6.name.*)
    return cfg


# ──────────────────────────────────────────────────────────────
#  Detección de cluster HA
# ──────────────────────────────────────────────────────────────
# Convención: los nodos del cluster tienen el mismo nombre base
# terminado en "-01" o "-02". p.ej. es-por-lab-sfw01-01 ↔ …-02.
_CLUSTER_NAME_RE = re.compile(r'^(.+)-(01|02)$')


def derive_peer_name(hostname):
    """Dado un hostname '…-01' o '…-02', devuelve el gemelo o None."""
    m = _CLUSTER_NAME_RE.match(hostname or '')
    if not m:
        return None
    base, suffix = m.group(1), m.group(2)
    twin = '02' if suffix == '01' else '01'
    return f'{base}-{twin}'


def detect_cluster(cfg):
    """
    Analiza la config para determinar si este nodo forma parte de un cluster HA.

    Criterios:
    - system.host-name termina en -01 o -02
    - high-availability.vrrp.group.* está presente y no vacío

    Returns: dict con {detected, primary_name, peer_name} o None.
    """
    if not cfg:
        return None
    hostname = cfg.get('system', {}).get('host-name')
    peer_name = derive_peer_name(hostname)
    if not peer_name:
        return None
    vrrp_groups = (cfg.get('high-availability', {})
                       .get('vrrp', {})
                       .get('group', {}))
    if not vrrp_groups:
        return None
    return {
        'detected': True,
        'primary_name': hostname,
        'peer_name': peer_name
    }


def load_config(raw):
    """Detecta versión y devuelve el formato interno unificado."""
    if "firewall" in raw and "ipv4" in raw["firewall"]:
        # Detectamos que es 1.4 (tiene firewall.ipv4)
        return adapt_14(raw)
    # Caso 1.3 u "antiguo": ya está en formato interno
    return raw


# ──────────────────────────────────────────────────────────────
#  Autenticación (LDAP corporativo)
# ──────────────────────────────────────────────────────────────
@app.route('/login', methods=['GET'])
def login_form():
    if session.get('user'):
        return redirect(url_for('index'))
    return render_template('login.html', error=None, username='')


@app.route('/login', methods=['POST'])
def login_submit():
    username = (request.form.get('username') or '').strip()
    password = request.form.get('password') or ''

    if not username or not password:
        return render_template(
            'login.html',
            error='Introduce usuario y contrasena.',
            username=username,
        ), 400

    try:
        ok = authenticate_with_ldap(username, password)
    except Exception as e:
        print(f"[error] LDAP auth failure: {e}", file=sys.stderr)
        # Forzamos el user en g porque session['user'] aún no existe.
        audit_log.emit(user=username, action='login', target=username,
                       status='error', details='LDAP service unreachable')
        return render_template(
            'login.html',
            error='Error contactando con el servicio de autenticacion.',
            username=username,
        ), 500

    if ok:
        session['user'] = {'username': username}
        _set_audit('login', target=username)
        return redirect(url_for('index'))

    audit_log.emit(user=username, action='login', target=username,
                   status='error', details='invalid credentials')
    return render_template(
        'login.html',
        error='Credenciales invalidas o usuario sin permiso.',
        username=username,
    ), 401


@app.route('/logout', methods=['POST'])
def logout():
    user = _current_user() or 'anonymous'
    audit_log.emit(user=user, action='logout', target=user)
    if user and user != 'anonymous':
        # Liberar los locks que tenga el usuario en cualquier cluster — si no, los demás
        # tendrían que esperar al TTL para tomarlos.
        released_clusters = []
        with _WRITE_LOCK_MUTEX:
            for cid in [c for c, s in WRITE_LOCKS.items() if s.get('user') == user]:
                WRITE_LOCKS.pop(cid, None)
                released_clusters.append(cid)
        for cid in released_clusters:
            audit_log.emit(user=user, action='lock.release', target=cid,
                           cluster_id=cid, details='auto-released on logout')
        # Soltar la sesión persistente del usuario (libera la conexión al router).
        with _USER_SESSIONS_MUTEX:
            USER_SESSIONS.pop(user, None)
    session.clear()
    return redirect(url_for('login_form'))


# ──────────────────────────────────────────────────────────────
#  Rutas básicas
# ──────────────────────────────────────────────────────────────
@app.route('/')
@login_required
def index():
    user = session.get('user') or {}
    return render_template('index.html', username=user.get('username', ''))


@app.route('/api/defaults')
@login_required
def api_defaults():
    """Valores precargados para el modal Connect (port, api_key)."""
    try:
        vyos = load_vyos_defaults()
    except Exception as e:
        print(f"[warn] could not load vyos defaults: {e}", file=sys.stderr)
        vyos = {}
    return jsonify({'vyos': {
        'port': vyos.get('port', 8443),
        'api_key': vyos.get('api_key', ''),
    }})


@app.route('/upload', methods=['POST'])
@login_required
def upload():
    f = request.files.get('file')
    if not f:
        return jsonify({'status': 'error', 'message': 'No file uploaded'}), 400
    try:
        cfg = load_config(json.load(f))
        sess = _get_session(create=True)
        sess['config'] = cfg
        sess['raw_config'] = cfg  # con upload no tenemos raw distinto del adaptado
        return jsonify({'status': 'ok', 'data': cfg})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400


# ──────────────────────────────────────────────────────────────
#  API de lectura
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/rulesets')
@login_required
def firewall_rulesets():
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify([])
    return jsonify(list(cfg.get('firewall', {}).get('name', {}).keys()))


@app.route('/api/firewall/ruleset/<rs>')
@login_required
def firewall_ruleset(rs):
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({})
    return jsonify(cfg.get('firewall', {}).get('name', {}).get(rs, {}))


@app.route('/api/firewall/group/<gtype>/<gname>')
@login_required
def firewall_group(gtype, gname):
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({})
    return jsonify(cfg.get('firewall', {}).get('group', {}).get(f"{gtype}-group", {}).get(gname, {}))


@app.route('/api/<section>')
@login_required
def get_section(section):
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({})
    return jsonify(cfg.get(section.lower(), {}))


# ──────────────────────────────────────────────────────────────
#  API de lectura (Firewall Groups)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/groups')
@login_required
def firewall_groups():
    """Lista todos los grupos de firewall."""
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({})
    return jsonify(cfg.get('firewall', {}).get('group', {}))


@app.route('/api/firewall/group-usage/<gtype>/<gname>')
@login_required
def firewall_group_usage(gtype, gname):
    """
    Devuelve las reglas que usan un grupo específico.
    Útil para verificar antes de eliminar un grupo.
    """
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({'firewall': [], 'nat': []})

    references = {'firewall': [], 'nat': []}

    # Buscar en reglas de firewall
    for rs_name, rs_data in cfg.get('firewall', {}).get('name', {}).items():
        for rule_id, rule in rs_data.get('rule', {}).items():
            for side in ['source', 'destination']:
                group = rule.get(side, {}).get('group', {})
                if group.get(f'{gtype}-group') == gname:
                    references['firewall'].append({
                        'ruleset': rs_name,
                        'rule_id': rule_id,
                        'side': side
                    })

    # Buscar en reglas NAT (también pueden usar grupos)
    for nat_type in ['source', 'destination']:
        for rule_id, rule in cfg.get('nat', {}).get(nat_type, {}).get('rule', {}).items():
            for side in ['source', 'destination']:
                group = rule.get(side, {}).get('group', {})
                if group.get(f'{gtype}-group') == gname:
                    references['nat'].append({
                        'nat_type': nat_type,
                        'rule_id': rule_id,
                        'side': side
                    })

    return jsonify(references)


# ──────────────────────────────────────────────────────────────
#  Conexión via API REST de VyOS
# ──────────────────────────────────────────────────────────────
@app.route('/fetch-config', methods=['POST'])
@login_required
def fetch_config():
    """Obtiene configuración via API REST de VyOS y la asocia a la sesión del usuario."""
    data = request.get_json() or {}
    host = data.get('host', '').strip()
    api_key = data.get('api_key', '').strip()
    port = int(data.get('port', 443))

    if not host:
        return jsonify({'error': 'Host is required'}), 400
    if not api_key:
        return jsonify({'error': 'API key is required'}), 400

    try:
        api = VyOSAPI(host, api_key, port)
        api.host = host
        api.port = port

        raw = api.get_config()
        cfg = load_config(raw)

        cluster = detect_cluster(cfg)

        sess = _get_session(create=True)
        # Si el usuario estaba conectado a OTRO cluster y tenía su lock,
        # liberamos ese lock antiguo: ya no va a usar ese cluster, dejarlo
        # pinchado bloquearía a otros usuarios hasta el TTL.
        prev_cluster_id = _cluster_id_for(sess)
        user = _current_user()
        sess['active_api'] = api
        sess['raw_config'] = raw
        sess['config'] = cfg
        sess['peer_api'] = None
        sess['peer_config'] = None
        sess['raw_peer_config'] = None
        sess['cluster_info'] = cluster
        new_cluster_id = _cluster_id_for(sess)
        if prev_cluster_id and prev_cluster_id != new_cluster_id and user:
            with _WRITE_LOCK_MUTEX:
                state = WRITE_LOCKS.get(prev_cluster_id)
                if state and state.get('user') == user:
                    WRITE_LOCKS.pop(prev_cluster_id, None)
                    audit_log.emit(user=user, action='lock.release',
                                   target=prev_cluster_id,
                                   cluster_id=prev_cluster_id,
                                   details='auto-released on cluster switch')

        response = {'status': 'ok', 'data': cfg}
        if cluster:
            response['cluster_info'] = {**cluster, 'peer_connected': False}

        _set_audit('connect', target=f'{host}:{port}', nodes=['primary'])
        return jsonify(response)

    except VyOSAPIError as e:
        _set_audit('connect', target=f'{host}:{port}')
        g.audit_details = str(e)
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Unexpected error: {str(e)}'}), 500


@app.route('/fetch-peer', methods=['POST'])
@login_required
def fetch_peer():
    """Conecta al nodo peer del cluster HA en la sesión del usuario actual."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No primary connection. Connect to a router first.'}), 400
    cluster_info = sess.get('cluster_info')
    if not cluster_info or not cluster_info.get('detected'):
        return jsonify({'error': 'Primary node is not part of a cluster'}), 400

    active_api = sess['active_api']

    data = request.get_json() or {}
    peer_host = (data.get('host') or '').strip()
    if not peer_host:
        peer_host = cluster_info.get('peer_name') or ''
    if not peer_host:
        return jsonify({'error': 'peer host is required'}), 400

    peer_key = (data.get('api_key') or '').strip() or active_api.api_key
    peer_port = int(data.get('port') or getattr(active_api, 'port', 443))

    try:
        peer = VyOSAPI(peer_host, peer_key, peer_port)
        peer.host = peer_host
        peer.port = peer_port
        # Connect-peer sólo necesita validar que el peer responde y comprobar el
        # hostname. Pedimos únicamente el path mínimo para que VyOS no tenga que
        # serializar la config completa (costoso en routers grandes). El primer
        # runSyncCheck posterior se encargará de descargar el config completo en
        # paralelo con el del primary, y populará sess['peer_config'] entonces.
        raw_hostname = peer.get_config(['system', 'host-name'])
        if isinstance(raw_hostname, str):
            peer_hostname = raw_hostname
        elif isinstance(raw_hostname, dict):
            peer_hostname = (raw_hostname.get('host-name')
                             or next(iter(raw_hostname.values()), None))
        else:
            peer_hostname = None
        expected_peer = cluster_info.get('peer_name')
        hostname_mismatch = (peer_hostname != expected_peer)

        sess['peer_api'] = peer
        sess['peer_config'] = None
        sess['raw_peer_config'] = None
        sess['cluster_info'] = {**cluster_info, 'peer_connected': True,
                                'peer_host': peer_host, 'peer_port': peer_port,
                                'peer_hostname_reported': peer_hostname}

        return jsonify({
            'status': 'ok',
            'cluster_info': sess['cluster_info'],
            'hostname_mismatch': hostname_mismatch,
            'peer_hostname': peer_hostname,
            'expected': expected_peer
        })

    except VyOSAPIError as e:
        return jsonify({'error': str(e), 'peer_host': peer_host}), 502
    except Exception as e:
        return jsonify({'error': f'Unexpected error: {str(e)}', 'peer_host': peer_host}), 500


@app.route('/api/cluster/status')
@login_required
def cluster_status():
    """Devuelve el estado actual del cluster del usuario actual."""
    sess = _get_session()
    cluster_info = sess.get('cluster_info') if sess else None
    peer_connected = bool(sess and sess.get('peer_api'))
    return jsonify({
        'cluster_info': cluster_info,
        'peer_connected': peer_connected,
    })


@app.route('/api/cluster/disconnect-peer', methods=['POST'])
@login_required
def disconnect_peer():
    """Desconecta del peer en la sesión del usuario (vuelve a modo single-node)."""
    sess = _get_session()
    if not sess:
        return jsonify({'status': 'ok'})
    sess['peer_api'] = None
    sess['peer_config'] = None
    sess['raw_peer_config'] = None
    if sess.get('cluster_info'):
        sess['cluster_info'] = {**sess['cluster_info'], 'peer_connected': False}
    return jsonify({'status': 'ok'})


# ──────────────────────────────────────────────────────────────
#  Sync check (cluster HA)
# ──────────────────────────────────────────────────────────────
def _deep_equal(a, b):
    """Igualdad estructural ignorando orden de claves en dicts."""
    if type(a) != type(b):
        # dict vs dict / list vs list — permitimos {} == None implícito abajo
        if (a in (None, {}) and b in (None, {})):
            return True
        return False
    if isinstance(a, dict):
        if set(a.keys()) != set(b.keys()):
            return False
        return all(_deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        # Para entries de grupos y similares: comparar como sets de strings
        try:
            return sorted(a) == sorted(b)
        except TypeError:
            return a == b
    return a == b


def _diff_section(section_label, primary_map, peer_map, id_key='id'):
    """
    Compara dos mapas {id: value}. Devuelve lista de diffs:
      { section, id, kind: 'missing_on_peer' | 'missing_on_primary' | 'content' }
    """
    diffs = []
    primary_ids = set(primary_map.keys())
    peer_ids = set(peer_map.keys())

    for key in sorted(primary_ids - peer_ids):
        diffs.append({
            'section': section_label, 'id': key, id_key: key,
            'kind': 'missing_on_peer',
            'detail': f'{section_label} "{key}" existe en primary pero no en peer'
        })
    for key in sorted(peer_ids - primary_ids):
        diffs.append({
            'section': section_label, 'id': key, id_key: key,
            'kind': 'missing_on_primary',
            'detail': f'{section_label} "{key}" existe en peer pero no en primary'
        })
    for key in sorted(primary_ids & peer_ids):
        if not _deep_equal(primary_map[key], peer_map[key]):
            diffs.append({
                'section': section_label, 'id': key, id_key: key,
                'kind': 'content',
                'detail': f'{section_label} "{key}" difiere entre primary y peer'
            })
    return diffs


def compute_sync_diffs(primary_cfg, peer_cfg):
    """
    Compara primary_cfg y peer_cfg sobre los cuatro ámbitos:
      - firewall.name.*.rule (aplanado como {'ruleset:rule_id': rule_body})
      - firewall.group.*-group (cada grupo como unidad)
      - nat.{source,destination}.rule (aplanado como {'type:rule_id': rule})
      - static routes: protocols.static.route + vrf.*.protocols.static.route
    """
    diffs = []

    # —— Firewall rules (aplanar ruleset + rule_id para tener un ID único) ——
    def flatten_fw(cfg):
        flat = {}
        for rs_name, rs_data in cfg.get('firewall', {}).get('name', {}).items():
            for rule_id, rule in (rs_data.get('rule') or {}).items():
                flat[f'{rs_name}:{rule_id}'] = rule
        return flat
    diffs += _diff_section('firewall', flatten_fw(primary_cfg), flatten_fw(peer_cfg))

    # —— Firewall groups ——
    def flatten_groups(cfg):
        flat = {}
        for gtype in ('address-group', 'network-group', 'port-group'):
            for gname, gdata in cfg.get('firewall', {}).get('group', {}).get(gtype, {}).items():
                flat[f'{gtype}:{gname}'] = gdata
        return flat
    diffs += _diff_section('group', flatten_groups(primary_cfg), flatten_groups(peer_cfg))

    # —— NAT rules ——
    def flatten_nat(cfg):
        flat = {}
        for nat_type in ('source', 'destination'):
            for rule_id, rule in cfg.get('nat', {}).get(nat_type, {}).get('rule', {}).items():
                flat[f'{nat_type}:{rule_id}'] = rule
        return flat
    diffs += _diff_section('nat', flatten_nat(primary_cfg), flatten_nat(peer_cfg))

    # —— Static routes (default + VRFs) ——
    def flatten_routes(cfg):
        flat = {}
        for net, data in cfg.get('protocols', {}).get('static', {}).get('route', {}).items():
            flat[f'default:{net}'] = data
        for vrf_name, vrf_data in cfg.get('vrf', {}).get('name', {}).items():
            for net, data in vrf_data.get('protocols', {}).get('static', {}).get('route', {}).items():
                flat[f'vrf:{vrf_name}:{net}'] = data
        return flat
    diffs += _diff_section('static-route', flatten_routes(primary_cfg), flatten_routes(peer_cfg))

    return diffs


@app.route('/api/cluster/sync-check')
@login_required
def cluster_sync_check():
    """Compara primary y peer del usuario actual. Si no hay peer, synchronized=true trivial."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection'}), 400
    cluster_info = sess.get('cluster_info')
    if not (cluster_info and cluster_info.get('detected') and sess.get('peer_api')):
        return jsonify({'synchronized': True, 'cluster': False, 'differences': []})

    # Refrescar AMBAS caches para evitar falsos "synchronized=true" tras
    # un timeout en el que VyOS aplicó silenciosamente y nuestro cache quedó stale.
    try:
        raw_primary = sess['active_api'].get_config()
        sess['raw_config'] = raw_primary
        sess['config'] = load_config(raw_primary)
    except VyOSAPIError as e:
        return jsonify({'error': f'Primary unreachable: {str(e)}'}), 502

    try:
        raw_peer = sess['peer_api'].get_config()
        sess['raw_peer_config'] = raw_peer
        sess['peer_config'] = load_config(raw_peer)
    except VyOSAPIError as e:
        return jsonify({'error': f'Peer unreachable: {str(e)}'}), 502

    differences = compute_sync_diffs(sess['config'], sess['peer_config'])
    return jsonify({
        'synchronized': len(differences) == 0,
        'cluster': True,
        'differences': differences,
        'primary_name': cluster_info.get('primary_name'),
        'peer_name': cluster_info.get('peer_name')
    })


# ──────────────────────────────────────────────────────────────
#  In-memory ops applier (evita refetch tras cada apply)
# ──────────────────────────────────────────────────────────────
def _is_group_entry_path(path):
    """
    Path de set sobre una entrada de address/network/port-group:
      ['firewall', 'group', '<X>-group', NAME, '<address|network|port>', VALUE]
    """
    return (
        len(path) == 6
        and path[0] == 'firewall'
        and path[1] == 'group'
        and path[2] in ('address-group', 'network-group', 'port-group')
        and path[4] in ('address', 'network', 'port')
    )


# Flags booleanos VyOS que no llevan valor: el último segmento del path
# es el flag en sí, no un valor. Cubrimos los que generan los helpers de este
# codebase; otros (log…) caerán al fallback de fetch — es seguro.
_VYOS_BOOLEAN_FLAGS = {'exclude', 'disable'}


def _set_op(raw, path):
    """Aplica un 'set' sobre raw. Devuelve True si OK, False si situación rara."""
    if len(path) < 2:
        return False

    # Boolean flag: ['nat', 'source', 'rule', '10', 'exclude'] → rule['exclude'] = {}
    if path[-1] in _VYOS_BOOLEAN_FLAGS:
        *parents, flag = path
        node = raw
        for k in parents:
            if not isinstance(node, dict):
                return False
            node = node.setdefault(k, {})
        if not isinstance(node, dict):
            return False
        # VyOS REST representa flags vacíos como dict vacío; idempotente si ya está.
        if not isinstance(node.get(flag), dict):
            node[flag] = {}
        return True

    if _is_group_entry_path(path):
        *parents, leaf_key, value = path
        node = raw
        for k in parents:
            if not isinstance(node, dict):
                return False
            node = node.setdefault(k, {})
        if not isinstance(node, dict):
            return False
        existing = node.get(leaf_key)
        if existing is None:
            node[leaf_key] = [value]
        elif isinstance(existing, list):
            if value not in existing:
                existing.append(value)
        elif isinstance(existing, str):
            if existing != value:
                node[leaf_key] = [existing, value]
        else:
            return False
        return True

    *parents, leaf_key, value = path
    node = raw
    for k in parents:
        if not isinstance(node, dict):
            return False
        node = node.setdefault(k, {})
    if not isinstance(node, dict):
        return False
    if isinstance(node.get(leaf_key), dict):
        # Sería sobreescribir un nodo intermedio con un valor escalar.
        # No nos arriesgamos: que el caller refresque desde el router.
        return False
    node[leaf_key] = value
    return True


def _delete_op(raw, path):
    """Elimina la entrada en raw siguiendo path. Best-effort."""
    if not path:
        return True
    node = raw
    for k in path[:-1]:
        if isinstance(node, dict):
            if k not in node:
                return True  # ya no existe
            node = node[k]
        else:
            return False
    last = path[-1]
    if isinstance(node, dict):
        node.pop(last, None)
        return True
    if isinstance(node, list):
        if last in node:
            node.remove(last)
        return True
    return False


def apply_ops_in_memory(raw, ops):
    """
    Aplica ops VyOS a un dict raw cacheado (in-place).
    Devuelve True si todo se pudo aplicar; False si encuentra algo inesperado
    (en cuyo caso el caller debe hacer fallback a get_config).
    """
    if raw is None:
        return False
    # Solo soportamos 1.4: si no hay firewall.ipv4 y las ops lo usan,
    # mejor fall-back para no corromper el cache.
    is_14 = bool(raw.get('firewall', {}).get('ipv4'))
    for entry in ops:
        op = entry.get('op')
        path = list(entry.get('path') or [])
        if not is_14 and len(path) >= 3 and path[0] == 'firewall' and path[1] == 'ipv4':
            return False
        if op == 'set':
            if not _set_op(raw, path):
                return False
        elif op == 'delete':
            if not _delete_op(raw, path):
                return False
        else:
            # comment u otra op no soportada
            return False
    return True


# ──────────────────────────────────────────────────────────────
#  Dual-apply helper (primary + peer)
# ──────────────────────────────────────────────────────────────
class DualApplyError(Exception):
    """Error específico de dual-apply que debe serializarse a HTTP concreto."""
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self.payload = payload


@app.errorhandler(DualApplyError)
def _handle_dual_apply_error(err):
    return jsonify(err.payload), err.status_code


def _reverse_ops(ops):
    """Genera operaciones inversas best-effort: 'set' ↦ 'delete'. Los 'delete' no se invierten (no tenemos el valor previo)."""
    out = []
    for op in reversed(ops):
        if op.get('op') == 'set':
            out.append({'op': 'delete', 'path': list(op['path'])})
    return out


def _want_peer(sess, to_peer_requested):
    """Decide si aplicar al peer del cluster del usuario."""
    cluster_info = sess.get('cluster_info') if sess else None
    in_cluster = bool(cluster_info and cluster_info.get('detected') and sess and sess.get('peer_api'))
    if not in_cluster:
        return False
    if to_peer_requested is None:
        return True  # default en cluster = aplicar a ambos
    return bool(to_peer_requested)


def apply_ops_dual(sess, ops, to_peer_requested=None, require_sync=True):
    """
    Aplica una lista de operaciones VyOS al primary y opcionalmente al peer
    de la sesión `sess` del usuario actual.

    Args:
      sess: sesión del usuario (dict de USER_SESSIONS).
      ops: lista [{op, path}, ...]
      to_peer_requested: True/False/None (None = default del cluster)
      require_sync: si True y aplica al peer, hace pre-flight sync-check

    Raises DualApplyError (serializa a HTTP) en:
      - 409: cluster no sincronizado (pre-flight)
      - 502: peer inaccesible
      - 500: fallo de apply (primary o peer)
    """
    if not ops:
        return {'applied': 0, 'nodes': []}
    if not sess or not sess.get('active_api'):
        raise DualApplyError(400, {'error': 'No active connection'})

    active_api = sess['active_api']
    do_peer = _want_peer(sess, to_peer_requested)

    # Pre-flight sync check (solo si se va a aplicar al peer)
    if do_peer and require_sync:
        peer_api = sess['peer_api']
        try:
            raw_peer = peer_api.get_config()
            sess['raw_peer_config'] = raw_peer
            sess['peer_config'] = load_config(raw_peer)
        except VyOSAPIError as e:
            raise DualApplyError(502, {'error': f'Peer inaccesible: {str(e)}'})
        diffs = compute_sync_diffs(sess['config'], sess['peer_config'])
        if diffs:
            cluster_info = sess.get('cluster_info') or {}
            raise DualApplyError(409, {
                'error': 'Los nodos del cluster no están sincronizados. Apply bloqueado.',
                'synchronized': False,
                'differences': diffs,
                'primary_name': cluster_info.get('primary_name'),
                'peer_name': cluster_info.get('peer_name')
            })

    # Caso single-node: aplicar solo a primary (no hay nada que paralelizar).
    if not do_peer:
        try:
            active_api.configure(ops)
        except VyOSAPIError as e:
            try:
                raw = active_api.get_config()
                sess['raw_config'] = raw
                sess['config'] = load_config(raw)
            except VyOSAPIError:
                pass
            raise DualApplyError(500, {
                'error': f'Primary apply failed: {str(e)}',
                'hint': 'CONFIG refrescado: si la operación se aplicó silenciosamente '
                        'tras timeout, la UI lo verá en el próximo render.'
            })
        if not (sess.get('raw_config') is not None and apply_ops_in_memory(sess['raw_config'], ops)):
            try:
                raw = active_api.get_config()
                sess['raw_config'] = raw
            except VyOSAPIError:
                pass
        if sess.get('raw_config') is not None:
            sess['config'] = load_config(sess['raw_config'])
        return {'applied_to': ['primary'], 'nodes': 1}

    # Apply EN PARALELO a primary y peer.
    peer_api = sess['peer_api']
    primary_err = None
    peer_err = None
    with concurrent.futures.ThreadPoolExecutor(max_workers=2,
                                               thread_name_prefix='dual-apply') as ex:
        f_primary = ex.submit(active_api.configure, ops)
        f_peer = ex.submit(peer_api.configure, ops)
        try:
            f_primary.result()
        except VyOSAPIError as e:
            primary_err = str(e)
        except Exception as e:
            primary_err = f'unexpected: {str(e)}'
        try:
            f_peer.result()
        except VyOSAPIError as e:
            peer_err = str(e)
        except Exception as e:
            peer_err = f'unexpected: {str(e)}'

    # Caso 1: ambos OK → update in-memory de las dos caches.
    if primary_err is None and peer_err is None:
        if not (sess.get('raw_config') is not None and apply_ops_in_memory(sess['raw_config'], ops)):
            try:
                raw = active_api.get_config()
                sess['raw_config'] = raw
            except VyOSAPIError:
                pass
        if sess.get('raw_config') is not None:
            sess['config'] = load_config(sess['raw_config'])
        if not (sess.get('raw_peer_config') is not None and apply_ops_in_memory(sess['raw_peer_config'], ops)):
            try:
                raw_peer = peer_api.get_config()
                sess['raw_peer_config'] = raw_peer
            except VyOSAPIError:
                pass
        if sess.get('raw_peer_config') is not None:
            sess['peer_config'] = load_config(sess['raw_peer_config'])
        return {'applied_to': ['primary', 'peer'], 'nodes': 2}

    # Caso 4: ambos fallaron → refrescar caches; sin rollback.
    if primary_err is not None and peer_err is not None:
        try:
            raw = active_api.get_config()
            sess['raw_config'] = raw
            sess['config'] = load_config(raw)
        except VyOSAPIError:
            pass
        try:
            raw_peer = peer_api.get_config()
            sess['raw_peer_config'] = raw_peer
            sess['peer_config'] = load_config(raw_peer)
        except VyOSAPIError:
            pass
        raise DualApplyError(500, {
            'error': f'Both nodes failed. primary: {primary_err}. peer: {peer_err}',
            'hint': 'Caches refrescadas. Si VyOS aplicó silenciosamente tras timeout, '
                    'lo verás al render.'
        })

    # Casos 2/3: un lado OK, el otro KO → rollback del lado que triunfó.
    if primary_err is None:  # peer falló
        try:
            raw_peer = peer_api.get_config()
            sess['raw_peer_config'] = raw_peer
            sess['peer_config'] = load_config(raw_peer)
        except VyOSAPIError:
            pass
        rollback_ops = _reverse_ops(ops)
        rollback_status = 'skipped'
        if rollback_ops:
            try:
                active_api.configure(rollback_ops)
                try:
                    raw = active_api.get_config()
                    sess['raw_config'] = raw
                    sess['config'] = load_config(raw)
                except VyOSAPIError:
                    pass
                rollback_status = 'ok'
            except VyOSAPIError as ex:
                rollback_status = f'failed: {str(ex)}'
        raise DualApplyError(500, {
            'error': f'Peer apply failed: {peer_err}',
            'applied_to_primary': True,
            'rollback': rollback_status,
            'hint': 'Si rollback=ok el primary fue revertido. Si failed revisa manualmente.'
        })

    # primary falló, peer OK → rollback peer.
    try:
        raw = active_api.get_config()
        sess['raw_config'] = raw
        sess['config'] = load_config(raw)
    except VyOSAPIError:
        pass
    rollback_ops = _reverse_ops(ops)
    rollback_status = 'skipped'
    if rollback_ops:
        try:
            peer_api.configure(rollback_ops)
            try:
                raw_peer = peer_api.get_config()
                sess['raw_peer_config'] = raw_peer
                sess['peer_config'] = load_config(raw_peer)
            except VyOSAPIError:
                pass
            rollback_status = 'ok'
        except VyOSAPIError as ex:
            rollback_status = f'failed: {str(ex)}'
    raise DualApplyError(500, {
        'error': f'Primary apply failed: {primary_err}',
        'applied_to_peer': True,
        'rollback': rollback_status,
        'hint': 'Si rollback=ok el peer fue revertido. Si failed revisa manualmente.'
    })


# ──────────────────────────────────────────────────────────────
#  API de escritura (Firewall)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/rule', methods=['POST', 'PUT', 'DELETE'])
@login_required
@write_lock_required
def manage_firewall_rule():
    """Crear, modificar o eliminar regla de firewall."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    ruleset = data.get('ruleset')
    rule_id = data.get('rule_id')
    to_peer = data.get('apply_to_peer')  # None | bool

    if not ruleset or not rule_id:
        return jsonify({'error': 'ruleset and rule_id are required'}), 400

    base_path = ['firewall', 'ipv4', 'name', ruleset, 'rule', str(rule_id)]

    if request.method == 'DELETE':
        ops = [{'op': 'delete', 'path': base_path}]
    else:
        diff = data.get('diff')
        if diff:
            ops = build_diff_operations(base_path, diff)
        else:
            rule_data = data.get('rule', {})
            if not rule_data:
                return jsonify({'error': 'rule data is required'}), 400
            ops = build_vyos_operations({'type': 'firewall', 'action': 'create',
                                         'data': {'ruleset': ruleset, 'rule_id': rule_id, 'rule': rule_data}})

    if not ops:
        return jsonify({'status': 'ok', 'message': 'No operations to apply'})

    result = apply_ops_dual(sess, ops, to_peer_requested=to_peer)
    action_name = 'firewall.delete' if request.method == 'DELETE' else 'firewall.update'
    _set_audit(action_name, target=f'{ruleset}/rule/{rule_id}',
               nodes=result.get('applied_to'),
               commands=[{'cmd': ' '.join([op.get('op', '')] + list(op.get('path', [])))} for op in ops])
    return jsonify({'status': 'ok', 'message': 'Rule updated successfully', **result})


# ──────────────────────────────────────────────────────────────
#  API de escritura (NAT)
# ──────────────────────────────────────────────────────────────
@app.route('/api/nat/rule', methods=['POST', 'PUT', 'DELETE'])
@login_required
@write_lock_required
def manage_nat_rule():
    """Crear, modificar o eliminar regla NAT."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    nat_type = data.get('nat_type')
    rule_id = data.get('rule_id')
    to_peer = data.get('apply_to_peer')

    if not nat_type or not rule_id:
        return jsonify({'error': 'nat_type and rule_id are required'}), 400
    if nat_type not in ['source', 'destination']:
        return jsonify({'error': 'nat_type must be "source" or "destination"'}), 400

    base_path = ['nat', nat_type, 'rule', str(rule_id)]

    if request.method == 'DELETE':
        ops = [{'op': 'delete', 'path': base_path}]
    else:
        diff = data.get('diff')
        if diff:
            ops = build_diff_operations(base_path, diff)
        else:
            rule_data = data.get('rule', {})
            if not rule_data:
                return jsonify({'error': 'rule data is required'}), 400
            ops = build_vyos_operations({'type': 'nat', 'action': 'create',
                                         'data': {'nat_type': nat_type, 'rule_id': rule_id, 'rule': rule_data}})

    if not ops:
        return jsonify({'status': 'ok', 'message': 'No operations to apply'})

    result = apply_ops_dual(sess, ops, to_peer_requested=to_peer)
    action_name = 'nat.delete' if request.method == 'DELETE' else 'nat.update'
    _set_audit(action_name, target=f'{nat_type}/rule/{rule_id}',
               nodes=result.get('applied_to'),
               commands=[{'cmd': ' '.join([op.get('op', '')] + list(op.get('path', [])))} for op in ops])
    return jsonify({'status': 'ok', 'message': 'NAT rule updated successfully', **result})


# ──────────────────────────────────────────────────────────────
#  API de escritura (Firewall Groups)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/group', methods=['POST', 'PUT', 'DELETE'])
@login_required
@write_lock_required
def manage_firewall_group():
    """Crear, modificar o eliminar grupo de firewall."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    group_type = data.get('group_type')
    group_name = data.get('group_name')
    to_peer = data.get('apply_to_peer')

    if not group_type or not group_name:
        return jsonify({'error': 'group_type and group_name are required'}), 400
    if group_type not in ['address', 'network', 'port']:
        return jsonify({'error': 'group_type must be "address", "network", or "port"'}), 400

    base_path = ['firewall', 'group', f'{group_type}-group', group_name]

    if request.method == 'DELETE':
        ops = [{'op': 'delete', 'path': base_path}]
    else:
        diff = data.get('diff')
        if diff:
            ops = build_diff_operations(base_path, diff)
        else:
            entries = data.get('entries', [])
            description = data.get('description')
            ops = build_vyos_operations({'type': 'group', 'action': 'create',
                                         'data': {'group_type': group_type, 'group_name': group_name,
                                                  'entries': entries, 'description': description}})

    if not ops:
        return jsonify({'status': 'ok', 'message': 'No operations to apply'})

    result = apply_ops_dual(sess, ops, to_peer_requested=to_peer)
    action_name = 'group.delete' if request.method == 'DELETE' else 'group.update'
    _set_audit(action_name, target=f'{group_type}-group/{group_name}',
               nodes=result.get('applied_to'),
               commands=[{'cmd': ' '.join([op.get('op', '')] + list(op.get('path', [])))} for op in ops])
    return jsonify({'status': 'ok', 'message': 'Group updated successfully', **result})


# ──────────────────────────────────────────────────────────────
#  Batch Configure (Staged Changes)
# ──────────────────────────────────────────────────────────────
@app.route('/api/batch-configure', methods=['POST'])
@login_required
@write_lock_required
def batch_configure():
    """
    Aplica múltiples operaciones en una sola llamada.

    Body JSON:
      {
        "operations": [
            { "type": "firewall", "action": "create", "data": {...} },
            { "type": "nat", "action": "delete", "data": {...} },
            ...
        ],
        "apply_to_peer": true|false|null  # null = default del cluster
      }
    """
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    operations = data.get('operations', [])
    to_peer = data.get('apply_to_peer')

    if not operations:
        return jsonify({'error': 'No operations provided'}), 400

    vyos_ops = []
    for op in operations:
        vyos_ops.extend(build_vyos_operations(op))

    if not vyos_ops:
        return jsonify({'error': 'No valid operations to execute'}), 400

    result = apply_ops_dual(sess, vyos_ops, to_peer_requested=to_peer)
    summary = ', '.join(f"{op.get('type')}.{op.get('action')}" for op in operations[:5])
    if len(operations) > 5:
        summary += f' (+{len(operations) - 5} more)'
    _set_audit('batch.apply',
               target=f'{len(operations)} operations',
               nodes=result.get('applied_to'),
               commands=[{'cmd': ' '.join([op.get('op', '')] + list(op.get('path', [])))} for op in vyos_ops])
    g.audit_details = summary
    return jsonify({
        'success': True,
        'applied': len(operations),
        'vyos_operations': len(vyos_ops),
        **result
    })


def build_vyos_operations(operation):
    """
    Convierte una operación del frontend a operaciones VyOS (lista de dicts con 'op' y 'path').
    Soporta actualizaciones diferenciales cuando se incluye 'diff' en los datos.
    """
    ops = []
    op_type = operation.get('type')
    action = operation.get('action')
    data = operation.get('data', {})

    # Check if this is a differential update
    diff = data.get('diff')

    if op_type == 'firewall':
        ruleset = data.get('ruleset')
        rule_id = str(data.get('rule_id'))
        base_path = ['firewall', 'ipv4', 'name', ruleset, 'rule', rule_id]

        if action == 'delete':
            ops.append({'op': 'delete', 'path': base_path})
        elif diff and action == 'update':
            # Differential update - only change what's different
            ops.extend(build_diff_operations(base_path, diff))
        else:
            # Full create/update (legacy behavior)
            rule = data.get('rule', {})
            if rule.get('action'):
                ops.append({'op': 'set', 'path': base_path + ['action', rule['action']]})
            if rule.get('jump-target'):
                ops.append({'op': 'set', 'path': base_path + ['jump-target', rule['jump-target']]})
            if rule.get('protocol'):
                ops.append({'op': 'set', 'path': base_path + ['protocol', rule['protocol']]})
            if rule.get('description'):
                ops.append({'op': 'set', 'path': base_path + ['description', rule['description']]})
            if rule.get('disable'):
                ops.append({'op': 'set', 'path': base_path + ['disable']})

            # Source
            src = rule.get('source', {})
            if src.get('address'):
                ops.append({'op': 'set', 'path': base_path + ['source', 'address', src['address']]})
            if src.get('port'):
                ops.append({'op': 'set', 'path': base_path + ['source', 'port', str(src['port'])]})
            if src.get('group'):
                for gtype, gname in src['group'].items():
                    ops.append({'op': 'set', 'path': base_path + ['source', 'group', gtype, gname]})

            # Destination
            dst = rule.get('destination', {})
            if dst.get('address'):
                ops.append({'op': 'set', 'path': base_path + ['destination', 'address', dst['address']]})
            if dst.get('port'):
                ops.append({'op': 'set', 'path': base_path + ['destination', 'port', str(dst['port'])]})
            if dst.get('group'):
                for gtype, gname in dst['group'].items():
                    ops.append({'op': 'set', 'path': base_path + ['destination', 'group', gtype, gname]})

    elif op_type == 'nat':
        nat_type = data.get('nat_type')
        rule_id = str(data.get('rule_id'))
        base_path = ['nat', nat_type, 'rule', rule_id]

        if action == 'delete':
            ops.append({'op': 'delete', 'path': base_path})
        elif diff and action == 'update':
            # Differential update - only change what's different
            ops.extend(build_diff_operations(base_path, diff))
        else:
            # Full create/update (legacy behavior)
            rule = data.get('rule', {})
            if rule.get('description'):
                ops.append({'op': 'set', 'path': base_path + ['description', rule['description']]})
            if rule.get('exclude'):
                ops.append({'op': 'set', 'path': base_path + ['exclude']})
            if rule.get('disable'):
                ops.append({'op': 'set', 'path': base_path + ['disable']})
            if rule.get('protocol'):
                ops.append({'op': 'set', 'path': base_path + ['protocol', rule['protocol']]})

            # Source
            src = rule.get('source', {})
            if src.get('address'):
                ops.append({'op': 'set', 'path': base_path + ['source', 'address', src['address']]})
            if src.get('port'):
                ops.append({'op': 'set', 'path': base_path + ['source', 'port', str(src['port'])]})

            # Destination
            dst = rule.get('destination', {})
            if dst.get('address'):
                ops.append({'op': 'set', 'path': base_path + ['destination', 'address', dst['address']]})
            if dst.get('port'):
                ops.append({'op': 'set', 'path': base_path + ['destination', 'port', str(dst['port'])]})

            # Translation
            trans = rule.get('translation', {})
            if trans.get('address'):
                ops.append({'op': 'set', 'path': base_path + ['translation', 'address', trans['address']]})
            if trans.get('port'):
                ops.append({'op': 'set', 'path': base_path + ['translation', 'port', str(trans['port'])]})

            # Interfaces
            if rule.get('inbound-interface', {}).get('name'):
                ops.append({'op': 'set', 'path': base_path + ['inbound-interface', 'name', rule['inbound-interface']['name']]})
            if rule.get('outbound-interface', {}).get('name'):
                ops.append({'op': 'set', 'path': base_path + ['outbound-interface', 'name', rule['outbound-interface']['name']]})

    elif op_type == 'group':
        group_type = data.get('group_type')  # 'address', 'network', 'port'
        group_name = data.get('group_name')
        entry_key = {'address': 'address', 'network': 'network', 'port': 'port'}[group_type]
        base_path = ['firewall', 'group', f'{group_type}-group', group_name]

        if action == 'delete':
            ops.append({'op': 'delete', 'path': base_path})
        elif diff and action == 'update':
            # Differential update - only change what's different
            ops.extend(build_diff_operations(base_path, diff))
        else:
            # Full create/update
            entries = data.get('entries', [])
            description = data.get('description')

            for entry in entries:
                ops.append({'op': 'set', 'path': base_path + [entry_key, str(entry)]})

            if description:
                ops.append({'op': 'set', 'path': base_path + ['description', description]})

    return ops


def build_diff_operations(base_path, diff):
    """
    Construye operaciones VyOS a partir de un diff.
    diff = { sets: [{path: [...], value: ...}], deletes: [[...]] }
    """
    ops = []

    # Process set operations
    for set_op in diff.get('sets', []):
        path = set_op.get('path', [])
        value = set_op.get('value')

        full_path = base_path + path
        if value is not None:
            # Handle boolean values (like 'exclude')
            if isinstance(value, bool):
                if value:
                    ops.append({'op': 'set', 'path': full_path})
            else:
                ops.append({'op': 'set', 'path': full_path + [str(value)]})
        else:
            ops.append({'op': 'set', 'path': full_path})

    # Process delete operations
    for del_path in diff.get('deletes', []):
        full_path = base_path + del_path
        ops.append({'op': 'delete', 'path': full_path})

    return ops


# ──────────────────────────────────────────────────────────────
#  Guardar configuración
# ──────────────────────────────────────────────────────────────
@app.route('/api/save-config', methods=['POST'])
@login_required
@write_lock_required
def save_config_to_router():
    """Guarda configuración en el router. En cluster, guarda también en el peer por defecto."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json(silent=True) or {}
    to_peer = data.get('apply_to_peer')
    do_peer = _want_peer(sess, to_peer)

    try:
        sess['active_api'].save_config()
    except VyOSAPIError as e:
        return jsonify({'error': f'Primary save failed: {str(e)}'}), 500

    if not do_peer:
        _set_audit('config.save', target='primary', nodes=['primary'])
        return jsonify({'status': 'ok', 'message': 'Configuration saved', 'nodes': ['primary']})

    try:
        sess['peer_api'].save_config()
    except VyOSAPIError as e:
        _set_audit('config.save', target='primary+peer', nodes=['primary'])
        g.audit_details = f'peer save failed: {str(e)}'
        return jsonify({
            'status': 'partial',
            'message': 'Primary saved, peer save failed',
            'nodes': ['primary'],
            'peer_error': str(e)
        }), 500

    _set_audit('config.save', target='primary+peer', nodes=['primary', 'peer'])
    return jsonify({'status': 'ok', 'message': 'Configuration saved on both nodes',
                    'nodes': ['primary', 'peer']})


# ──────────────────────────────────────────────────────────────
#  Estado de conexión
# ──────────────────────────────────────────────────────────────
@app.route('/api/connection-status')
@login_required
def connection_status():
    """Devuelve el estado de la conexión del usuario actual."""
    sess = _get_session()
    return jsonify({
        'connected': bool(sess and sess.get('active_api')),
        'config_loaded': bool(sess and sess.get('config') is not None),
        'cluster_info': sess.get('cluster_info') if sess else None,
        'peer_connected': bool(sess and sess.get('peer_api')),
    })


# ──────────────────────────────────────────────────────────────
#  Dashboard Stats
# ──────────────────────────────────────────────────────────────
@app.route('/api/dashboard-stats')
@login_required
def dashboard_stats():
    """Devuelve estadísticas para el dashboard."""
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({})

    def count_interfaces(c):
        total = 0
        for itype in c.get('interfaces', {}).values():
            if isinstance(itype, dict):
                total += len(itype)
        return total

    # Count firewall rulesets and rules
    fw_name = cfg.get('firewall', {}).get('name', {})
    firewall_rulesets = len(fw_name)
    firewall_rules = sum(len(rs.get('rule', {})) for rs in fw_name.values())

    # Count NAT rules
    nat_dest = len(cfg.get('nat', {}).get('destination', {}).get('rule', {}))
    nat_source = len(cfg.get('nat', {}).get('source', {}).get('rule', {}))

    # Count groups
    groups = cfg.get('firewall', {}).get('group', {})
    address_groups = len(groups.get('address-group', {}))
    network_groups = len(groups.get('network-group', {}))
    port_groups = len(groups.get('port-group', {}))

    # Count static routes
    static_routes = len(cfg.get('protocols', {}).get('static', {}).get('route', {}))

    # Count BGP neighbors
    bgp = cfg.get('protocols', {}).get('bgp', {})
    bgp_neighbors = len(bgp.get('neighbor', {}))
    bgp_networks = len(bgp.get('address-family', {}).get('ipv4-unicast', {}).get('network', {}))

    stats = {
        'firewall': {
            'rulesets': firewall_rulesets,
            'rules': firewall_rules
        },
        'nat': {
            'destination': nat_dest,
            'source': nat_source,
            'total': nat_dest + nat_source
        },
        'groups': {
            'address': address_groups,
            'network': network_groups,
            'port': port_groups,
            'total': address_groups + network_groups + port_groups
        },
        'interfaces': count_interfaces(cfg),
        'routing': {
            'static_routes': static_routes,
            'bgp_neighbors': bgp_neighbors,
            'bgp_networks': bgp_networks
        },
        'system': {
            'hostname': cfg.get('system', {}).get('host-name', 'Unknown')
        }
    }
    return jsonify(stats)


# ──────────────────────────────────────────────────────────────
#  Interfaces (Read Only)
# ──────────────────────────────────────────────────────────────
@app.route('/api/interfaces')
@login_required
def interfaces():
    """Devuelve configuración de interfaces."""
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({})
    return jsonify(cfg.get('interfaces', {}))


# ──────────────────────────────────────────────────────────────
#  VRFs
# ──────────────────────────────────────────────────────────────
@app.route('/api/vrfs')
@login_required
def list_vrfs():
    """Devuelve lista de VRFs configurados."""
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify([])
    vrfs = cfg.get('vrf', {}).get('name', {})
    return jsonify(list(vrfs.keys()))


# ──────────────────────────────────────────────────────────────
#  Static Routes
# ──────────────────────────────────────────────────────────────
@app.route('/api/static-routes')
@login_required
def static_routes():
    """Devuelve rutas estáticas de todos los VRFs."""
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({'default': {}, 'vrfs': {}})

    # Rutas del VRF default (protocols.static.route)
    default_routes = cfg.get('protocols', {}).get('static', {}).get('route', {})

    # Rutas de VRFs específicos (vrf.name.<vrf>.protocols.static.route)
    vrf_routes = {}
    vrfs = cfg.get('vrf', {}).get('name', {})
    for vrf_name, vrf_data in vrfs.items():
        routes = vrf_data.get('protocols', {}).get('static', {}).get('route', {})
        if routes:
            vrf_routes[vrf_name] = routes

    return jsonify({
        'default': default_routes,
        'vrfs': vrf_routes
    })


@app.route('/api/static-route', methods=['POST', 'DELETE'])
@login_required
@write_lock_required
def manage_static_route():
    """Crear o eliminar ruta estática (default VRF o VRF específico)."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    network = data.get('network')
    vrf = data.get('vrf')
    to_peer = data.get('apply_to_peer')

    if not network:
        return jsonify({'error': 'network is required'}), 400

    if vrf and vrf != 'default':
        base_path = ['vrf', 'name', vrf, 'protocols', 'static', 'route', network]
    else:
        base_path = ['protocols', 'static', 'route', network]

    if request.method == 'DELETE':
        ops = [{'op': 'delete', 'path': base_path}]
    else:
        route_type = data.get('type')
        target = data.get('target')
        distance = data.get('distance')

        if not route_type:
            return jsonify({'error': 'type is required'}), 400

        ops = []
        if route_type == 'next-hop':
            if not target:
                return jsonify({'error': 'target (next-hop IP) is required for next-hop routes'}), 400
            ops.append({'op': 'set', 'path': base_path + ['next-hop', target]})
            if distance:
                ops.append({'op': 'set', 'path': base_path + ['next-hop', target, 'distance', str(distance)]})
        elif route_type == 'blackhole':
            ops.append({'op': 'set', 'path': base_path + ['blackhole']})
            if distance:
                ops.append({'op': 'set', 'path': base_path + ['blackhole', 'distance', str(distance)]})
        elif route_type == 'interface':
            if not target:
                return jsonify({'error': 'target (interface name) is required for interface routes'}), 400
            ops.append({'op': 'set', 'path': base_path + ['interface', target]})
            if distance:
                ops.append({'op': 'set', 'path': base_path + ['interface', target, 'distance', str(distance)]})
        else:
            return jsonify({'error': 'Invalid route type. Use: next-hop, blackhole, or interface'}), 400

    result = apply_ops_dual(sess, ops, to_peer_requested=to_peer)
    action_name = 'route.delete' if request.method == 'DELETE' else 'route.create'
    target_str = f'{vrf or "default"}/{network}'
    _set_audit(action_name, target=target_str,
               nodes=result.get('applied_to'),
               commands=[{'cmd': ' '.join([op.get('op', '')] + list(op.get('path', [])))} for op in ops])
    return jsonify({'status': 'ok', 'message': 'Static route updated successfully', **result})


# ──────────────────────────────────────────────────────────────
#  BGP Configuration
# ──────────────────────────────────────────────────────────────
@app.route('/api/bgp')
@login_required
def bgp_config():
    """Devuelve configuración BGP."""
    sess = _get_session()
    cfg = sess.get('config') if sess else None
    if not cfg:
        return jsonify({})
    return jsonify(cfg.get('protocols', {}).get('bgp', {}))


@app.route('/api/bgp/neighbor', methods=['POST', 'DELETE'])
@login_required
@write_lock_required
def manage_bgp_neighbor():
    """Crear o eliminar neighbor BGP."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    active_api = sess['active_api']
    data = request.get_json() or {}
    neighbor_ip = data.get('neighbor')

    if not neighbor_ip:
        return jsonify({'error': 'neighbor IP is required'}), 400

    try:
        if request.method == 'DELETE':
            active_api.delete_path(['protocols', 'bgp', 'neighbor', neighbor_ip])
        else:
            remote_as = data.get('remote_as')
            if not remote_as:
                return jsonify({'error': 'remote_as is required'}), 400

            base_path = ['protocols', 'bgp', 'neighbor', neighbor_ip]
            ops = [{'op': 'set', 'path': base_path + ['remote-as', str(remote_as)]}]

            if data.get('description'):
                ops.append({'op': 'set', 'path': base_path + ['description', data['description']]})
            if data.get('update_source'):
                ops.append({'op': 'set', 'path': base_path + ['update-source', data['update_source']]})
            if data.get('ebgp_multihop'):
                ops.append({'op': 'set', 'path': base_path + ['ebgp-multihop', str(data['ebgp_multihop'])]})
            if data.get('password'):
                ops.append({'op': 'set', 'path': base_path + ['password', data['password']]})

            # Address family settings
            if data.get('ipv4_unicast'):
                af_path = base_path + ['address-family', 'ipv4-unicast']
                ops.append({'op': 'set', 'path': af_path})
                if data.get('soft_reconfiguration'):
                    ops.append({'op': 'set', 'path': af_path + ['soft-reconfiguration', 'inbound']})
                if data.get('route_map_import'):
                    ops.append({'op': 'set', 'path': af_path + ['route-map', 'import', data['route_map_import']]})
                if data.get('route_map_export'):
                    ops.append({'op': 'set', 'path': af_path + ['route-map', 'export', data['route_map_export']]})

            active_api.configure(ops)

        # Reload config
        raw = active_api.get_config()
        sess['raw_config'] = raw
        sess['config'] = load_config(raw)

        action_name = 'bgp.neighbor.delete' if request.method == 'DELETE' else 'bgp.neighbor.update'
        _set_audit(action_name, target=neighbor_ip)
        return jsonify({'status': 'ok', 'message': 'BGP neighbor updated successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/bgp/network', methods=['POST', 'DELETE'])
@login_required
@write_lock_required
def manage_bgp_network():
    """Añadir o eliminar network BGP."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    active_api = sess['active_api']
    data = request.get_json() or {}
    network = data.get('network')

    if not network:
        return jsonify({'error': 'network is required'}), 400

    try:
        path = ['protocols', 'bgp', 'address-family', 'ipv4-unicast', 'network', network]

        if request.method == 'DELETE':
            active_api.delete_path(path)
        else:
            active_api.configure([{'op': 'set', 'path': path}])

        # Reload config
        raw = active_api.get_config()
        sess['raw_config'] = raw
        sess['config'] = load_config(raw)

        action_name = 'bgp.network.delete' if request.method == 'DELETE' else 'bgp.network.create'
        _set_audit(action_name, target=network)
        return jsonify({'status': 'ok', 'message': 'BGP network updated successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/bgp/system-as', methods=['POST'])
@login_required
@write_lock_required
def set_bgp_system_as():
    """Configurar ASN local para BGP."""
    sess = _get_session()
    if not sess or not sess.get('active_api'):
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    active_api = sess['active_api']
    data = request.get_json() or {}
    system_as = data.get('system_as')

    if not system_as:
        return jsonify({'error': 'system_as is required'}), 400

    try:
        active_api.configure([{'op': 'set', 'path': ['protocols', 'bgp', 'system-as', str(system_as)]}])

        # Reload config
        raw = active_api.get_config()
        sess['raw_config'] = raw
        sess['config'] = load_config(raw)

        _set_audit('bgp.system-as.update', target=str(system_as))
        return jsonify({'status': 'ok', 'message': 'BGP system AS configured successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=True)
