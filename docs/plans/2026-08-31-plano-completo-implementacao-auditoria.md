# Plano completo de implementação — Auditoria de 31/08/2026

**Status:** plano de execução para revisão do programador  
**Data:** 2026-08-31  
**Repositórios:** `glitch-topstep` (gateway TypeScript) e `glitch-topstep-hermes-profile` (profile Python)  
**Documento de origem:** [`docs/AUDIT-2026-08-31.md`](../AUDIT-2026-08-31.md)  
**Documentos de autoridade:** `docs/plans/2026-08-20-nt-adaptation-roadmap.md`, `docs/plans/2026-08-25-complete-audit-implementation-plan.md`, `docs/ledger/ledger.json`

## 1. Objetivo

Levar o gateway e o Hermes profile a um estado em que a operação autônoma prolongada possa ser avaliada com evidência reproduzível, sem introduzir risco adicional, duplicação de execução, perda de identidade ou falsa confirmação de proteção.

Este documento é um plano de implementação. Ele não autoriza sozinho:

- apagar worktrees ou branches;
- executar operações reais em conta PRAC/Topstep;
- promover o sistema para `armed` ou produção;
- relaxar qualquer gate de segurança;
- alterar o contrato pareado sem atualizar os dois repositórios.

## 2. Regras inegociáveis

Estas regras devem permanecer verdadeiras em todas as ondas e em todos os testes:

1. O daily capture pode bloquear novas entradas quando o PnL realizado autoritativo atingir o alvo. Redução, proteção, recovery e flatten continuam disponíveis.
2. O breakeven automático continua sem intent, gateway-owned, idempotente, exact-leg-owned e tighten-only.
3. Nenhuma ordem manual, foreign ou de outra perna pode ser alterada por uma operação automática.
4. Nenhuma mutation pode ser repetida cegamente após timeout, 401/403, 429 ou crash.
5. `quote_stale`, `state_complete=false`, identidade inconsistente, contrato expirado ou ausência de proteção não podem ser convertidos em entrada válida.
6. A exposição permanece single-exposure. Multi-instrumento simultâneo continua proibido até existir prova de portfolio risk, recovery e fault injection.
7. Novos dados ausentes permanecem explicitamente ausentes. Não usar zero-fill, defaults favoráveis a MNQ ou `NOTHING` artificial por simples lag.
8. Entradas continuam `MARKET` até a resolução de `TS-AUDIT31-EX-02`.
9. O gateway é a única camada autorizada a tocar ProjectX. O profile não pode fazer mutation direta.
10. Código TypeScript pertence ao gateway; código Python de cognição, learning e outbox pertence ao Hermes profile.

## 3. Estado atual e interpretação dos achados

### 3.1 Já comprovado

- Outbox de evidências durável e retomada após restart.
- Fallback de flatten condicionado a não haver ordens próprias working.
- Fachada única de autenticação ProjectX no runtime.
- Refresh margin e single-flight de autenticação.
- Cache bounded de rearm, outcomes e hashes REST.
- Endpoint versionado `/intent/status` e derivação dos estados de entrega.
- Fault matrix real no caminho de release armado.
- Daily capture e breakeven automático preservados.
- Correção de tolerância de timestamp `updateTimestamp`.
- Documentação principal reconciliada com o código atual.

### 3.2 Em aberto e sua natureza

| Item | Prioridade | Natureza | Consequência |
|---|---:|---|---|
| `TS-AUDIT31-EX-01` | P0 | Bug real de proteção | `status:8` pode ser tratado como proteção confirmada com `price:null` |
| `TS-REAUDIT-08` | P0 | Bug de lifecycle | shutdown pode liberar lock/stores com writer crítico vivo |
| `TS-REAUDIT-04` | P0 | Prova/compatibilidade | crash de intent ainda não provado no store real; endpoint antigo ainda é ambíguo |
| `TS-STREAM-RECOVERY-01` | P0 | Confiabilidade | 61 reinícios em 31/08; PR-F/G/H e soak ainda não feitos |
| `TS-AUDIT31-EX-02` | P1 | Limitação estrutural | REST não enxerga bracket child `status:8` |
| `TS-AUDIT31-PX-01` | P1 | Defeito de isolamento | falha de uma leitura pode abrir breaker para todas as leituras |
| `TS-REAUDIT-01` | P1 | Gap restrito | falta backoff jittered no refresh falho |
| `TS-REAUDIT-05` | P1 | Evidência | falta soak de heap multi-dia |
| `TS-REAUDIT-06` | P1 | Governança | supervisor ainda é observe-only, sem owner/contract por invariant |
| `TS-REAUDIT-07` | P1 | Arquitetura | `service.ts` e `coordinator.ts` continuam crescendo |
| `TS-REAUDIT-10` | P1 | Quality gate | fault matrix não roda em CI normal e não cobre todos os faults pedidos |
| `TS-REAUDIT-11` | P1 | Observabilidade | alertas não têm dedup, hysteresis ou runbook |

