# app.py
"""
VyOS Config Viewer - API REST Version
Flask backend con conexión a VyOS via API REST oficial (1.4+)
"""
import os
import re
import sys
import secrets as _secrets
from flask import Flask, render_template, request, jsonify, redirect, session, url_for
import json
from vyos_api import VyOSAPI, VyOSAPIError
from auth import authenticate_with_ldap, login_required, load_vyos_defaults

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

# Variable global para almacenar la configuración
CONFIG = None
# Raw del primary tal y como lo devuelve la API (sin pasar por adapt_14).
# Lo guardamos para poder actualizarlo in-memory a partir de las ops sin
# tener que volver a llamar a get_config tras cada apply.
RAW_CONFIG = None
# Conexión API activa (para operaciones de escritura)
ACTIVE_API = None

# ──────────────────────────────────────────────────────────────
#  Estado de cluster HA (peer)
# ──────────────────────────────────────────────────────────────
# Conexión al nodo peer en caso de cluster HA
PEER_API = None
# Configuración cacheada del peer (se refresca en sync-check / peer connect)
PEER_CONFIG = None
# Raw del peer (mismo motivo que RAW_CONFIG).
RAW_PEER_CONFIG = None
# Info del cluster: { detected, primary_name, peer_name, peer_connected }
CLUSTER_INFO = None


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
        return render_template(
            'login.html',
            error='Error contactando con el servicio de autenticacion.',
            username=username,
        ), 500

    if ok:
        session['user'] = {'username': username}
        return redirect(url_for('index'))

    return render_template(
        'login.html',
        error='Credenciales invalidas o usuario sin permiso.',
        username=username,
    ), 401


@app.route('/logout', methods=['POST'])
def logout():
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
    global CONFIG
    f = request.files.get('file')
    if not f:
        return jsonify({'status': 'error', 'message': 'No file uploaded'}), 400
    try:
        CONFIG = load_config(json.load(f))
        return jsonify({'status': 'ok', 'data': CONFIG})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400


# ──────────────────────────────────────────────────────────────
#  API de lectura
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/rulesets')
@login_required
def firewall_rulesets():
    if not CONFIG:
        return jsonify([])
    return jsonify(list(CONFIG.get('firewall', {}).get('name', {}).keys()))


@app.route('/api/firewall/ruleset/<rs>')
@login_required
def firewall_ruleset(rs):
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('firewall', {}).get('name', {}).get(rs, {}))


@app.route('/api/firewall/group/<gtype>/<gname>')
@login_required
def firewall_group(gtype, gname):
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('firewall', {}).get('group', {}).get(f"{gtype}-group", {}).get(gname, {}))


@app.route('/api/<section>')
@login_required
def get_section(section):
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get(section.lower(), {}))


# ──────────────────────────────────────────────────────────────
#  API de lectura (Firewall Groups)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/groups')
@login_required
def firewall_groups():
    """Lista todos los grupos de firewall."""
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('firewall', {}).get('group', {}))


@app.route('/api/firewall/group-usage/<gtype>/<gname>')
@login_required
def firewall_group_usage(gtype, gname):
    """
    Devuelve las reglas que usan un grupo específico.
    Útil para verificar antes de eliminar un grupo.
    """
    if not CONFIG:
        return jsonify({'firewall': [], 'nat': []})

    references = {'firewall': [], 'nat': []}

    # Buscar en reglas de firewall
    for rs_name, rs_data in CONFIG.get('firewall', {}).get('name', {}).items():
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
        for rule_id, rule in CONFIG.get('nat', {}).get(nat_type, {}).get('rule', {}).items():
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
    """Obtiene configuración via API REST de VyOS."""
    global CONFIG, RAW_CONFIG, ACTIVE_API, PEER_API, PEER_CONFIG, RAW_PEER_CONFIG, CLUSTER_INFO

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
        # Guardamos host/port en el cliente para poder derivar el peer luego
        api.host = host
        api.port = port

        raw = api.get_config()  # Obtiene config completa
        RAW_CONFIG = raw  # Cacheamos el raw para updates in-memory
        CONFIG = load_config(raw)  # Aplica adaptador 1.3/1.4

        # Guardar conexión activa para operaciones de escritura
        ACTIVE_API = api

        # Nueva conexión → reseteamos cualquier peer previo
        PEER_API = None
        PEER_CONFIG = None
        RAW_PEER_CONFIG = None

        # Detectar si forma parte de un cluster HA
        cluster = detect_cluster(CONFIG)
        CLUSTER_INFO = cluster  # None si no hay cluster

        response = {'status': 'ok', 'data': CONFIG}
        if cluster:
            response['cluster_info'] = {**cluster, 'peer_connected': False}

        return jsonify(response)

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Unexpected error: {str(e)}'}), 500


