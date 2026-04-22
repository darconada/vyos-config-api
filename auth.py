"""
LDAP authentication against the corporate IONOS directory (ldap.1and1.org).

Pattern ported from /home/isantolaya@arsyslan.es/drportal/app/main.py:
  1. Bind as the service account (bind_dn + bind_password).
  2. Search for the user by user_attribute inside base_dn.
  3. If found, attempt a second bind with the user's DN and the password they typed.
  4. Success of that second bind means the user is authenticated and authorized
     (authorization is implicit: users outside base_dn simply aren't found).
"""
import os
import ssl
from functools import wraps
from urllib.parse import urlparse

import yaml
from flask import jsonify, redirect, request, session, url_for
from ldap3 import Connection, Server, SUBTREE, Tls
from ldap3.core.exceptions import LDAPException

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONF_INFRA = os.path.join(BASE_DIR, "config", "infra.yaml")


def load_infra_config():
    if not os.path.exists(CONF_INFRA):
        raise RuntimeError(f"Missing config file: {CONF_INFRA}")
    with open(CONF_INFRA, "r") as f:
        return yaml.safe_load(f) or {}


def load_ldap_config():
    cfg = load_infra_config().get("ldap")
    if not cfg:
        raise RuntimeError("LDAP section missing in config/infra.yaml")
    return cfg


def load_vyos_defaults():
    return load_infra_config().get("vyos_defaults", {}) or {}


def build_ldap_server(ldap_cfg):
    parsed = urlparse(ldap_cfg["url"])
    host = parsed.hostname or ldap_cfg["url"]
    port = parsed.port or (636 if parsed.scheme == "ldaps" else 389)
    use_ssl = parsed.scheme == "ldaps"
    tls = None
    if use_ssl and not ldap_cfg.get("verify_ssl", True):
        tls = Tls(validate=ssl.CERT_NONE)
    return Server(host, port=port, use_ssl=use_ssl, tls=tls, get_info=None)


def authenticate_with_ldap(username, password):
    """Returns True on successful bind as the user; False otherwise."""
    username = (username or "").strip()
    if not username or not password:
        return False

    ldap_cfg = load_ldap_config()
    server = build_ldap_server(ldap_cfg)
    attr = ldap_cfg.get("user_attribute", "uid")
    search_filter = f"({attr}={username})"

    try:
        service_conn = Connection(
            server,
            user=ldap_cfg["bind_dn"],
            password=ldap_cfg["bind_password"],
            auto_bind=True,
        )
    except LDAPException:
        return False

    try:
        service_conn.search(
            search_base=ldap_cfg["base_dn"],
            search_filter=search_filter,
            search_scope=SUBTREE,
            attributes=["dn"],
            size_limit=1,
        )
        if not service_conn.entries:
            return False
        user_dn = service_conn.entries[0].entry_dn
    except LDAPException:
        return False
    finally:
        service_conn.unbind()

    try:
        user_conn = Connection(server, user=user_dn, password=password, auto_bind=True)
        user_conn.unbind()
        return True
    except LDAPException:
        return False


def _wants_json():
    # /api/* paths, any non-GET request, and explicit JSON Accept headers get
    # a 401 JSON response; only plain GETs from a browser are redirected.
    if request.path.startswith("/api/"):
        return True
    if request.method != "GET":
        return True
    accept = request.headers.get("Accept", "")
    return "application/json" in accept and "text/html" not in accept


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            if _wants_json():
                return jsonify({"error": "Not authenticated"}), 401
            return redirect(url_for("login_form"))
        return f(*args, **kwargs)
    return wrapper
