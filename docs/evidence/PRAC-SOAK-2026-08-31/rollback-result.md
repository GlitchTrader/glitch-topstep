# Rollback rehearsal — PRAC-SOAK-2026-08-31

**Status:** pendente (requer operador)

## Procedimento

1. Documentar par atual (commits + manifest).
2. Simular rollback para par anterior conhecido **sem** apagar evidência desta sessão.
3. Confirmar gateway/profile sobem e `preflight-pairing.py` passa.
4. Restaurar par de teste (`f2de2ec` / `a35e5b5`) antes dos testes dirigidos.

## Resultado

- [ ] Rollback testado
- [ ] Restauração do par de teste confirmada

**Operador / UTC:** _pendente_
