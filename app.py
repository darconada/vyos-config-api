# app.py
"""
VyOS Config Viewer - API REST Version
Flask backend con conexión a VyOS via API REST oficial (1.4+)
"""
from flask import Flask, render_template, request, jsonify
import json
from vyos_api import VyOSAPI, VyOSAPIError

app = Flask(__name__)

# Variable global para almacenar la configuración
CONFIG = None
# Conexión API activa (para operaciones de escritura)
ACTIVE_API = None


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
        "system":     raw14.get("system",     {}),
        "service":    raw14.get("service",    {}),
        "protocols":  raw14.get("protocols",  {}),
        "policy":     raw14.get("policy",     {}),
        "interfaces": raw14.get("interfaces", {}),
        "vrf":        raw14.get("vrf",        {})
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


def load_config(raw):
    """Detecta versión y devuelve el formato interno unificado."""
    if "firewall" in raw and "ipv4" in raw["firewall"]:
        # Detectamos que es 1.4 (tiene firewall.ipv4)
        return adapt_14(raw)
    # Caso 1.3 u "antiguo": ya está en formato interno
    return raw


# ──────────────────────────────────────────────────────────────
#  Rutas básicas
# ──────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/upload', methods=['POST'])
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
def firewall_rulesets():
    if not CONFIG:
        return jsonify([])
    return jsonify(list(CONFIG.get('firewall', {}).get('name', {}).keys()))


@app.route('/api/firewall/ruleset/<rs>')
def firewall_ruleset(rs):
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('firewall', {}).get('name', {}).get(rs, {}))


@app.route('/api/firewall/group/<gtype>/<gname>')
def firewall_group(gtype, gname):
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('firewall', {}).get('group', {}).get(f"{gtype}-group", {}).get(gname, {}))


@app.route('/api/<section>')
def get_section(section):
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get(section.lower(), {}))


# ──────────────────────────────────────────────────────────────
#  API de lectura (Firewall Groups)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/groups')
def firewall_groups():
    """Lista todos los grupos de firewall."""
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('firewall', {}).get('group', {}))


@app.route('/api/firewall/group-usage/<gtype>/<gname>')
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
def fetch_config():
    """Obtiene configuración via API REST de VyOS."""
    global CONFIG, ACTIVE_API

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
        raw = api.get_config()  # Obtiene config completa
        CONFIG = load_config(raw)  # Aplica adaptador 1.3/1.4

        # Guardar conexión activa para operaciones de escritura
        ACTIVE_API = api

        return jsonify({'status': 'ok', 'data': CONFIG})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Unexpected error: {str(e)}'}), 500


