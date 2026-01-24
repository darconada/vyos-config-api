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
        "system":    raw14.get("system",    {}),
        "service":   raw14.get("service",   {}),
        "protocols": raw14.get("protocols", {}),
        "policy":    raw14.get("policy",    {})
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
            # Crear/modificar regla
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
            # Crear/modificar regla
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


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=True)
