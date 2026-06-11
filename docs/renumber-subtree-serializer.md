# Renumber de reglas sin pérdida de campos (serializador de subárbol) — diseño

> Estado: **anotado, no implementado** (junio 2026). El helper base YA existe;
> falta cablearlo en el flujo de cambio de rule ID.

## El problema

El cambio de rule ID (delete viejo + create nuevo) reconstruye la regla nueva
**desde el formulario del modal**. La UI solo modela un subconjunto de campos
(action, jump-target, protocol, description, disable, source/destination con
address/port/grupos), así que cualquier campo configurado por CLI que el modal
no conoce (`state established`, `log`, `tcp flags`, `inbound-interface`,
`recent`, `limit`…) se **pierde silenciosamente** al renumerar la regla.

Es el mismo riesgo que tendría el drag & drop (ver
[drag-and-drop-reorder.md](drag-and-drop-reorder.md)): cualquier operación que
recree una regla debe partir del árbol crudo del router, nunca del form.

## Lo que ya existe (junio 2026)

`app.py` tiene `_subtree_to_set_ops(path, node)`, añadido para el rollback real
de dual-apply. Recorre un subárbol del JSON de VyOS y emite un `set` por hoja,
manejando:
- valor único renderizado como string vs múltiples valores como lista;
- flags sin valor (`disable`, `log`…) renderizados como dict vacío.

Está probado indirectamente por la suite del rollback (recreación de reglas y
grupos borrados).

## Lo que falta

1. **Endpoint de renumber** (`POST /api/firewall/rule/renumber`, y equivalente
   NAT): `{ruleset, old_id, new_id}`. El backend:
   - lee la regla `old_id` del `sess['raw_config']` (árbol crudo, NO el form);
   - valida que `new_id` no exista;
   - construye `_subtree_to_set_ops(base_path_nuevo, rule_subtree)` +
     `delete` del viejo, en UNA transacción `/configure`;
   - lo pasa por `apply_ops_dual` (hereda dual-apply, pre-flight, write-lock,
     audit y rollback).
2. **Frontend**: cuando el usuario cambia el rule ID en el modal de edición,
   llamar al endpoint de renumber en vez de generar delete+create desde el
   form (manteniendo la confirmación explícita actual). Si además editó campos,
   encadenar: renumber primero, luego el diff de campos sobre el ID nuevo (o
   componer ambos en la misma transacción).
3. **Modo staged**: la operación `renumber` como tipo propio en
   `pendingOperations`, con badge MOV; `build_vyos_operations` resolviendo el
   subárbol en el momento del Apply All (no al encolar, para no quedarse stale).

## Estimación

Medio día a un día: el serializador y toda la infraestructura de apply ya
existen; es principalmente el endpoint + tocar el flujo del modal.