## 4. Ordem geral de execução

```text
Fase 0: baseline, decisões e congelamento de invariantes
    ↓
Fase 1: EX-01 + REAUDIT-08 + REAUDIT-04 (P0 de segurança e entrega)
    ↓
Fase 2: EX-02 + PX-01 + REAUDIT-01 + fault matrix expandida
    ↓
Fase 3: stream recovery PR-F/G/H
    ↓
Fase 4: testes PRAC dirigidos + soak PRAC de 72h
    ↓
Fase 5: supervisor, alertas, cache/heap e SLOs
    ↓
Fase 6: decomposição estrutural e guardrails de CI
    ↓
Fase 7: capacidades P1/P2 do roadmap pareado
    ↓
Fase 8: revisão final, ledger, manifest e aprovação armed
```

Paralelismo permitido:

- `EX-01` e `REAUDIT-08` podem ser desenvolvidos em paralelo, pois têm superfícies diferentes.
- `EX-02` pode ser documentado/testado junto com `EX-01`.
- `PX-01` pode ser desenvolvido em paralelo com a preparação do scheduler, mas deve entrar antes do soak.
- Trabalho do gateway e do profile pode ocorrer em paralelo somente quando não houver mudança compartilhada de contrato.

Não iniciar o soak final enquanto os P0 não estiverem corrigidos e a fault matrix não estiver verde.

## 5. Fase 0 — Baseline e preparação

### Tarefas

1. Registrar SHA do gateway e do profile.
2. Registrar contagem de linhas de:
   - `src/service.ts`;
   - `src/execution/coordinator.ts`.
3. Registrar estado do ledger e dos itens acima.
4. Executar `npm run check` no gateway.
5. Executar `python -m unittest discover -s tests` no profile.
6. Executar a fault matrix existente e arquivar o proof JSON com os SHAs.
7. Inspecionar os quatro worktrees não mesclados antes de qualquer remoção:
   - `.fix-pr129`;
   - `.fix-pr130`;
   - `.implementation-work`;
   - `.prod-05-evidence`.
8. Para os três worktrees já mesclados, confirmar alterações não commitadas antes de eventual remoção:
   - `.acceptance-foundation`;
   - `.hermes-foundation`;
   - `.profile-foundation`.

### Cuidados

- Não usar `reset --hard`, `checkout --` ou remoção recursiva.
- Não assumir que um diretório é cruft apenas pelo nome.
- Não tocar `.hermes-foundation2`, `.profile-implementation` ou `.merge-hermes-work` nesta tarefa sem ampliar formalmente o escopo para o profile repo.
- Preservar todo trabalho local existente.

### Saída

Um registro de baseline anexado ao PR ou à evidência da onda. Nenhuma mudança runtime nesta fase.

## 6. Fase 1 — Correções P0 imediatas

### 6.1 `TS-AUDIT31-EX-01`: `status:8` não é proteção comprovada

**Repo:** gateway  
**Áreas:** `src/ownership/`, `src/execution/`, `src/projectx/`, testes de proteção e receipt reconciliation.

#### Implementação

1. Capturar e transportar `order.status` junto com:
   - `providerOrderId`;
   - `parentOrderId`;
   - `linkedOrderId`;
   - `order.type`;
   - preço;
   - quantidade e tranche.
2. Atualizar `resolveProtectiveLeg` e `bindProtection` para não considerar apenas a existência do ID.
3. Representar explicitamente o estado `allocated_unpriced` para `status:8` ou equivalente sem preço válido.
4. Permitir que esse estado continue atribuível à posição, mas não o classificar como:
   - `proven`;
   - `stopCovered`;
   - `protection_status: confirmed`.