# ──────────────────────────────────────────────────────────────
#  API de escritura (Firewall)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/rule', methods=['POST', 'PUT', 'DELETE'])
def manage_firewall_rule():
    """Crear, modificar o eliminar regla de firewall."""
    global CONFIG

    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    ruleset = data.get('ruleset')
    rule_id = data.get('rule_id')

    if not ruleset or not rule_id:
        return jsonify({'error': 'ruleset and rule_id are required'}), 400

    try:
        if request.method == 'DELETE':
            # Eliminar regla
            ACTIVE_API.delete_firewall_rule(ruleset, rule_id)
        else:
            # Check if this is a differential update
            diff = data.get('diff')
            if diff:
                # Differential update - only change what's different
                base_path = ['firewall', 'ipv4', 'name', ruleset, 'rule', str(rule_id)]
                ops = build_diff_operations(base_path, diff)
                if ops:
                    ACTIVE_API.configure(ops)
            else:
                # Full create/update (legacy behavior)
                rule_data = data.get('rule', {})
                if not rule_data:
                    return jsonify({'error': 'rule data is required'}), 400
                ACTIVE_API.create_firewall_rule(ruleset, rule_id, rule_data)

        # Recargar configuración
        raw = ACTIVE_API.get_config()
        CONFIG = load_config(raw)

        return jsonify({'status': 'ok', 'message': 'Rule updated successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


# ──────────────────────────────────────────────────────────────
#  API de escritura (NAT)
# ──────────────────────────────────────────────────────────────
@app.route('/api/nat/rule', methods=['POST', 'PUT', 'DELETE'])
def manage_nat_rule():
    """Crear, modificar o eliminar regla NAT."""
    global CONFIG

    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    nat_type = data.get('nat_type')  # 'source' o 'destination'
    rule_id = data.get('rule_id')

    if not nat_type or not rule_id:
        return jsonify({'error': 'nat_type and rule_id are required'}), 400

    if nat_type not in ['source', 'destination']:
        return jsonify({'error': 'nat_type must be "source" or "destination"'}), 400

    try:
        if request.method == 'DELETE':
            # Eliminar regla
            ACTIVE_API.delete_nat_rule(nat_type, rule_id)
        else:
            # Check if this is a differential update
            diff = data.get('diff')
            if diff:
                # Differential update - only change what's different
                base_path = ['nat', nat_type, 'rule', str(rule_id)]
                ops = build_diff_operations(base_path, diff)
                if ops:
                    ACTIVE_API.configure(ops)
            else:
                # Full create/update (legacy behavior)
                rule_data = data.get('rule', {})
                if not rule_data:
                    return jsonify({'error': 'rule data is required'}), 400
                ACTIVE_API.create_nat_rule(nat_type, rule_id, rule_data)

        # Recargar configuración
        raw = ACTIVE_API.get_config()
        CONFIG = load_config(raw)

        return jsonify({'status': 'ok', 'message': 'NAT rule updated successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


# ──────────────────────────────────────────────────────────────
#  API de escritura (Firewall Groups)
# ──────────────────────────────────────────────────────────────
@app.route('/api/firewall/group', methods=['POST', 'PUT', 'DELETE'])
def manage_firewall_group():
    """Crear, modificar o eliminar grupo de firewall."""
    global CONFIG

    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    group_type = data.get('group_type')  # 'address', 'network', 'port'
    group_name = data.get('group_name')

    if not group_type or not group_name:
        return jsonify({'error': 'group_type and group_name are required'}), 400

    if group_type not in ['address', 'network', 'port']:
        return jsonify({'error': 'group_type must be "address", "network", or "port"'}), 400

    try:
        if request.method == 'DELETE':
            # Eliminar grupo
            ACTIVE_API.delete_firewall_group(group_type, group_name)
        else:
            # Check if this is a differential update
            diff = data.get('diff')
            if diff:
                # Differential update - only change what's different
                base_path = ['firewall', 'group', f'{group_type}-group', group_name]
                ops = build_diff_operations(base_path, diff)
                if ops:
                    ACTIVE_API.configure(ops)
            else:
                # Full create/update
                entries = data.get('entries', [])
                description = data.get('description')
                ACTIVE_API.create_firewall_group(group_type, group_name, entries, description)

        # Recargar configuración
        raw = ACTIVE_API.get_config()
        CONFIG = load_config(raw)

        return jsonify({'status': 'ok', 'message': 'Group updated successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


# ──────────────────────────────────────────────────────────────
#  Batch Configure (Staged Changes)
# ──────────────────────────────────────────────────────────────
@app.route('/api/batch-configure', methods=['POST'])
def batch_configure():
    """
    Aplica múltiples operaciones en una sola llamada.

    Espera un JSON con:
    {
        "operations": [
            { "type": "firewall", "action": "create", "data": {...} },
            { "type": "firewall", "action": "delete", "data": {...} },
            { "type": "nat", "action": "create", "data": {...} },
            ...
        ]
    }
    """
    global CONFIG

    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    operations = data.get('operations', [])

    if not operations:
        return jsonify({'error': 'No operations provided'}), 400

    try:
        # Construir lista de operaciones VyOS
        vyos_ops = []
        for op in operations:
            vyos_ops.extend(build_vyos_operations(op))

        if not vyos_ops:
            return jsonify({'error': 'No valid operations to execute'}), 400

        # Ejecutar todas en una sola llamada
        ACTIVE_API.configure(vyos_ops)

        # Refrescar config
        raw = ACTIVE_API.get_config()
        CONFIG = load_config(raw)

        return jsonify({
            'success': True,
            'applied': len(operations),
            'vyos_operations': len(vyos_ops)
        })

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Unexpected error: {str(e)}'}), 500


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
def save_config_to_router():
    """Guarda configuración en el router."""
    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    try:
        ACTIVE_API.save_config()
        return jsonify({'status': 'ok', 'message': 'Configuration saved'})
    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


# ──────────────────────────────────────────────────────────────
#  Estado de conexión
# ──────────────────────────────────────────────────────────────
@app.route('/api/connection-status')
def connection_status():
    """Devuelve el estado de la conexión."""
    return jsonify({
        'connected': ACTIVE_API is not None,
        'config_loaded': CONFIG is not None
    })


# ──────────────────────────────────────────────────────────────
#  Dashboard Stats
# ──────────────────────────────────────────────────────────────
@app.route('/api/dashboard-stats')
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
def interfaces():
    """Devuelve configuración de interfaces."""
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('interfaces', {}))


# ──────────────────────────────────────────────────────────────
#  VRFs
# ──────────────────────────────────────────────────────────────
@app.route('/api/vrfs')
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
def manage_static_route():
    """Crear o eliminar ruta estática."""
    global CONFIG

    if not ACTIVE_API:
        return jsonify({'error': 'No active connection. Connect to router first.'}), 400

    data = request.get_json() or {}
    network = data.get('network')
    vrf = data.get('vrf')  # None or VRF name (not 'default')

    if not network:
        return jsonify({'error': 'network is required'}), 400

    # Build base path depending on VRF
    # Default VRF: protocols static route NETWORK
    # Named VRF:   vrf name VRF_NAME protocols static route NETWORK
    if vrf and vrf != 'default':
        base_path = ['vrf', 'name', vrf, 'protocols', 'static', 'route', network]
    else:
        base_path = ['protocols', 'static', 'route', network]

    try:
        if request.method == 'DELETE':
            # Delete entire route (not just the next-hop)
            # This removes the whole route entry regardless of target type
            ACTIVE_API.delete_path(base_path)
        else:
            # Create route
            route_type = data.get('type')  # 'next-hop', 'blackhole', 'interface'
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

            ACTIVE_API.configure(ops)

        # Reload config
        raw = ACTIVE_API.get_config()
        CONFIG = load_config(raw)

        return jsonify({'status': 'ok', 'message': 'Static route updated successfully'})

    except VyOSAPIError as e:
        return jsonify({'error': str(e)}), 500


# ──────────────────────────────────────────────────────────────
#  BGP Configuration
# ──────────────────────────────────────────────────────────────
@app.route('/api/bgp')
def bgp_config():
    """Devuelve configuración BGP."""
    if not CONFIG:
        return jsonify({})
    return jsonify(CONFIG.get('protocols', {}).get('bgp', {}))


@app.route('/api/bgp/neighbor', methods=['POST', 'DELETE'])
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
