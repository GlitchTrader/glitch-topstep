# Especificação de implementação — recuperação segura do partial EXIT

**Data:** 2026-08-31  
**Repositório:** `GlitchTrader/glitch-topstep`  
**Escopo:** gateway TypeScript; não alterar o Hermes profile nesta fase  
**Prioridade:** P0 — proteção e recuperação de execução  
**Bloqueio:** Testes PRAC 3–11 e soak de 72h permanecem bloqueados até os critérios de aceite deste documento serem aprovados.

## 1. Objetivo

Corrigir o fluxo de redução parcial para que uma operação `EXIT` que reduza uma posição aberta:

1. seja reconciliada com a posição e os eventos do ProjectX;
2. não permaneça indefinidamente em `reduction_ambiguous`;
3. rearme a proteção sobrevivente em ordem segura — stop antes de target;
4. mantenha cobertura de stop para toda a quantidade aberta, admitindo apenas o estado explícito `degraded_stop_only` quando o target não puder ser restaurado;
5. preserve identidade de intent, tranche, contrato, conta, order ID e geração de tags;
6. seja recuperável após restart, timeout, perda de stream e respostas REST fora de ordem;
7. não faça retry cego, não duplique exposição e não transforme evidência ausente em sucesso.

O comportamento de `AUTO_BREAKEVEN`, daily capture, flatten e fail-closed de novas entradas não deve ser enfraquecido.

## 2. Evidência e diagnóstico confirmado

Artefatos:

- [test-02-partial-close.json](../evidence/PRAC-SOAK-2026-08-31/test-02-partial-close.json)
- [test-02-flatten-recovery.json](../evidence/PRAC-SOAK-2026-08-31/test-02-flatten-recovery.json)
- [incidents.md](../evidence/PRAC-SOAK-2026-08-31/incidents.md)
- [intent-receipts.jsonl](../evidence/PRAC-SOAK-2026-08-31/intent-receipts.jsonl)
- [test-01-entry-protected.json](../evidence/PRAC-SOAK-2026-08-31/test-01-entry-protected.json)

Caso observado:

- posição antes: 3 MNQ;
- partial EXIT: quantidade 1;
- order ProjectX: `3469618698`;
- posição após o submit: 2;
- receipt permaneceu `pending` após 135 s;
- saga ficou em `reduction_ambiguous`;
- nenhum SL/TP foi observado pelo gateway;
- `unprotected_open_quantity` foi 2;
- a atribuição exibiu tranches antigas de 24/26 de agosto em vez do intent do Teste 1;
- operador confirmou no UI +2 MNQ sem OCO e executou flatten supervisionado;
- flatten foi concluído, mas somente porque a posição foi zerada.

### Causa raiz primária

O caminho de rearm é bloqueado enquanto existe uma mutação EXIT aberta:

- [src/execution/coordinator.ts:974-980](../../src/execution/coordinator.ts:974)
- [src/storage/sqlite-execution-store.ts:509-523](../../src/storage/sqlite-execution-store.ts:509)

Ao mesmo tempo, `reconcilePendingReceipts()` não possui uma resolução para `EXIT` parcial. O código trata entradas e alterações de ordens, mas retorna sem resolver receipts cuja mutação seja `place_order` de EXIT:

- [src/execution/receipt-reconciliation.ts:90-143](../../src/execution/receipt-reconciliation.ts:90)

Resultado: o receipt fica pendente, `hasOpenExitMutation()` permanece verdadeiro, o rearm não começa e a saga não pode sair de `reduction_ambiguous`.

### Causa secundária: corrida entre intent, outbox e recovery

Os eventos mostram:

- `17:04:04.169Z`: recovery publicou `intent_confirmed_not_submitted_without_outbox`;
- `17:04:04.238Z`: outbox do EXIT foi criado;
- `17:04:04.300Z`: outbox recebeu o provider order ID;
- `17:04:04.305Z`: receipt do EXIT foi publicado como pending.

O recovery conseguiu observar o intent entre a persistência da identidade e a persistência do outbox. Isso não explica sozinho a perda do bracket, mas torna o estado de execução contraditório e precisa ser corrigido no mesmo trabalho.

### Causa secundária: atribuição de tranche

`buildTranches()` calcula quantidade preenchida a partir de evidência de fill vinculada ao `provider_order_id`. Quando a evidência do intent atual não está disponível ou não está corretamente relacionada, entradas antigas podem ser usadas na projeção:

- [src/ownership/projectx-order-ownership.ts:276-305](../../src/ownership/projectx-order-ownership.ts:276)
- [src/ownership/tranches.ts:67-105](../../src/ownership/tranches.ts:67)

O sistema deve investigar e tornar isso explícito; não deve assumir que uma tranche stale é a tranche sobrevivente apenas porque a soma ainda fecha.