5. Fazer `evaluateProtectionHealth` exigir status e preço compatíveis com proteção working comprovada.
6. Verificar que `receipt-reconciliation.ts` não confirme proteção a partir de uma perna `status:8`.
7. Preservar recuperação posterior quando a perna receber preço/status válido.

#### Testes obrigatórios

- Child com `providerOrderId`, `status:8` e `price:null` não confirma proteção.
- Child `status:8` permanece distinguível de ausência total de proteção.
- Transição posterior para working confirma apenas após os dados necessários.
- Scale-in continua funcionando.
- Partial fill e múltiplas tranches permanecem corretamente atribuídos.
- Foreign/manual order continua fora do ownership.
- Breakeven automático continua tighten-only e sem intent.
- Daily capture continua bloqueando entrada nova.

#### Critério de saída

Nenhuma fixture sintética ou live projection pode produzir `protection_status: confirmed` para `status:8` sem preço válido.

### 6.2 `TS-REAUDIT-08`: shutdown crítico não pode perder estado

**Repo:** gateway  
**Áreas:** `src/service/`, `lifecycle-supervisor`, stores e runtime lock.

#### Implementação

1. Fazer qualquer `criticalFailed` implicar retenção de stores e lock.
2. Alterar `shouldRetainShutdownRecoveryState()` para considerar falha crítica, mesmo com backlog vazio.
3. Não liberar o runtime lock enquanto não houver confirmação de que nenhum writer crítico permanece ativo.
4. Preservar estado `failed_shutdown` e informações do disposer que falhou.
5. Separar claramente:
   - disposer best-effort;
   - disposer crítico;
   - stores ainda necessários para recovery.
6. Não transformar falha de shutdown em estado `stopped` limpo.

#### Testes obrigatórios

- Falha de disposer crítico com backlog vazio.
- Falha durante mutation HTTP ainda em andamento.
- Falha durante callback SignalR.
- Assert de que `closeStores()` não ocorre prematuramente.
- Assert de que `runtimeLock.release()` não ocorre prematuramente.
- Restart posterior consegue ler recovery/outbox.
- Falha best-effort continua permitindo shutdown quando seguro.

### 6.3 `TS-REAUDIT-04`: completar entrega durável de intent

**Repos:** gateway e profile  
**Contrato:** manter compatibilidade durante uma janela de retenção.

#### Implementação

1. Depreciar ou redirecionar `/intent/receipt` para o envelope de `/intent/status`.
2. Não remover imediatamente o endpoint antigo sem verificar consumidores.
3. Criar teste com registro de intent, crash antes do receipt e restart.
4. Criar teste com crash depois do início da mutation.
5. Verificar estados `registered`, `mutation_inflight`, `ambiguous`, `terminal` e `not_seen`.
6. No profile, descartar somente quando `not_seen` for autoritativo.
7. Criar fixture consumer-driven entre os dois repositórios.
8. Preservar intents não terminais durante toda a janela de retenção.

#### Critérios de saída

- Receipt ausente nunca equivale a intent inexistente.
- Replay terminal é idempotente.
- O profile retém estado desconhecido ou não terminal.
- A fixture roda com os SHAs pareados.

## 7. Fase 2 — Isolamento de ProjectX e fault matrix

### 7.1 `TS-AUDIT31-EX-02`: blind spot REST de `status:8`

#### Implementação

- Adicionar teste que fixa entrada `MARKET`.
- Documentar no código e em `docs/ARCHITECTURE.md` o intervalo de alocação não observável via REST.
- Atualizar `docs/THREAT-MODEL.md` com a consequência de restart/stream loss nesse intervalo.
- Bloquear qualquer PR que introduza `LIMIT` ou `STOP` sem referenciar este item e resolver a limitação.
- Avaliar uma solução futura em que stream health seja requisito explícito durante o intervalo de alocação.

Não tentar “resolver” o problema preenchendo dados ausentes ou afirmando proteção por inferência.

### 7.2 `TS-AUDIT31-PX-01`: circuit breaker por família

#### Implementação

Separar os contadores/cooldowns por família de endpoint, no mínimo:

- barras/mercado;
- accounts;
- positions;
- orders;
- leituras de reconciliação crítica.

Manter mutations fora do breaker. Preservar backoff e limites existentes onde não houver razão para alterá-los.

#### Testes

- Falha concentrada em `retrieveBars` não abre breaker de positions/orders.
- Falha de `searchOpenOrders` não impede leitura de barras.
- Estados de cooldown são observáveis.
- Testes atuais continuam verdes.

### 7.3 Completar `TS-REAUDIT-01`

Adicionar backoff limitado e jittered em `refreshSession()` quando refresh/login falhar.

Cuidados:

- manter single-flight;
- não repetir mutation;
- preservar bloqueio de nova exposição em auth degraded;
- manter EXIT, flatten e recovery liberados;
- não transformar retry de auth em loop infinito.

### 7.4 Expandir a fault matrix

Adicionar casos para:

- ENOSPC;
- SQLite busy;
- SQLite corruption;
- stream lag;
- `status:8` durante scale-in;
- shutdown crítico com writer vivo;
- crash após registro de intent;
- crash durante mutation;
- auth refresh falho;
- breaker isolado por endpoint.

O gate deve rodar:

- em CI normal para PR/push;
- no release candidate pareado;
- com proof JSON versionado, hashes dos arquivos e SHAs de gateway/profile.

## 8. Fase 3 — Stream recovery

**Item:** `TS-STREAM-RECOVERY-01`  
**Pré-condição:** Fases 1 e 2 verdes.

### 8.1 Reprodução e medição

Antes de modificar o scheduler, medir:

- causa de cada reinício;
- `market_liveness_restart`;
- estado SignalR;
- último evento de mercado;
- `recovery_generation`;
- pressão e latência REST;
- tempo de resubscribe, reconcile e observation;
- p95 de `/health`;
- memória e tamanho do SQLite.

### 8.2 PR-F — scheduler prioritário único

Substituir os quatro timers independentes por uma fila/scheduler coordenado para:

1. reconciliação crítica;
2. recuperação de mercado;
3. observação de mercado;
4. order flow;
5. history sync.

O scheduler deve ter:

- prioridade explícita;
- limite global de concorrência REST;
- prevenção de starvation;
- deadline por tarefa;
- coalescing de tarefas duplicadas;
- contadores de queued/running/deferred/failed/completed;
- comportamento definido durante reconnect storm.

Não alterar os gates de entrada. `quote_stale` e `state_complete` continuam sendo autoridade para nova exposição.

### 8.3 PR-G — reconcile adaptativo

- Ciclo barato para posições e ordens.
- Ciclo completo somente quando necessário.
- Frequência maior durante recovery.
- Backoff em falhas repetidas.
- Deadline global para leituras idempotentes.
- Nenhum retry cego de mutation.
- Reconcile deve conservar identidade de ordens, tranches e recovery.

### 8.4 PR-H — persistência e saúde

Medir e otimizar, sem esconder falhas:

- latência de SQLite;
- busy/lock;
- fsync;
- tamanho do banco;
- fila de evidências;
- tempo de `/health`;
- heap pós-GC;
- backlog e eviction.

## 9. Fase 4 — Validação PRAC

Esta fase exige credenciais, conta PRAC e supervisão humana. Não executar unattended.

### Testes dirigidos

1. Entrada com bracket e proteção criada pela UI nativa.
2. Partial close e comportamento do bracket sobrevivente.
3. Tentativa de alteração durante `status:8`.
4. Cancelamento manual de uma perna OCO.
5. Perda e recuperação de SignalR.
6. Restart durante alocação do bracket.
7. Restart após registro de intent e antes de receipt.
8. Timeout de mutation e reconciliação.
9. Flatten com ordens próprias working.
10. Daily capture atingido com posição aberta.
11. Breakeven automático sem emissão de intent.

### Soak de 72 horas

Registrar por sessão:

- reinícios e causa;
- eventos de mercado recentes;
- falhas de reconnect;
- latência de REST;
- p95 de `/health`;
- estado de proteção;
- intents e mutations ambíguas;
- evidence backlog;
- heap pós-GC;
- cache cardinality/eviction;
- divergência supervisor/gate;
- novas exposições bloqueadas corretamente.

