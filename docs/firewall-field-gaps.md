# Campos de reglas de firewall VyOS no soportados por la UI — plan

> Estado: **anotado, no implementado** (junio 2026). Gap analysis del modal de
> reglas frente a lo que soporta VyOS 1.4 (sagitta) / 1.5.

## Lo que el modal soporta hoy

action (accept/drop/reject/return/continue/jump/queue, con jump-target),
protocol (8 valores fijos), description, disable, y source/destination con:
address único, port, y UN grupo de cada tipo (address/network/port-group).

## Uso REAL medido en la flota (jun 2026)

Escaneo de atributos por regla vía API (`/retrieve` de `firewall`) sobre
`es-por-ins-ifw01-02` (340 reglas), `vyos-cb-lgr-dr-07` (45) y el stateless
`vyos-cb-lgr-dr-01` (15):

| Campo | ifw01-02 | dr-07 | dr-01 (stateless) |
|---|---|---|---|
| action / description / protocol / source / destination | masivo | masivo | sí |
| destination.port / address, grupos | masivo | sí | sí |
| jump-target | 10 | 5 | 4 |
| inbound/outbound-interface.name | 10 | 5 | 4 (casi todo en reglas de los hooks) |
| **state por regla** | **0** | **0** | **0** |
| **log por regla** | **0** | **0** | **0** |
| tcp.flags | 0 | 0 | 5 |
| packet-length | 0 | 0 | 2 |
| limit rate/burst | 0 | 0 | 1 |
| icmp / time / recent / dscp / mark / fragment / ipsec | 0 | 0 | 0 |
| firewall ipv6 | no | no | no |

Segunda tanda (mismo escáner): `lpnfw500-02` (298 reglas), `lp2fsfw01-02`
(455 reglas, 122 rulesets, hooks grandes: 181 jump-target, 121
inbound-interface) y `lp2fifw01-02` (189 reglas). Resultado idéntico:
política movida casi al 100% con grupos, `state-policy` global, y CERO uso de
state/log/tcp-flags/icmp/limit por regla. Los hooks forward/input son el
esqueleto de despliegue (interface-match + jump) y no se editan desde la web.

Conclusiones:
- El estado se lleva en `global-options state-policy` (los dos stateful lo
  tienen); **state por regla queda DESCARTADO del modal**.
- Los tres routers tienen reglas en los hooks `ipv4 forward/input filter`
  (el pegamento interface → jump-target a las cadenas con nombre), invisibles
  hoy para la UI.
- Los matchers exóticos (tcp flags, packet-length, limit) existen solo en los
  stateless y en cantidades de una mano.

## Gaps, por prioridad

### Alta (uso diario en cualquier firewall serio)

| Campo | Path VyOS | Notas |
|---|---|---|
| `state` | `rule N state established/related/new/invalid` | El matcher más usado; sin él no se puede crear la típica regla "accept established,related". En 1.4 es multivalor. |
| `log` | `rule N log` | Flag sin valor (como `disable`, ya soportado en backend vía `_VYOS_BOOLEAN_FLAGS`: habría que añadir `log`). |
| `log-options` | `rule N log-options level/rate-limit ...` | Secundario al log básico. |
| `inbound-interface` / `outbound-interface` | `rule N inbound-interface name ethX` (o `group`) | Clave en 1.4 con hooks forward/input/output. |
| Gestión de rulesets | `firewall ipv4 name X default-action / enable-default-log / description` | Hoy default-action solo se muestra; no se puede editar ni crear/borrar rulesets explícitamente. |
| Hooks 1.4 | `firewall ipv4 forward/input/output filter rule N` | Invisibles en la UI: son el punto de entrada real del tráfico en 1.4; sin verlos no se entiende el flujo completo (jumps a las cadenas con nombre). |
| Negación y rangos | `source address !10.0.0.0/8`, `address a.b.c.d-a.b.c.e`, `port !x` | Mismos paths que ya generamos; es validación de formato + UI. |

### Media

- `icmp type-name / type / code` (tenemos protocol icmp sin matchers).
- TCP `flags` (`tcp flags syn`, `tcp flags !ack`...) y `tcp mss`.
- Más tipos de grupo: `domain-group`, `mac-group`, `interface-group`.
- **IPv6 completo**: `firewall ipv6 name` + grupos IPv6. `adapt_14` tiene el
  TODO marcado (app.py, comentario "Si quisieras IPv6...").
- `connection-status nat destination/source` (combina con nuestro NAT).
- `ipsec match-ipsec-in / match-none-in` (tráfico VPN).

### Baja / nicho

`limit rate/burst`, `recent count/time`, `time` (franjas horarias),
`ttl`, `dscp`, `packet-length`, `fragment`, `mark`, action `synproxy`,
`queue-options`, `global-options state-policy`.

### NAT (aparte)

- `translation address masquerade` (el SNAT de salida típico) — hoy obliga a IP.
- Rangos/pools de traducción, `load-balance`, static NAT, NAT66/NPTv6.

## Notas de implementación

1. Patrón ya establecido (CLAUDE.md): campo en el modal (`index.html`) +
   payload en `app.js` + path en `build_vyos_operations` / diff en
   `getRuleDiff`. Los flags sin valor deben ir a `_VYOS_BOOLEAN_FLAGS` en
   `app.py` y normalizarse con `normFlagValue` en el frontend.
2. `state` en 1.4 es multivalor (lista): el diff y `apply_ops_in_memory` ya
   manejan listas para grupos; `_is_group_entry_path` tendría que generalizarse
   o añadir el caso `rule N state`.
3. Cualquier campo nuevo que la UI NO modele sigue en riesgo con el renumber
   actual: hacer antes (o a la vez) el serializador de subárbol
   ([renumber-subtree-serializer.md](renumber-subtree-serializer.md)).
4. Orden sugerido de entrega: `state` + `log` (un sprint corto, máximo valor),
   después interfaces + default-action/ruleset CRUD, después negación/rangos,
   y dejar hooks 1.4 + IPv6 como bloque propio (tocan adapt_14 y navegación).
