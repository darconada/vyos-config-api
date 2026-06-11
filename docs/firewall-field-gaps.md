# Campos de reglas de firewall VyOS no soportados por la UI — plan

> Estado: **anotado, no implementado** (junio 2026). Gap analysis del modal de
> reglas frente a lo que soporta VyOS 1.4 (sagitta) / 1.5.

## Lo que el modal soporta hoy

action (accept/drop/reject/return/continue/jump/queue, con jump-target),
protocol (8 valores fijos), description, disable, y source/destination con:
address único, port, y UN grupo de cada tipo (address/network/port-group).

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