Não fechar `TS-STREAM-RECOVERY-01`, `TS-REAUDIT-05` ou `TS-REAUDIT-06` sem os respectivos artefatos de evidência.

## 10. Fase 5 — Observabilidade e autoridade

### 10.1 `TS-REAUDIT-06`

- Definir owner e gate contract por invariant.
- Manter observe-only enquanto medir.
- Comparar supervisor e execution gate por razão, não apenas por boolean.
- Executar shadow soak.
- Promover uma invariant por release.
- Permitir rollback individual.
- Nunca bloquear EXIT, proteção ou recovery obrigatório.

### 10.2 `TS-REAUDIT-11`

Ampliar `HealthAlert` com:

- `alert_id`;
- severidade;
- dedup key;
- `last_fired`;
- threshold de abertura;
- threshold de limpeza;
- janela de hysteresis;
- runbook URL;
- estado de recuperação.

Corrigir a documentação para não declarar hysteresis implementado antes do código existir.

Gates críticos podem bloquear nova exposição ou reduzir modo somente após shadow evidence, revisão operacional e caminho de rollback. Redução de risco deve permanecer disponível.

## 11. Fase 6 — Memória, performance e arquitetura

### `TS-REAUDIT-05`

O código já limita os caches principais; falta provar estabilidade. Executar soak sintético multi-dia com:

- rearm states;
- outcomes hot cache;
- REST hash cache;
- provider evidence;
- SQLite;
- heap antes/depois de GC;
- backlog e eviction.

### `TS-REAUDIT-07`

1. Manter baseline numérica.
2. Criar ratchet para impedir crescimento sem extração justificada.
3. Adicionar import-cycle check.
4. Mover um bloco por PR, começando por:
   - rearm state;
   - partial EXIT;
   - amendment de breakeven sem outbox.
5. Testar composição root e paridade semântica antes de remover duplicações.

Não fazer reescrita big-bang de `service.ts` ou `coordinator.ts`.

## 12. Fase 7 — Roadmap posterior

Só iniciar após os P0, fault matrix e soak estarem aprovados.

### Contract e runtime pareados

- Fixtures comuns do gateway/profile.
- Versão do contrato distribuído.
- `amendment_source`.
- `original_risk_envelope` imutável.
- identidade de candidato selecionado.
- model-owner state.
- outcome chronology e evidence quality.
- versões desconhecidas falhando de modo seguro sem apagar recovery.

### Hermes model ownership

No profile:

- um lock atômico por profile;
- direct cognition, repair e learning sob a mesma admissão;
- prioridade: positioned/direct, flat, learning;
- preempção com término confirmado da árvore de processos Windows;
- recuperação de lock usando PID e process start identity;
- nenhum kill por PID isolado;
- estados waiting/deferred/preempted/recovered/failed/completed persistidos.

### Outcomes, triggers e seleção

- Cronologia MFE/MAE com evidência de qualidade.
- Intervalos por geometria ativa de stop/target.
- Partial fill/exit e tranches preservados.
- Triggers tipados com ID, condição, invalidação, expiração e replacement.
- Uma única revisão account-global por trigger.
- Seleção de exatamente um candidato ou `NOTHING` global.
- Revalidação de identidade, lease, quote, daily capture, capacidade e geometry no delivery.
- Candidatos não selecionados permanecem observation-only.

### Forecasts e overlays

Forecasts devem ser somente metadados locais para análise e learning. Não podem:

- criar minimum-confidence gate;
- forçar `NOTHING`;
- definir sizing;
- autorizar intent.

Overlays devem seguir:

`proposed → holdout_evaluated → shadow → canary → active → expired/rolled_back`.

Treino e avaliação devem usar episódios separados, com métricas por sessão, versão, instrumento, horizonte, geometria e qualidade de evidência.

## 13. Organização de PRs

Sugestão de PRs pequenos e reversíveis:

1. Gateway: `status:8` protection classification.
2. Gateway: critical shutdown retention.
3. Gateway/profile: intent status integration fixtures.
4. Gateway: MARKET-only guard and documentation for REST blind spot.
5. Gateway: endpoint-family circuit breaker.
6. Gateway: auth jittered backoff.
7. Gateway/profile: expanded fault matrix and CI gate.
8. Gateway: PR-F scheduler.
9. Gateway: PR-G adaptive reconcile.
10. Gateway: PR-H persistence/health tuning.
11. Profile: model-owner and learning preemption, se houver residual aberto.
12. Observability: alert state, dedup, hysteresis and runbooks.
13. Architecture: one vertical extraction at a time.