## 3. Invariantes não negociáveis

Estas condições devem ser codificadas e testadas:

1. Enquanto a posição do venue for positiva, a cobertura de stop deve ser maior ou igual à quantidade aberta.
2. `degraded_stop_only` é aceitável somente quando há stop válido, observável, com preço e quantidade corretos; target ausente não pode ser tratado como proteção completa.
3. Nenhum target pode ser colocado antes de existir stop confirmado.
4. Nenhum stop existente do último survivor pode ser cancelado sem redução confirmada no venue ou stop substituto confirmado.
5. Um EXIT pendente bloqueia nova exposição, mas não pode bloquear para sempre a recuperação da proteção de uma redução já confirmada pelo delta da posição.
6. Em evidência insuficiente, o resultado deve ser `ambiguous`/`failed` e fail-closed; nunca `completed` por inferência temporal ou geométrica.
7. O gateway só pode alterar ordens da conta, contrato e identidade de ownership correspondentes.
8. O flatten continua autorizado em qualquer estado não terminal e deve permanecer disponível mesmo quando a saga estiver ambígua.
9. `AUTO_BREAKEVEN` continua intent-free, tighten-only e independente desta correção.
10. A flag `GLITCH_PARTIAL_EXIT_FAIL_CLOSED=1` continua sendo rollback de emergência.

## 4. Mudanças requeridas

### 4.1 Reconciliar EXIT parcial

Implementar uma função dedicada, preferencialmente em `src/execution/receipt-reconciliation.ts` ou módulo extraído, por exemplo:

```ts
reconcilePendingReduction(
  reduction: ProtectedReductionRecord,
  mutation: StoredExecutionMutation,
  receipt: ExecutionReceipt,
  positions: readonly PositionInfo[],
  orders: readonly OrderInfo[],
  fills: readonly ProviderTradeEvidence[],
  accountId: number,
  contractId: string,
  nowUtc: string,
): ReductionReconciliationResult
```

A função deve:

- localizar o provider order pelo `provider_exit_order_id` e/ou outbox;
- validar conta, contrato, lado, tipo e quantidade;
- obter trades/fills associados ao order ID;
- calcular `position_before - position_after` usando snapshots reconciliados;
- distinguir `filled`, `partially_filled`, `rejected`, `cancelled`, `not_observed` e `ambiguous`;
- nunca concluir preenchimento apenas porque a API aceitou o request;
- aceitar redução confirmada quando houver evidência suficiente de fill ou delta autoritativo de posição associado ao order;
- deixar a mutação ambígua quando as fontes discordarem;
- registrar diagnóstico com sequences, timestamps, IDs e hashes de evidência.

Para o caso do Teste 2, a posição 3→2 e o order `3469618698` devem permitir concluir que houve redução de 1, desde que a associação ao order seja confirmada pelo provider journal/REST ou pelo stream de trades.

Quando a redução for confirmada:

1. resolver o receipt para um código novo e explícito, por exemplo `partial_exit_reconciled_pending_protection`;
2. manter nova exposição bloqueada enquanto a proteção não estiver confirmada;
3. atualizar a saga para uma etapa que permita recuperação, sem apagar a identidade do reduction;
4. iniciar rearm idempotente na fila de execução;
5. finalizar em `reduced_protected` ou `degraded_stop_only`.

Quando a redução não puder ser confirmada:

- manter `reduction_ambiguous`;
- bloquear novas entradas;
- executar reconciliação reforçada;
- emitir alerta com idade da ambiguidade;
- permitir flatten supervisionado;
- não colocar proteção de quantidade baseada numa atribuição não comprovada.

### 4.2 Remover o deadlock sem abrir uma corrida

Não basta remover `hasOpenExitMutation()` do guard. A correção deve alterar a ordem do workflow:

1. reconciliar a redução;
2. atualizar a quantidade autoritativa da posição;
3. reconstruir ownership;
4. determinar survivors;
5. colocar stop para cada survivor sem stop válido;
6. confirmar stop por snapshot/ordem;
7. colocar target;
8. confirmar target ou entrar em `degraded_stop_only`;
9. marcar receipt/saga terminal para o estado alcançado.

O rearm deve continuar bloqueado enquanto a redução ainda puder estar em voo e houver risco de dupla mutação. O desbloqueio deve ocorrer por evidência de reconciliação, não por timeout arbitrário.

### 4.3 Corrigir atomicidade intent/outbox/reduction

O registro de intent, criação de outbox e `beginProtectedReduction()` devem ocorrer na mesma transação SQLite, ou possuir uma fase de recuperação que reconheça o estado intermediário de forma idempotente.

Critério mínimo:

