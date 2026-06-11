# Renumber de reglas sin pérdida de campos (serializador de subárbol)

> Estado: **IMPLEMENTADO** (junio 2026).

## El problema que resolvía

El cambio de rule ID (delete viejo + create nuevo) reconstruía la regla nueva
**desde el formulario del modal**. La UI solo modela un subconjunto de campos,
así que cualquier campo configurado por CLI que el modal no conoce
(`state established`, `log`, `tcp flags`, `inbound-interface`…) se perdía
silenciosamente al renumerar. Peor aún: el flujo de edición normal (diff)
generaba `delete` de esos campos desconocidos, porque el diff comparaba el
subárbol completo del config contra el payload del form.

## Cómo quedó implementado

### Backend
- `_build_renumber_ops(raw_config, old_path, new_path, diff)` en `app.py`:
  serializa la regla desde el **árbol crudo cacheado** con
  `_subtree_to_set_ops` (el mismo helper del rollback), aplica el `diff`
  opcional (ediciones hechas en el mismo guardado) sobre el path nuevo, y
  borra el path viejo. Todo en una transacción `/configure`. Valida contra el
  cache que la regla exista y el destino esté libre (`ValueError` → 400).
- `build_vyos_operations(operation, raw_config=None)` soporta la acción
  `renumber` para `firewall` y `nat`; `batch_configure` le pasa el
  `raw_config` de la sesión, así los renumber **staged** se resuelven en el
  momento del Apply All (no al encolar).
- Endpoints: `POST /api/firewall/rule/renumber`
  (`{ruleset, rule_id, new_ruleset?, new_rule_id, diff?, apply_to_peer?}`) y
  `POST /api/nat/rule/renumber` (`{nat_type, rule_id, new_rule_id, diff?}`).
  Pasan por `apply_ops_dual` → heredan dual-apply, pre-flight, write-lock,
  audit (`firewall.renumber` / `nat.renumber`) y rollback real.

### Frontend
- `applyFirewallRuleRenumber` / `applyNatRuleRenumber` llaman a los endpoints
  nuevos; en staged encolan una operación compuesta `action: 'renumber'`
  (badge MOD en la fila del ID viejo; el subárbol se resuelve server-side al
  aplicar).
- Preview verbose con `buildSubtreeCommands`: aplana el subárbol completo de
  `CONFIG` (incluidos campos no modelados) a comandos `set`.
- **Whitelist de campos del form** (`FW_FORM_FIELDS` / `NAT_FORM_FIELDS` +
  `getFormRuleDiff`): los diffs de edición solo pueden emitir `delete` de
  paths que el formulario modela. Esto corrige el bug del flujo de edición
  normal que borraba campos CLI-only. Al añadir campos nuevos al modal
  (ver [firewall-field-gaps.md](firewall-field-gaps.md)), **hay que añadirlos
  a la whitelist** o el form no podrá borrarlos.

## Pendiente / notas
- La validación de colisión usa el cache de la sesión; el pre-flight de
  `apply_ops_dual` refresca ambos nodos justo después, pero el `set` de VyOS
  sobre un ID ocupado haría merge en vez de fallar. Riesgo residual mínimo
  (requiere otro operador creando justo ese ID entre el render y el apply,
  con el write-lock compartido).
- El drag & drop ([drag-and-drop-reorder.md](drag-and-drop-reorder.md)) puede
  apoyarse directamente en `_build_renumber_ops` para los movimientos.
