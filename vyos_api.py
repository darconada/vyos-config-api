# vyos_api.py
"""
Cliente REST API para VyOS 1.4+
Basado en la documentación oficial: https://docs.vyos.io/en/1.4/automation/vyos-api.html
"""

import requests
import json
from urllib3.exceptions import InsecureRequestWarning

# Deshabilitar warnings de SSL para certificados self-signed
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)


class VyOSAPIError(Exception):
    """Excepción personalizada para errores de la API VyOS"""
    pass


class VyOSAPI:
    """Cliente para API REST de VyOS 1.4+"""

    def __init__(self, host, api_key, port=443, verify_ssl=False, timeout=60, configure_timeout=120):
        """
        Inicializa el cliente API.

        Args:
            host: IP o hostname del router VyOS
            api_key: API key configurada en VyOS
            port: Puerto HTTPS (default: 443)
            verify_ssl: Verificar certificado SSL (default: False para self-signed)
            timeout: Timeout para requests en segundos (default: 60)
            configure_timeout: Timeout para operaciones de configuración (default: 120)
        """
        self.base_url = f"https://{host}:{port}"
        self.api_key = api_key
        self.verify_ssl = verify_ssl
        self.timeout = timeout
        self.configure_timeout = configure_timeout

    def _request(self, endpoint, data, use_configure_timeout=False):
        """
        Ejecuta request POST a la API.

        Args:
            endpoint: Endpoint de la API (retrieve, configure, etc.)
            data: Datos a enviar (dict o list)
            use_configure_timeout: Usar timeout extendido para operaciones de configuración

        Returns:
            Datos de respuesta de la API

        Raises:
            VyOSAPIError: Si la API devuelve un error
        """
        url = f"{self.base_url}/{endpoint}"
        payload = {
            'key': self.api_key,
            'data': json.dumps(data) if isinstance(data, (dict, list)) else data
        }

        # Usar timeout extendido para operaciones de configuración
        timeout = self.configure_timeout if use_configure_timeout else self.timeout

        try:
            resp = requests.post(
                url,
                data=payload,
                verify=self.verify_ssl,
                timeout=timeout
            )
            resp.raise_for_status()
            result = resp.json()

            if not result.get('success'):
                error_msg = result.get('error', 'Unknown API error')
                raise VyOSAPIError(error_msg)

            return result.get('data')

        except requests.exceptions.Timeout:
            raise VyOSAPIError(f'Connection timeout after {timeout}s - the operation may still be in progress on VyOS')
        except requests.exceptions.ConnectionError as e:
            raise VyOSAPIError(f'Connection failed: {str(e)}')
        except requests.exceptions.HTTPError as e:
            raise VyOSAPIError(f'HTTP error: {str(e)}')
        except json.JSONDecodeError:
            raise VyOSAPIError('Invalid JSON response from API')

    # ========== RETRIEVE (Lectura) ==========

    def get_config(self, path=None):
        """
        Obtiene configuración completa o parcial.

        Args:
            path: Lista de strings con la ruta (opcional).
                  Ej: ['firewall', 'ipv4', 'name'] para obtener solo rulesets

        Returns:
            dict: Configuración en formato JSON
        """
        return self._request('retrieve', {
            'op': 'showConfig',
            'path': path or []
        })

    def get_firewall(self):
        """Obtiene solo configuración de firewall."""
        return self._request('retrieve', {
            'op': 'showConfig',
            'path': ['firewall']
        })

    def get_nat(self):
        """Obtiene solo configuración de NAT."""
        return self._request('retrieve', {
            'op': 'showConfig',
            'path': ['nat']
        })

    def get_firewall_group(self, group_type, group_name):
        """
        Obtiene un grupo específico de firewall.

        Args:
            group_type: Tipo de grupo (address, network, port)
            group_name: Nombre del grupo

        Returns:
            dict: Contenido del grupo
        """
        return self._request('retrieve', {
            'op': 'showConfig',
            'path': ['firewall', 'group', f'{group_type}-group', group_name]
        })

    def path_exists(self, path):
        """
        Verifica si existe una ruta de configuración.

        Args:
            path: Lista de strings con la ruta

        Returns:
            bool: True si existe
        """
        return self._request('retrieve', {
            'op': 'exists',
            'path': path
        })

    def return_values(self, path):
        """
        Obtiene valores de un nodo multi-valor.

        Args:
            path: Lista de strings con la ruta

        Returns:
            list: Lista de valores
        """
        return self._request('retrieve', {
            'op': 'returnValues',
            'path': path
        })

    # ========== CONFIGURE (Escritura) ==========

    def configure(self, operations):
        """
        Aplica operaciones de configuración.

        Args:
            operations: Lista de operaciones, cada una con:
                - op: 'set', 'delete', o 'comment'
                - path: Lista de strings con la ruta

        Ejemplo:
            api.configure([
                {'op': 'set', 'path': ['firewall', 'ipv4', 'name', 'WAN-IN', 'rule', '10', 'action', 'accept']},
                {'op': 'set', 'path': ['firewall', 'ipv4', 'name', 'WAN-IN', 'rule', '10', 'protocol', 'tcp']}
            ])
        """
        return self._request('configure', operations, use_configure_timeout=True)

    def set_path(self, path):
        """
        Atajo para un solo 'set'.

        Args:
            path: Lista de strings con la ruta completa incluyendo valor
        """
        return self.configure([{'op': 'set', 'path': path}])

    def delete_path(self, path):
        """
        Atajo para un solo 'delete'.

        Args:
            path: Lista de strings con la ruta a eliminar
        """
        return self.configure([{'op': 'delete', 'path': path}])

    def comment_path(self, path, comment):
        """
        Añade un comentario a una ruta.

        Args:
            path: Lista de strings con la ruta
            comment: Comentario a añadir
        """
        return self.configure([{'op': 'comment', 'path': path + [comment]}])

    # ========== OPERACIONES DE SISTEMA ==========

    def save_config(self, file=None):
        """
        Guarda configuración a archivo.

        Args:
            file: Ruta del archivo (opcional, usa default si no se especifica)
        """
        data = {'op': 'save'}
        if file:
            data['file'] = file
        return self._request('config-file', data, use_configure_timeout=True)

    def load_config(self, file):
        """
        Carga configuración desde archivo.

        Args:
            file: Ruta del archivo a cargar
        """
        return self._request('config-file', {
            'op': 'load',
            'file': file
        }, use_configure_timeout=True)

    # ========== HELPERS PARA FIREWALL ==========

    def create_firewall_rule(self, ruleset_name, rule_id, rule_data):
        """
        Crea o modifica una regla de firewall IPv4.

        Args:
            ruleset_name: Nombre del ruleset (ej: 'WAN-IN')
            rule_id: ID de la regla (ej: '10')
            rule_data: dict con los campos de la regla:
                - action: 'accept', 'drop', 'reject', 'return', 'continue', 'jump', 'queue'
                - jump-target: Ruleset destino (requerido si action es 'jump')
                - protocol: 'tcp', 'udp', 'icmp', 'all', 'tcp_udp', 'gre', 'esp', 'ah'
                - description: Descripción de la regla
                - source: dict con 'address', 'port', o 'group'
                - destination: dict con 'address', 'port', o 'group'

        Ejemplo:
            api.create_firewall_rule('WAN-IN', '10', {
                'action': 'accept',
                'protocol': 'tcp',
                'description': 'Allow HTTPS',
                'destination': {'port': '443'}
            })

        Ejemplo con jump:
            api.create_firewall_rule('WAN-IN', '20', {
                'action': 'jump',
                'jump-target': 'CUSTOM-CHAIN',
                'description': 'Jump to custom chain'
            })
        """
        base_path = ['firewall', 'ipv4', 'name', ruleset_name, 'rule', str(rule_id)]
        ops = []

        if rule_data.get('action'):
            ops.append({'op': 'set', 'path': base_path + ['action', rule_data['action']]})

        # Jump target (required when action is 'jump')
        if rule_data.get('jump-target'):
            ops.append({'op': 'set', 'path': base_path + ['jump-target', rule_data['jump-target']]})

        if rule_data.get('protocol'):
            ops.append({'op': 'set', 'path': base_path + ['protocol', rule_data['protocol']]})

        if rule_data.get('description'):
            ops.append({'op': 'set', 'path': base_path + ['description', rule_data['description']]})

        # Source
        src = rule_data.get('source', {})
        if src.get('address'):
            ops.append({'op': 'set', 'path': base_path + ['source', 'address', src['address']]})
        if src.get('port'):
            ops.append({'op': 'set', 'path': base_path + ['source', 'port', str(src['port'])]})
        if src.get('group'):
            for gtype, gname in src['group'].items():
                ops.append({'op': 'set', 'path': base_path + ['source', 'group', gtype, gname]})

        # Destination
        dst = rule_data.get('destination', {})
        if dst.get('address'):
            ops.append({'op': 'set', 'path': base_path + ['destination', 'address', dst['address']]})
        if dst.get('port'):
            ops.append({'op': 'set', 'path': base_path + ['destination', 'port', str(dst['port'])]})
        if dst.get('group'):
            for gtype, gname in dst['group'].items():
                ops.append({'op': 'set', 'path': base_path + ['destination', 'group', gtype, gname]})

        return self.configure(ops)

    def delete_firewall_rule(self, ruleset_name, rule_id):
        """
        Elimina una regla de firewall.

        Args:
            ruleset_name: Nombre del ruleset
            rule_id: ID de la regla a eliminar
        """
        path = ['firewall', 'ipv4', 'name', ruleset_name, 'rule', str(rule_id)]
        return self.delete_path(path)

    # ========== HELPERS PARA NAT ==========

    def create_nat_rule(self, nat_type, rule_id, rule_data):
        """
        Crea o modifica una regla NAT.

        Args:
            nat_type: 'source' o 'destination'
            rule_id: ID de la regla
            rule_data: dict con los campos de la regla:
                - description: Descripción
                - protocol: 'tcp', 'udp', 'all'
                - exclude: bool - Si True, excluye el tráfico de NAT
                - source/destination: dict con 'address', 'port'
                - translation: dict con 'address', 'port' (no requerido si exclude=True)
                - inbound-interface/outbound-interface: dict con 'name'

        Ejemplo DNAT:
            api.create_nat_rule('destination', '100', {
                'description': 'Port forward HTTP',
                'protocol': 'tcp',
                'destination': {'port': '80'},
                'translation': {'address': '192.168.1.100'},
                'inbound-interface': {'name': 'eth0'}
            })

        Ejemplo Exclude (para VPN/IPsec):
            api.create_nat_rule('source', '10', {
                'description': 'Exclude VPN traffic from NAT',
                'exclude': True,
                'source': {'address': '192.168.0.0/24'},
                'destination': {'address': '192.168.1.0/24'},
                'outbound-interface': {'name': 'eth0'}
            })
        """
        base_path = ['nat', nat_type, 'rule', str(rule_id)]
        ops = []

        if rule_data.get('description'):
            ops.append({'op': 'set', 'path': base_path + ['description', rule_data['description']]})

        # Exclude flag (no translation needed when this is set)
        if rule_data.get('exclude'):
            ops.append({'op': 'set', 'path': base_path + ['exclude']})

        if rule_data.get('protocol'):
            ops.append({'op': 'set', 'path': base_path + ['protocol', rule_data['protocol']]})

        # Source
        src = rule_data.get('source', {})
        if src.get('address'):
            ops.append({'op': 'set', 'path': base_path + ['source', 'address', src['address']]})
        if src.get('port'):
            ops.append({'op': 'set', 'path': base_path + ['source', 'port', str(src['port'])]})

        # Destination
        dst = rule_data.get('destination', {})
        if dst.get('address'):
            ops.append({'op': 'set', 'path': base_path + ['destination', 'address', dst['address']]})
        if dst.get('port'):
            ops.append({'op': 'set', 'path': base_path + ['destination', 'port', str(dst['port'])]})

        # Translation
        trans = rule_data.get('translation', {})
        if trans.get('address'):
            ops.append({'op': 'set', 'path': base_path + ['translation', 'address', trans['address']]})
        if trans.get('port'):
            ops.append({'op': 'set', 'path': base_path + ['translation', 'port', str(trans['port'])]})

        # Interfaces
        if rule_data.get('inbound-interface', {}).get('name'):
            ops.append({'op': 'set', 'path': base_path + ['inbound-interface', 'name', rule_data['inbound-interface']['name']]})
        if rule_data.get('outbound-interface', {}).get('name'):
            ops.append({'op': 'set', 'path': base_path + ['outbound-interface', 'name', rule_data['outbound-interface']['name']]})

        return self.configure(ops)

    def delete_nat_rule(self, nat_type, rule_id):
        """
        Elimina una regla NAT.

        Args:
            nat_type: 'source' o 'destination'
            rule_id: ID de la regla a eliminar
        """
        path = ['nat', nat_type, 'rule', str(rule_id)]
        return self.delete_path(path)

    # ========== HELPERS PARA FIREWALL GROUPS ==========

    def create_firewall_group(self, group_type, group_name, entries, description=None):
        """
        Crea o modifica un grupo de firewall.

        Args:
            group_type: 'address', 'network', o 'port'
            group_name: Nombre del grupo
            entries: Lista de entradas (IPs, redes CIDR, o puertos según tipo)
            description: Descripción opcional del grupo

        Formatos de entries según tipo:
            - address: IPs individuales o rangos ('10.0.0.1', '10.0.0.1-10.0.0.10')
            - network: Redes CIDR ('192.168.0.0/24', '10.0.0.0/8')
            - port: Puertos, rangos, o nombres ('443', '8000-8100', 'http', 'https')

        Ejemplo:
            api.create_firewall_group('address', 'TRUSTED_IPS', [
                '192.168.1.1',
                '192.168.1.100-192.168.1.110'
            ], 'IPs de confianza')

            api.create_firewall_group('network', 'INTERNAL_NETS', [
                '192.168.0.0/24',
                '10.0.0.0/8'
            ])

            api.create_firewall_group('port', 'WEB_PORTS', [
                '80',
                '443',
                '8080-8090'
            ])
        """
        entry_key = {'address': 'address', 'network': 'network', 'port': 'port'}[group_type]
        base_path = ['firewall', 'group', f'{group_type}-group', group_name]
        ops = []

        for entry in entries:
            ops.append({'op': 'set', 'path': base_path + [entry_key, str(entry)]})

        if description:
            ops.append({'op': 'set', 'path': base_path + ['description', description]})

        return self.configure(ops)

    def delete_firewall_group(self, group_type, group_name):
        """
        Elimina un grupo de firewall.

        Args:
            group_type: 'address', 'network', o 'port'
            group_name: Nombre del grupo a eliminar
        """
        path = ['firewall', 'group', f'{group_type}-group', group_name]
        return self.delete_path(path)
