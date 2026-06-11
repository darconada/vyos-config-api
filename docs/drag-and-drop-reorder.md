# Drag & drop de reglas de firewall (estilo Checkpoint) — diseño

> Estado: **anotado, no implementado** (junio 2026). Documento de diseño para cuando se decida atacarlo.

## Restricción de fondo

En VyOS el orden de evaluación de reglas **es** el número de regla: no existe el concepto
"mover una regla". Reordenar = renumerar.

- En CLI de modo configuración existe `rename firewall ipv4 name X rule 40 to rule 15`,
  pero la REST API `/configure` solo acepta `op: set | delete | comment` (que es lo que usa
  `vyos_api.py`). No hay op de rename/copy vía API.
- Por tanto, cada movimiento se traduce a **delete(id viejo) + N×set(id nuevo)**, la misma
  mecánica que ya usa el cambio manual de rule ID.
- Punto clave a favor: `/configure` aplica **todo el array de ops en una sola transacción
  con un único commit**. Si algo falla, no se aplica nada. El reorden es atómico: no hay
  ventana con la regla "desaparecida", ni siquiera en cascadas.

## Traducción a comandos VyOS, por casos

Ejemplo: soltar la regla 40 entre la 10 y la 20.

### Caso 1: hay hueco entre vecinos (el 90% con numeración 10/20/30)

Se elige un ID intermedio (15) y se genera una transacción:

```
set    firewall ipv4 name WAN-IN rule 15 action accept
set    firewall ipv4 name WAN-IN rule 15 source address 10.0.0.0/24
...    (todos los sub-paths de la regla 40, copiados del árbol crudo)
delete firewall ipv4 name WAN-IN rule 40
```

Una regla tocada, un commit.

### Caso 2: sin hueco (reglas consecutivas, p. ej. 10,11,12; soltar entre 10 y 11)

Cascada mínima: desplazar solo las reglas necesarias hasta el primer hueco, procesando
**desde el extremo lejano** para no colisionar IDs dentro del propio plan:

```
set ... rule 13 <copia de 12>   ; delete ... rule 12
set ... rule 12 <copia de 11>   ; delete ... rule 11
set ... rule 11 <copia movida>  ; delete ... rule <origen>
```

Todo en el mismo array de `/configure`, un solo commit, atómico.

### Caso 3: renumerado completo del ruleset (acción aparte, NO parte del drag)

Reescribir todo el ruleset a paso 10. Útil como mantenimiento, pero **peligroso en
nuestro parque**: en algunos routers los nombres de grupo van alineados por convención
con los IDs de regla, y renumerar NO renombra grupos. Debe ser una acción explícita con
confirmación fuerte, nunca un efecto colateral del drag.

## Qué hay que construir

### Backend (lo más importante, ~100-150 líneas)

1. **Serializador genérico de subárbol**: `rule_subtree_to_set_ops(ruleset, new_id, rule_dict)`
   que recorra el dict crudo de la regla **tal y como vino del router** (`sess['raw_config']`)
   y emita un `set` por hoja. Debe manejar:
   - la asimetría string/lista del JSON de VyOS (valor único = string, múltiple = lista);
   - los flags sin valor (`disable`, `log`, ...) que llegan como `{}`.

   **Crítico**: partir SIEMPRE del árbol crudo, nunca del formulario. La UI solo modela un
   subconjunto de campos; reconstruir desde el form pierde silenciosamente campos puestos
   por CLI (p. ej. `state established`). Esto además arregla un bug latente del renumber
   actual (delete+create reconstruido desde el modal).

2. **Endpoint `POST /api/firewall/rules/reorder`** con `{ruleset, moves: [{from, to}]}`:
   - valida colisiones contra el config actual;
   - construye el plan delete+set ordenado (lejano → cercano);
   - lo pasa por **el mismo `apply_ops_dual`** → hereda gratis dual-apply al peer,
     pre-flight de sincronización, write-lock y audit log.

### Frontend

- Drag con HTML5 nativo o SortableJS sobre las filas de la tabla del ruleset
  (handle en la primera celda, indicador de línea de drop).
- Al soltar, calcular el plan en cliente: buscar hueco entre vecinos; si no hay,
  calcular cascada mínima.
- **Modal de confirmación obligatorio** con el mapa de renumeración
  ("40 → 15", o "11→12, 12→13, nueva 11") y, en modo verbose, los comandos exactos.
  (Coherente con el patrón ya acordado: todo cambio de ID requiere confirmación explícita.)
- Integración con modo staged (el plan entra en `pendingOperations` como operación
  compuesta, badges `MOV` en filas afectadas) y con el activity log.

## Decisiones pendientes antes de empezar

| Decisión | Opciones | Recomendación |
|---|---|---|
| ID al soltar en hueco | punto medio del hueco vs `vecino+1` | punto medio (conserva huecos futuros) |
| Cascada toca reglas con grupos alineados al ID | bloquear / avisar / ignorar | avisar en el modal listando los grupos cuyo nombre contiene el ID antiguo |
| UX complementaria | botones "insertar encima/debajo" | sí: misma maquinaria, cero drag, útil en uso rápido |

## Estimación

- Caso con hueco + modal de confirmación: 1-2 días.
- Cascada + modo staged + pulido: 1-2 días más.
- Prerrequisito recomendado: el serializador genérico de subárbol (que conviene hacer
  antes de todos modos, porque corrige la pérdida de campos del renumber actual).