@app.route('/fetch-peer', methods=['POST'])
@login_required
def fetch_peer():
    """
    Conecta al nodo peer del cluster HA.

    Por defecto reutiliza la api-key y puerto del nodo primario (ACTIVE_API).
    El frontend puede pasar un `api_key` y/o `port` para sobreescribirlos
    (se usa el fallback manual cuando el auto-connect falla).
    """
    global PEER_API, PEER_CONFIG, RAW_PEER_CONFIG, CLUSTER_INFO

    if not ACTIVE_API:
        return jsonify({'error': 'No primary connection. Connect to a router first.'}), 400
    if not CLUSTER_INFO or not CLUSTER_INFO.get('detected'):
        return jsonify({'error': 'Primary node is not part of a cluster'}), 400

    data = request.get_json() or {}
    peer_host = (data.get('host') or '').strip()
    if not peer_host:
        # Default: hostname derivado del primario (…-01 ↔ …-02)
        peer_host = CLUSTER_INFO.get('peer_name') or ''
    if not peer_host:
        return jsonify({'error': 'peer host is required'}), 400

    peer_key = (data.get('api_key') or '').strip() or ACTIVE_API.api_key
    peer_port = int(data.get('port') or getattr(ACTIVE_API, 'port', 443))

    try:
        peer = VyOSAPI(peer_host, peer_key, peer_port)
        peer.host = peer_host
        peer.port = peer_port
        raw = peer.get_config()
        peer_cfg = load_config(raw)

        # Validación: el hostname del peer debe ser el gemelo del primario
        peer_hostname = peer_cfg.get('system', {}).get('host-name')
        expected_peer = CLUSTER_INFO.get('peer_name')
        hostname_mismatch = (peer_hostname != expected_peer)

        PEER_API = peer
        PEER_CONFIG = peer_cfg
        RAW_PEER_CONFIG = raw
        CLUSTER_INFO = {**CLUSTER_INFO, 'peer_connected': True,
                        'peer_host': peer_host, 'peer_port': peer_port,
                        'peer_hostname_reported': peer_hostname}

        return jsonify({
            'status': 'ok',
            'cluster_info': CLUSTER_INFO,
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
    """Devuelve el estado actual del cluster."""
    return jsonify({
        'cluster_info': CLUSTER_INFO,
        'peer_connected': PEER_API is not None
    })


@app.route('/api/cluster/disconnect-peer', methods=['POST'])
@login_required
def disconnect_peer():
    """Desconecta del peer (vuelve a modo single-node)."""
    global PEER_API, PEER_CONFIG, RAW_PEER_CONFIG, CLUSTER_INFO
    PEER_API = None
    PEER_CONFIG = None
    RAW_PEER_CONFIG = None
    if CLUSTER_INFO:
        CLUSTER_INFO = {**CLUSTER_INFO, 'peer_connected': False}
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
    """Compara primary y peer. Si no hay peer, devuelve synchronized=true trivial."""
    global CONFIG, PEER_CONFIG, RAW_CONFIG, RAW_PEER_CONFIG
    if not ACTIVE_API:
        return jsonify({'error': 'No active connection'}), 400
    if not (CLUSTER_INFO and CLUSTER_INFO.get('detected') and PEER_API):
        return jsonify({'synchronized': True, 'cluster': False, 'differences': []})

    # Refrescar AMBAS caches para evitar falsos "synchronized=true" tras
    # un timeout en el que VyOS aplicó silenciosamente y nuestro cache quedó stale.
    try:
        raw_primary = ACTIVE_API.get_config()
        RAW_CONFIG = raw_primary
        CONFIG = load_config(raw_primary)
    except VyOSAPIError as e:
        return jsonify({'error': f'Primary unreachable: {str(e)}'}), 502

    try:
        raw_peer = PEER_API.get_config()
        RAW_PEER_CONFIG = raw_peer
        PEER_CONFIG = load_config(raw_peer)
    except VyOSAPIError as e:
        return jsonify({'error': f'Peer unreachable: {str(e)}'}), 502

    differences = compute_sync_diffs(CONFIG, PEER_CONFIG)
    return jsonify({
        'synchronized': len(differences) == 0,
        'cluster': True,
        'differences': differences,
        'primary_name': CLUSTER_INFO.get('primary_name'),
        'peer_name': CLUSTER_INFO.get('peer_name')
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
# codebase; otros (disable, log…) caerán al fallback de fetch — es seguro.
_VYOS_BOOLEAN_FLAGS = {'exclude'}


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


def _want_peer(to_peer_requested):
    """Decide si aplicar al peer, combinando request con estado global."""
    in_cluster = bool(CLUSTER_INFO and CLUSTER_INFO.get('detected') and PEER_API)
    if not in_cluster:
        return False
    if to_peer_requested is None:
        return True  # default en cluster = aplicar a ambos
    return bool(to_peer_requested)


def apply_ops_dual(ops, to_peer_requested=None, require_sync=True):
    """
    Aplica una lista de operaciones VyOS al primary y opcionalmente al peer.

    Args:
      ops: lista [{op, path}, ...]
      to_peer_requested: True/False/None (None = default del cluster)
      require_sync: si True y aplica al peer, hace pre-flight sync-check

    Returns: dict con información ({applied, nodes, peer_synced_before, ...})
    Raises DualApplyError (serializa a HTTP) en:
      - 409: cluster no sincronizado (pre-flight)
      - 502: peer inaccesible
      - 500: fallo de apply (primary o peer)
    """
    global CONFIG, PEER_CONFIG, RAW_CONFIG, RAW_PEER_CONFIG

    if not ops:
        return {'applied': 0, 'nodes': []}

    do_peer = _want_peer(to_peer_requested)

    # Pre-flight sync check (solo si se va a aplicar al peer)
    if do_peer and require_sync:
        try:
            raw_peer = PEER_API.get_config()
            RAW_PEER_CONFIG = raw_peer
            PEER_CONFIG = load_config(raw_peer)
        except VyOSAPIError as e:
            raise DualApplyError(502, {'error': f'Peer inaccesible: {str(e)}'})
        diffs = compute_sync_diffs(CONFIG, PEER_CONFIG)
        if diffs:
            raise DualApplyError(409, {
                'error': 'Los nodos del cluster no están sincronizados. Apply bloqueado.',
                'synchronized': False,
                'differences': diffs,
                'primary_name': CLUSTER_INFO.get('primary_name'),
                'peer_name': CLUSTER_INFO.get('peer_name')
            })

    # Apply al primary
    primary_err = None
    try:
        ACTIVE_API.configure(ops)
    except VyOSAPIError as e:
        primary_err = str(e)

    if primary_err is not None:
        # Crítico: aunque la API haya cortado por timeout, VyOS puede haber
        # aplicado igualmente. Refrescamos CONFIG SIEMPRE para que la UI no
        # quede mintiendo con un estado obsoleto.
        try:
            raw = ACTIVE_API.get_config()
            RAW_CONFIG = raw
            CONFIG = load_config(raw)
        except VyOSAPIError:
            pass
        raise DualApplyError(500, {
            'error': f'Primary apply failed: {primary_err}',
            'hint': 'CONFIG ha sido refrescado: si la operación finalmente se aplicó '
                    'en primary la UI lo verá en el próximo render. El peer no se ha tocado.'
        })

    # Update in-memory de CONFIG (sin refetch) si se puede; si no, fallback a refetch.
    if not (RAW_CONFIG is not None and apply_ops_in_memory(RAW_CONFIG, ops)):
        try:
            raw = ACTIVE_API.get_config()
            RAW_CONFIG = raw
        except VyOSAPIError:
            pass
    if RAW_CONFIG is not None:
        CONFIG = load_config(RAW_CONFIG)

    if not do_peer:
        return {'applied_to': ['primary'], 'nodes': 1}

    # Apply al peer
    try:
        PEER_API.configure(ops)
        # Update in-memory de PEER_CONFIG; fallback a refetch si la heurística falla.
        if not (RAW_PEER_CONFIG is not None and apply_ops_in_memory(RAW_PEER_CONFIG, ops)):
            try:
                raw_peer = PEER_API.get_config()
                RAW_PEER_CONFIG = raw_peer
            except VyOSAPIError:
                pass
        if RAW_PEER_CONFIG is not None:
            PEER_CONFIG = load_config(RAW_PEER_CONFIG)
        return {'applied_to': ['primary', 'peer'], 'nodes': 2}
    except VyOSAPIError as e:
        peer_err = str(e)
        # Refrescamos PEER_CONFIG por si VyOS aplicó silenciosamente tras un timeout.
        try:
            raw_peer = PEER_API.get_config()
            RAW_PEER_CONFIG = raw_peer
            PEER_CONFIG = load_config(raw_peer)
        except VyOSAPIError:
            pass
        # Rollback best-effort en primary
        rollback_ops = _reverse_ops(ops)
        rollback_status = 'skipped'
        if rollback_ops:
            try:
                ACTIVE_API.configure(rollback_ops)
                # Tras rollback, mejor refetch real del primary (estamos en ruta de error).
                try:
                    raw = ACTIVE_API.get_config()
                    RAW_CONFIG = raw
                    CONFIG = load_config(raw)
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


# ──────────────────────────────────────────────────────────────
#  API de escritura (Firewall)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/rule', methods=['POST', 'PUT', 'DELETE'])
@login_required
def manage_firewall_rule():
    """Crear, modificar o eliminar regla de firewall."""
    if not ACTIVE_API:
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

    result = apply_ops_dual(ops, to_peer_requested=to_peer)
    return jsonify({'status': 'ok', 'message': 'Rule updated successfully', **result})


# ──────────────────────────────────────────────────────────────
#  API de escritura (NAT)
# ──────────────────────────────────────────────────────────────
@app.route('/api/nat/rule', methods=['POST', 'PUT', 'DELETE'])
@login_required
def manage_nat_rule():
    """Crear, modificar o eliminar regla NAT."""
    if not ACTIVE_API:
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

    result = apply_ops_dual(ops, to_peer_requested=to_peer)
    return jsonify({'status': 'ok', 'message': 'NAT rule updated successfully', **result})


# ──────────────────────────────────────────────────────────────
#  API de escritura (Firewall Groups)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/group', methods=['POST', 'PUT', 'DELETE'])
@login_required
def manage_firewall_group():
    """Crear, modificar o eliminar grupo de firewall."""
    if not ACTIVE_API:
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

    result = apply_ops_dual(ops, to_peer_requested=to_peer)
    return jsonify({'status': 'ok', 'message': 'Group updated successfully', **result})


# ──────────────────────────────────────────────────────────────
#  Batch Configure (Staged Changes)
# ──────────────────────────────────────────────────────────────
@app.route('/api/batch-configure', methods=['POST'])
@login_required
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
    if not ACTIVE_API:
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

    result = apply_ops_dual(vyos_ops, to_peer_requested=to_peer)
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
def save_config_to_router():
    """Guarda configuración en el router. En cluster, guarda también en el peer por defecto."""
    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json(silent=True) or {}
    to_peer = data.get('apply_to_peer')
    do_peer = _want_peer(to_peer)

    try:
        ACTIVE_API.save_config()
    except VyOSAPIError as e:
        return jsonify({'error': f'Primary save failed: {str(e)}'}), 500

    if not do_peer:
        return jsonify({'status': 'ok', 'message': 'Configuration saved', 'nodes': ['primary']})

    try:
        PEER_API.save_config()
    except VyOSAPIError as e:
        return jsonify({
            'status': 'partial',
            'message': 'Primary saved, peer save failed',
            'nodes': ['primary'],
            'peer_error': str(e)
        }), 500

    return jsonify({'status': 'ok', 'message': 'Configuration saved on both nodes',
                    'nodes': ['primary', 'peer']})


# ──────────────────────────────────────────────────────────────
#  Estado de conexión
# ──────────────────────────────────────────────────────────────
@app.route('/api/connection-status')
@login_required
def connection_status():
    """Devuelve el estado de la conexión."""
    return jsonify({
        'connected': ACTIVE_API is not None,
        'config_loaded': CONFIG is not None,
        'cluster_info': CLUSTER_INFO,
        'peer_connected': PEER_API is not None
    })


# ──────────────────────────────────────────────────────────────
#  Dashboard Stats
# ──────────────────────────────────────────────────────────────
@app.route('/api/dashboard-stats')
@login_required
def dashboard_stats():
    """Devuelve estadísticas para el dashboard."""
    if not CONFIG:
        return jsonify({})

    def count_interfaces(cfg):
        total = 0
        for itype in cfg.get('interfaces', {}).values():
            if isinstance(itype, dict):
                total += len(itype)
        return total

    # Count firewall rulesets and rules
    fw_name = CONFIG.get('firewall', {}).get('name', {})
    firewall_rulesets = len(fw_name)
    firewall_rules = sum(len(rs.get('rule', {})) for rs in fw_name.values())

    # Count NAT rules
    nat_dest = len(CONFIG.get('nat', {}).get('destination', {}).get('rule', {}))
    nat_source = len(CONFIG.get('nat', {}).get('source', {}).get('rule', {}))

    # Count groups
    groups = CONFIG.get('firewall', {}).get('group', {})
    address_groups = len(groups.get('address-group', {}))
    network_groups = len(groups.get('network-group', {}))
    port_groups = len(groups.get('port-group', {}))

    # Count static routes
    static_routes = len(CONFIG.get('protocols', {}).get('static', {}).get('route', {}))

    # Count BGP neighbors
    bgp = CONFIG.get('protocols', {}).get('bgp', {})
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
        'interfaces': count_interfaces(CONFIG),
        'routing': {
            'static_routes': static_routes,
            'bgp_neighbors': bgp_neighbors,
            'bgp_networks': bgp_networks
        },
        'system': {
            'hostname': CONFIG.get('system', {}).get('host-name', 'Unknown')
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
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('interfaces', {}))


# ──────────────────────────────────────────────────────────────
#  VRFs
# ──────────────────────────────────────────────────────────────
@app.route('/api/vrfs')
@login_required
def list_vrfs():
    """Devuelve lista de VRFs configurados."""
    if not CONFIG:
        return jsonify([])
    vrfs = CONFIG.get('vrf', {}).get('name', {})
    return jsonify(list(vrfs.keys()))


# ──────────────────────────────────────────────────────────────
#  Static Routes
# ──────────────────────────────────────────────────────────────
@app.route('/api/static-routes')
@login_required
def static_routes():
    """Devuelve rutas estáticas de todos los VRFs."""
    if not CONFIG:
        return jsonify({'default': {}, 'vrfs': {}})

    # Rutas del VRF default (protocols.static.route)
    default_routes = CONFIG.get('protocols', {}).get('static', {}).get('route', {})

    # Rutas de VRFs específicos (vrf.name.<vrf>.protocols.static.route)
    vrf_routes = {}
    vrfs = CONFIG.get('vrf', {}).get('name', {})
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
def manage_static_route():
    """Crear o eliminar ruta estática (default VRF o VRF específico)."""
    if not ACTIVE_API:
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

    result = apply_ops_dual(ops, to_peer_requested=to_peer)
    return jsonify({'status': 'ok', 'message': 'Static route updated successfully', **result})


# ──────────────────────────────────────────────────────────────
#  BGP Configuration
# ──────────────────────────────────────────────────────────────
@app.route('/api/bgp')
@login_required
def bgp_config():
    """Devuelve configuración BGP."""
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('protocols', {}).get('bgp', {}))


@app.route('/api/bgp/neighbor', methods=['POST', 'DELETE'])
@login_required
def manage_bgp_neighbor():
    """Crear o eliminar neighbor BGP."""
    global CONFIG

    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    neighbor_ip = data.get('neighbor')

    if not neighbor_ip:
        return jsonify({'error': 'neighbor IP is required'}), 400

    try:
        if request.method == 'DELETE':
            ACTIVE_API.delete_path(['protocols', 'bgp', 'neighbor', neighbor_ip])
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

            ACTIVE_API.configure(ops)

        # Reload config
        raw = ACTIVE_API.get_config()
        CONFIG = load_config(raw)

        return jsonify({'status': 'ok', 'message': 'BGP neighbor updated successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/bgp/network', methods=['POST', 'DELETE'])
@login_required
def manage_bgp_network():
    """Añadir o eliminar network BGP."""
    global CONFIG

    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    network = data.get('network')

    if not network:
        return jsonify({'error': 'network is required'}), 400

    try:
        path = ['protocols', 'bgp', 'address-family', 'ipv4-unicast', 'network', network]

        if request.method == 'DELETE':
            ACTIVE_API.delete_path(path)
        else:
            ACTIVE_API.configure([{'op': 'set', 'path': path}])

        # Reload config
        raw = ACTIVE_API.get_config()
        CONFIG = load_config(raw)

        return jsonify({'status': 'ok', 'message': 'BGP network updated successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/bgp/system-as', methods=['POST'])
@login_required
def set_bgp_system_as():
    """Configurar ASN local para BGP."""
    global CONFIG

    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    system_as = data.get('system_as')

    if not system_as:
        return jsonify({'error': 'system_as is required'}), 400

    try:
        ACTIVE_API.configure([{'op': 'set', 'path': ['protocols', 'bgp', 'system-as', str(system_as)]}])

        # Reload config
        raw = ACTIVE_API.get_config()
        CONFIG = load_config(raw)

        return jsonify({'status': 'ok', 'message': 'BGP system AS configured successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=True)