Cada PR deve conter:

- escopo e item do ledger;
- comportamento antes/depois;
- testes determinísticos;
- impacto de recovery;
- impacto no contrato, se houver;
- evidência de que daily capture e breakeven não foram enfraquecidos;
- resultado de `npm run check` no gateway;
- resultado dos testes Python no profile quando aplicável.

## 14. Testes e comandos mínimos

Gateway:

```powershell
npm run check
npm test
npm run reaudit:fault-matrix
```

Profile:

```powershell
python -m unittest discover -s tests
```

Testes direcionados do gateway, quando aplicável:

- `tests/amendment-safety.test.ts`;
- `tests/execution-coordinator.test.ts`;
- testes de protection/ownership;
- testes de lifecycle/shutdown;
- kill matrix quando tocar recovery ou delivery.

Não considerar apenas testes unitários puros como prova de crash/restart. Para itens de persistência, deve existir teste com store real, restart simulado e verificação do estado reconstruído.

## 15. Riscos e controles

| Risco | Controle obrigatório |
|---|---|
| Falsa proteção em `status:8` | Estado `allocated_unpriced`, nunca `confirmed` |
| Duplicação de mutation | Identidade durável e reconciliação; sem retry cego |
| Shutdown com writer vivo | Reter stores e runtime lock em qualquer falha crítica |
| Reconnect storm | Scheduler único, prioridades e coalescing |
| Circuit breaker amplo demais | Isolamento por família de endpoint |
| Soak insuficiente | 72h PRAC supervisionado e métricas objetivas |
| Crescimento de heap | Cache bounds, eviction e heap slope evidenciado |
| Alerta flapping | Dedup, hysteresis, clear state e runbook |
| Alteração em worktree errado | Inspeção de branch/diff antes de remover ou integrar |
| Divergência gateway/profile | Fixtures pareadas e manifest com SHAs |
| Relaxamento indevido por “melhoria” | Revisar contra regras inegociáveis e stop lines |

## 16. Critérios de promoção

Não promover para autonomia prolongada enquanto qualquer condição abaixo for verdadeira:

- `TS-AUDIT31-EX-01` aberto;
- `TS-REAUDIT-08` aberto;
- entrega de intent sem teste end-to-end de crash/restart;
- fault matrix incompleta ou não verde;
- soak PRAC de 72 horas ausente;
- reinícios inexplicados relevantes;
- proteção confirmada sem status/preço válidos;
- nova exposição liberada com quote stale ou `state_complete=false`;
- alteração de contrato sem release pareado;
- ledger desatualizado;
- ausência de rollback documentado.

## 17. Definição de pronto

O trabalho estará pronto quando:

1. Todos os P0 estiverem corrigidos e testados.
2. Os itens P1 críticos tiverem implementação e evidência correspondente.
3. Gateway e profile consumirem a mesma versão de fixtures pareadas.
4. A fault matrix rodar em CI e no release candidate.
5. O soak PRAC de 72 horas estiver documentado por sessão.
6. Os testes PRAC dirigidos estiverem aprovados pelo operador.
7. Não houver falsa confirmação de proteção, duplicate mutation ou shutdown falso.
8. Os gates de daily capture, breakeven, quote freshness e state completeness continuarem intactos.
9. O ledger tiver status, dependências, PRs, evidências e links atualizados.
10. `release/paired-contract.json` e a cópia do profile estiverem sincronizados quando aplicável.
11. Houver aprovação explícita para promoção `armed-production`.

## 18. Próximo trabalho recomendado

Começar por dois PRs independentes:

1. `TS-AUDIT31-EX-01`: corrigir classificação de proteção `status:8`.
2. `TS-REAUDIT-08`: impedir fechamento/liberação de estado após falha de disposer crítico.

Em seguida, fechar `TS-REAUDIT-04` com teste real de crash/restart e fixtures do profile. Só então iniciar o ciclo de scheduler e stream recovery.