- recovery nunca deve publicar `intent_confirmed_not_submitted_without_outbox` se a operação está dentro da transação ou se existe uma marca durável de `submission_initializing`;
- uma repetição do recovery deve produzir o mesmo resultado;
- nenhum provider mutation pode ser repetido cegamente;
- o `provider_order_id` deve ser preservado se já existir.

### 4.4 Corrigir a atribuição de tranche

Adicionar uma função de diagnóstico de ownership que exponha, para cada entry:

- intent ID;
- provider order ID;
- quantidade solicitada;
- quantidade preenchida;
- sequences de fill observadas;
- ordem de proteção atual;
- origem da atribuição: tag, parent order, fill ou fallback;
- razão de incompletude;
- se foi alvo de EXIT pendente.

Regras:

- priorizar evidência atual do provider e identity completa;
- não usar tranche antiga silenciosamente quando o intent atual está sem fill evidence;
- se a identidade da tranche alvo não puder ser provada, rejeitar um EXIT direcionado antes de cancelar proteção;
- depois de uma redução, recalcular as quantidades com base na posição atual e em evidência preservada;
- conservar tranches fechadas para outcome, mas excluí-las de cobertura aberta.

Adicionar uma razão específica, por exemplo `target_tranche_identity_unproven`, em vez de apresentar tranches stale como se fossem a posição real.

### 4.5 Estado e terminalidade

Revisar `PROTECTED_REDUCTION_TRANSITIONS` e as operações do store para assegurar que:

- `reduction_ambiguous` pode ser resolvido após reconciliação comprovada;
- `degraded_stop_only` pode evoluir para `reduced_protected` após target confirmado;
- posição flat leva a `flat` independentemente de proteção anterior;
- `reduced_protected` não aparece como active reduction;
- um estado terminal não é reaberto por snapshot atrasado;
- restart reidrata exatamente o estado persistido.

Arquivos de referência:

- [src/domain/state-machines.ts](../../src/domain/state-machines.ts)
- [src/storage/sqlite-execution-store.ts:826-927](../../src/storage/sqlite-execution-store.ts:826)
- [src/execution/protected-reduction-saga.ts](../../src/execution/protected-reduction-saga.ts)

## 5. Observabilidade obrigatória

Cada tentativa deve emitir eventos append-only contendo:

- `reduction_id`;
- `exit_intent_id`;
- `target_intent_id`;
- account ID e contract ID;
- provider exit order ID;
- state anterior e novo;
- posição antes/depois;
- quantidade solicitada, preenchida e restante;
- provider event sequences usados;
- stop/target order IDs e gerações;
- origem do rearm;
- motivo de defer, ambiguidade ou falha;
- elapsed time;
- erro sanitizado e content hash REST quando disponível.

Eventos mínimos:

- `partial_reduction_reconciliation_started`;
- `partial_reduction_reconciled`;
- `partial_reduction_reconciliation_ambiguous`;
- `tranche_ownership_rebuilt`;
- `tranche_protection_rearm_started`;
- `tranche_protection_rearm_deferred`;
- `tranche_protection_rearmed`;
- `tranche_protection_rearm_target_failed`;
- `partial_reduction_recovery_timeout`.

Health deve mostrar pelo menos:

- estado da saga;
- idade de `reduction_ambiguous`;
- quantidade aberta;
- quantidade sem stop;
- quantidade em `degraded_stop_only`;
- receipt/mutation status;
- última tentativa de rearm;
- contagem de reconciliações ambíguas;
- contagem de ownership incompleto.

## 6. Testes automatizados

### 6.1 Unitários

Adicionar testes para:

1. EXIT parcial confirmado por delta 3→2 e order ID correspondente.
2. EXIT rejeitado sem alteração de posição.
3. EXIT parcialmente preenchido.
4. REST e stream fora de ordem.
5. order aceito sem fill observável.
6. posição alterada, mas order ID incompatível — resultado ambíguo.
7. receipt EXIT pendente não bloqueia rearm depois de redução confirmada.
8. receipt EXIT ainda não reconciliado continua bloqueando nova mutação de redução.
9. stop colocado, target falha — `degraded_stop_only`.
10. retry idempotente depois de stop já colocado.
11. geração `-rN-` não reutiliza tags antigas.
12. tranche alvo inexistente ou sem fill — fail-closed.
13. tranche atual ausente e tranches antigas presentes — não atribuir silenciosamente ao stale.
14. restart em cada fase da saga.
15. posição flat encerra a saga e impede rearm posterior.
16. flatten permanece disponível durante `reduction_ambiguous`.

Executar, no mínimo:

```text
npm run check
tests/protected-reduction-saga.test.ts
tests/position-management.test.ts
tests/rearm-latch-regression.test.ts
tests/execution-coordinator.test.ts
tests/projectx-order-ownership.test.ts
```

### 6.2 Kill matrix

Preservar e expandir os pontos:

- `reduction_after_prepared`;
- `reduction_after_cancel_before_place`;
- `reduction_after_place_before_mark`;
- entre intent e criação do outbox;
- depois de criar outbox e antes do submit;
- depois do submit e antes do receipt;
- depois de confirmar redução e antes do stop;
- depois do stop e antes do target;
- depois do target e antes da persistência terminal.

Para cada kill point provar:

- no duplicate EXIT;
- no duplicate protective orders;
- no loss of reduction record;
- no new exposure;
- stop-first after restart;
- eventual estado terminal ou ambiguidade explicitamente recuperável.

### 6.3 Replay do incidente real

Criar fixture sanitizada baseada no Teste 2 com:

- entry order `3469609013`;
- initial stop `3469609014`;
- initial target `3469609015`;
- EXIT order `3469618698`;
- posição 3 antes e 2 depois;
- OCO ausente após o EXIT;
- target intent do Teste 1;
- eventos atrasados e sequência de recovery observada.

O replay deve produzir o mesmo diagnóstico e a mesma transição esperada em todas as execuções.

## 7. Ordem de implementação

1. Adicionar fixture/replay do incidente e testes vermelhos.
2. Corrigir transação intent/outbox/reduction.
3. Implementar reconciliação de EXIT parcial.
4. Integrar reconciliação ao loop antes do rearm.
5. Corrigir ownership/atribuição e diagnósticos.
6. Validar estado, terminalidade e restart.
7. Adicionar métricas/eventos.
8. Rodar `npm run check` e kill matrix.
9. Fazer PRAC controlado de um único partial EXIT.
10. Repetir short/long e restart antes de liberar os testes seguintes.

## 8. Critérios de aceite em simulação/replay

Todos devem passar:

- `partial EXIT 1/3` resulta em posição 2;
- receipt deixa de ser pending;
- saga chega a `reduced_protected` ou `degraded_stop_only`;
- stop cobre exatamente os 2 contratos sobreviventes;
- target é recolocado somente depois do stop;
- nenhum order duplicado é criado;
- nenhuma tranche stale é usada sem diagnóstico explícito;
- restart em qualquer fase retoma uma única vez;
- nova entrada continua bloqueada enquanto a redução/proteção não estiver resolvida;
- flatten supervisionado continua funcionando;
- posição flat marca a saga como `flat` e não cria ordens posteriores.

## 9. Critérios de aceite PRAC

Não executar os testes 3–11 nem o soak até obter:

1. `npm run check` verde.
2. Kill matrix verde.
3. Replay do incidente verde.
4. Partial EXIT SHORT validado em PRAC.
5. Partial EXIT LONG validado em PRAC.
6. Restart após redução validado.
7. Nenhum `unprotected_open_quantity` inesperado.
8. Nenhum receipt ou mutation ambíguo pendente ao final.
9. Evidence JSON com IDs, timestamps, states e provider sequences.
10. Rollback testado com `GLITCH_PARTIAL_EXIT_FAIL_CLOSED=1`.
11. Revisão explícita do operador autorizando a retomada.

O contrato/compatibilidade não deve ser anunciado como `proven_prac_short_long_with_saga` novamente até os novos testes PRAC serem concluídos e revisados.

## 10. Rollback e operação durante a implementação

Antes de qualquer novo partial EXIT armado:

```text
GLITCH_PARTIAL_EXIT_FAIL_CLOSED=1
```

Reiniciar o gateway após alterar a variável e confirmar no health que `fail_closed_rollback=true`.

Se ocorrer nova divergência:

1. não iniciar soak;
2. verificar posição e ordens no ProjectX;
3. bloquear novas entradas;
4. usar flatten supervisionado via [scripts/prac-operator-flatten-once.py](../../scripts/prac-operator-flatten-once.py) se houver exposição sem stop;
5. preservar todos os JSONs, receipts, eventos e screenshots;
6. não editar manualmente a saga no SQLite.

## 11. Fora de escopo

- Alterar regras de seleção cognitiva.
- Permitir exposição simultânea multi-instrumento.
- Remover a proteção diária ou breakeven automático.
- Aumentar quantidade máxima ou risco.
- Inferir fills a partir de OHLC.
- Fazer fallback automático para outro contrato.
- Misturar mudanças TypeScript no repositório do Hermes profile.

## 12. Entrega esperada do programador

O PR deve conter:

- implementação e testes;
- fixture sanitizada do Teste 2;
- relatório do replay e kill matrix;
- atualização de documentação operacional;
- evidência de `npm run check`;
- descrição dos estados e códigos novos;
- instruções de rollback;
- nenhuma alteração na flag de fail-closed sem justificativa e teste;
- atualização do ledger somente quando o item correspondente estiver realmente encerrado, com link do PR e issue.

