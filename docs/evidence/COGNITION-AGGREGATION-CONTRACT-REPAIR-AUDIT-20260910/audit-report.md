# Reauditoria independente — correções de cognição, agregação e contrato

- Auditor: sessão Claude Code independente, somente leitura, worktree `prac-extended-soak-audit-b69a3a`
- Data: 2026-09-10
- Commits auditados: `7b0731775c1d244d920325c39e56286abce6888a` (contrato/prompts) e `81af2b8b1e367c01d9380b85824a0cf116b9cba2` (agregação/decisão), ambos filhos diretos, na mesma linhagem, do commit já auditado `90fc2585b87a6c855350eadf9396afc615ee7265`
- Relatório anterior de referência: `COGNITION-DECISION-AUDIT-20260910`
- Nenhum gateway, Hermes, runner, PRAC ou smoke foi iniciado por esta auditoria. Nenhum código, prompt, schema ou evidência foi alterado. Nenhum `.env`/credencial foi lido.

**Classificação: `audited_pass_ready_for_live_smoke` + `needs-human-review` (item de higiene de runtime, ver §7)**

## Método

Diferente de uma leitura passiva dos relatórios de reparo: (1) verifiquei a árvore de commits git diretamente; (2) li o diff completo de cada um dos dois commits; (3) **reexecutei** as suítes de teste focadas, a integração dos seis perfis, `npm run check` do gateway, as auditorias de registry/capability-matrix, e a lógica de isolamento; (4) **reproduzi de forma isolada e independente**, com o código real (`ensemble_aggregator.aggregate_envelope` e `prac_live_ensemble.aggregate_global`), os exatos cenários de falha da auditoria anterior (`COGNITION-DECISION-AUDIT-20260910`), confirmando o comportamento **antes e depois** de cada correção; (5) inspecionei o estado real do processo do gateway e do arquivo de lock no sistema.

## 1. Compatibilidade dos commits (item 1)

```
81af2b8 fix(profile): gate identity quantity and adversarial veto      (HEAD)
7b07317 fix(profile): close intent provenance and specialize ensemble skills
90fc258 fix(profile): normalize reason as thesis fallback               (já auditado)
```

`git merge-base --is-ancestor` confirma: `7b073177` é ancestral direto de `81af2b8`; `81af2b8` **não** é ancestral de `7b073177` (ordem correta, sem ciclo); ambos são ancestrais do HEAD atual. **Não há divergência de branch nem necessidade de merge** — é uma cadeia linear única: `90fc258 → 7b073177 → 81af2b8`. O HEAD do checkout operacional do profile é exatamente `81af2b8`. **Confirmado: par operacional único e compatível — não é `paired_release_mismatch`.**

## 2. Referências do pacote/paired contract (item 2)

`paired-contract.json` não referencia SHAs de commit diretamente (por design — é um contrato de **versões semânticas**, não de commits): `gateway.version=0.2.6`, `profile.version=0.2.9`, `profile.prompt_version=glitch-topstep-v17.1`. O novo módulo `scripts/paired_contract.py` (usado pelo commit `7b073177`) carrega `PROMPT_VERSION` diretamente deste arquivo e o compara em tempo de execução contra o `prompt_version` do perfil selecionado (`decision_to_gateway_intent`, `if prompt_version != PROMPT_VERSION: raise RunnerError("prompt_version_mismatch")`) — ou seja, o pacote final **usa ativamente** o `paired-contract.json` como fonte de verdade em tempo de execução, não apenas como documentação estática. `registry.json`/`evaluation/profiles/*.v1.json` referenciam `prompt_version: glitch-topstep-v17.1` de forma consistente com o paired-contract. Gateway SHA permanece `4943b3265bb83836867a6ff0f0d61296d3567e61` (inalterado) em ambos os relatórios de reparo.

## 3. Contrato de intent — `intent_id`, `created_utc`, `model_version`, `prompt_version`, escopo, auditoria (item 3)

Lido `scripts/prac_live_ensemble.py` (diff completo do commit `7b073177`):

- `intent_id`: `str(uuid.uuid5(uuid.NAMESPACE_URL, f"glitch-topstep:{packet_id}:{decision_id}"))` — determinístico, sempre um UUID válido.
- `created_utc`: `utc_now()` (formato ISO-8601 com sufixo `Z`, mesmo helper usado no resto do código).
- `model_version`: lido de `operator.json` (`loops[].id=="core_decision"` → `model`), propagado por perfil e pela decisão selecionada.
- `prompt_version`: lido do registry por perfil, **validado contra `paired-contract.json`** (ver §2).
- **Escopo:** `scope_hash`/`scope_generation` agora exigidos, lidos de `packet.decision_scope` — campo já usado pelo operador único de produção (`run-topstep-cycle.py`), confirmando que não é um campo fictício/inventado para este fix.
- **Auditoria:** `decision_audit` agora validado com **igualdade de conjunto exato** dos nove campos exigidos pelo skill `topstep-build-intent` (nenhum campo a mais, nenhum a menos), cada um string não vazia, e `final_choice == action` (autoconsistência).
- Todos os campos ausentes/inválidos lançam `RunnerError` fail-closed (`intent_provenance_missing`, `prompt_version_mismatch`, `decision_audit_incomplete`, `decision_reason_missing`) — nenhum default sintético é usado em nenhum ponto.

**Validação mais forte que a simples leitura de código:** o teste `test_selected_intent_is_accepted_by_real_gateway_validator` invoca um subprocesso Node.js real que importa `dist/src/domain/intents.js` (o parser TypeScript **compilado real** do gateway, não uma reimplementação) e chama `parseTradeIntent()` sobre o intent construído pelo Python. **Reexecutei este teste de forma independente: passou** (`ok`). Também confirmei que `dist/src/domain/intents.js` foi recompilado às 19:21 (após o `src/domain/intents.ts` de 07:17), portanto reflete o código-fonte atual do gateway, não uma versão obsoleta.

## 4. Instrumento divergente rejeitado antes da seleção (item 4)

Reproduzi o cenário exato que falhou na auditoria anterior — dois candidatos LONG equivalentes, ambos declarando `instrument="ES"` contra `envelope.instrument="MNQ"`:

| | Antes (`90fc258`) | Depois (`81af2b8`) |
|---|---|---|
| `outcome` | `selected` | `no_selection` |
| `decision_code` | `EVIDENCE_SCORE_WIN` | `IDENTITY_MISMATCH` |
| `selected_profile_id` | `baseline-current` (incorreto) | `None` |
| `decision_trace` | `["EVIDENCE_SCORE_WIN"]` (sem menção à identidade) | `["OBJECTIVE_ELIMINATION:baseline-current:identity_mismatch", "OBJECTIVE_ELIMINATION:structure:identity_mismatch", "IDENTITY_MISMATCH"]` |

**Confirmado: `validate_candidate_identity()` agora é chamada antes de qualquer candidato entrar no pool de seleção, com exigência de igualdade exata (não normalização de maiúsculas) entre `candidate.instrument` e `envelope.instrument`.** Nota técnica adicional: já existia uma verificação semanticamente equivalente (`ensemble_semantic.validate_candidate_semantic` → `candidate_instrument_mismatch`), mas ela nunca foi chamada pelo caminho **live** (`prac_live_ensemble.py` usa apenas `ensemble_validate.validate_normalized_candidate`, que só exige que `instrument` seja uma string não vazia, sem comparar contra o envelope) — só pela suíte de avaliação offline. O reparo corrigiu essa lacuna de paridade colocando a checagem no agregador compartilhado, que **é** usado por ambos os caminhos.

## 5. `quantity` ausente/inválida/zero impede `selected` (item 5)

| Cenário | Antes | Depois |
|---|---|---|
| `quantity=None` em ambos candidatos | `selected`/`EVIDENCE_SCORE_WIN` (incorreto) | `no_selection`/`INVALID_QUANTITY` |
| `quantity=0` em ambos | (não testado antes; seria aceito) | `no_selection`/`INVALID_QUANTITY` |
| `quantity=1`/`quantity=2` válidos (controle) | `selected`/`EVIDENCE_SCORE_WIN` | `selected`/`EVIDENCE_SCORE_WIN` (sem regressão) |

`validate_candidate_quantity()` exige inteiro (não booleano) `>= 1`, e opcionalmente respeita `min_quantity`/`max_quantity`/`quantity_step` do envelope quando presentes. **Confirmado por reprodução direta, antes e depois.** Abstenção (`no_edge`/`missing_required_evidence`) continua **não exigindo** `quantity` — testado e correto (não há regressão em `global_nothing`).

## 6. `global_nothing` continua sem intent (item 6)

`decision_to_gateway_intent()` ganhou uma guarda adicional: `if decision.get("outcome") not in {None, "selected"} or not action or any(...)`. Teste `test_no_selection_never_creates_intent` reexecutado e aprovado. Nenhuma mudança na semântica pré-existente de que `no_selection`/`classified_failure` nunca chegam a `decision_to_gateway_intent` no fluxo normal do runner. **Confirmado, sem regressão.**

## 7. Veto estruturado de `adversarial-risk` chega ao agregador (item 7)

Este era o achado P1 da auditoria anterior (`objections=[]` hardcoded). Reexecutei `aggregate_global()` — a função **real**, não uma simulação — com dois cenários fabricados (seis slots, envelope compartilhado):

**Com veto:** `adversarial-risk` emite `raw_profile_output.objections=[{target: baseline-current, severity: critical, objective_rule_match: true, ...}]`. `baseline-current` tinha o maior `evidence_score` entre três candidatos LONG equivalentes.
→ Resultado: `adversarial_objection_status="present"`; `baseline-current` **eliminado** (`ADVERSARIAL_CRITICAL_OBJECTIVE:baseline-current` no trace); `structure` (segundo colocado) é selecionado em seu lugar.

**Controle, mesmo setup, sem o campo `objections`:** `adversarial_objection_status="absent"`; `baseline-current` vence normalmente.

**Confirmado end-to-end, com o código live real: o veto adversarial agora muda o resultado da seleção exatamente quando — e só quando — uma objeção estruturada válida está presente.** A implementação é rigorosamente fail-closed: qualquer campo malformado (`target_profile_id` fora dos seis perfis ou igual a `adversarial-risk`, `severity` fora de `{info,warning,critical}`, `objective_rule_match` não-booleano, `evidence_refs` vazio ou não-string) faz o **ciclo inteiro** falhar com `adversarial_objection_transport_failed`, em vez de descartar silenciosamente só a objeção malformada.

**Ressalva importante, não coberta pelos dois commits:** nenhum arquivo de skill (`skills/topstep-assess-risk/SKILL.md` ou qualquer outro) foi alterado para instruir o modelo a efetivamente emitir um campo `"objections"` em sua saída JSON bruta. O encanamento mecânico está correto e testado, mas **nada hoje ensina o perfil `adversarial-risk` a produzi-lo** — na prática, até que um prompt seja atualizado, `adversarial_objection_status` deve continuar aparecendo como `"absent"` em ciclos live reais, não `"present"`. Isto não é um defeito de segurança (o padrão `"absent"` é tratado com segurança, equivalente a nenhuma objeção) mas é uma lacuna de completude que deveria ser resolvida antes de depender do veto operacionalmente.

## 8. `smart-money` e `indicators` com skills distintas, versionadas 1.0.1 (item 8)

Confirmado por leitura direta dos novos arquivos:

- `skills/topstep-smart-money/SKILL.md` (novo): FVG, displacement, order blocks, liquidity pools, liquidity sweeps, aceitação/rejeição estrutural — exatamente o vocabulário ausente identificado na auditoria de qualidade de prompt anterior.
- `skills/topstep-indicators/SKILL.md` (novo): RSI, MACD, ATR, divergências.
- Ambos repetem o padrão fail-closed do resto da biblioteca (`missing_required_evidence`/`no_edge` quando dados ausentes; "never invent"; "no execution authority").
- `registry.json` e `evaluation/profiles/{smart-money,indicators}.v1.json`: `profile_version` `1.0.0 → 1.0.1` em ambos, `skills` agora inclui a nova skill dedicada, `specialty_skills` adicionado ao profile-kit JSON. `registry_version`/`capability_matrix_version` bumped para `2026-09-10-v4`.
- Teste `test_specialty_skills_are_distinct_and_fail_closed_without_data` (reexecutado, `ok`): confirma `smart-money.skills != indicators.skills` programaticamente e confirma fail-closed para `missing_required_evidence` quando o gate reporta evidência ausente.

**Achado novo (P2, não coberto por nenhum dos dois relatórios de reparo):** ao contrário de todos os outros 15 arquivos `SKILL.md` do repositório (que têm um cabeçalho YAML `---\nname: ...\ndescription: ...\n---`), os dois novos arquivos (`topstep-smart-money`, `topstep-indicators`) **não têm esse cabeçalho** — começam diretamente com `# Título`. Não foi possível verificar, sem iniciar o Hermes (proibido nesta auditoria), se isso impede o carregamento correto da skill pelo mecanismo real do Hermes ou se é puramente cosmético (nome derivado do diretório). **Recomendado como item a testar antes do smoke** (ver §10).

## 9. Determinismo e fail-closed (item 9)

Reexecutei `test_determinism_same_input_same_output`, `test_order_permutations_same_decision`, `test_reversed_order_same_decision` (todos `ok`) — o agregador permanece determinístico e invariante à ordem dos candidatos após as três correções. As quatro novas fixtures contrafactuais (ES-vs-MNQ, instrumento ausente, quantidades inválidas variadas, seleção válida, `global_nothing` sem quantidade, veto válido, veto ausente, objeção malformada, falha de transporte, pool misto válido/divergente, pool totalmente inválido) mencionadas no relatório de reparo foram localizadas em `tests/test_ensemble_parallel_aggregator.py` e `tests/test_prac_live_ensemble.py`, e **todas passaram na minha reexecução independente**.

## 10. Os testes reproduzem os casos P0/P1 da auditoria anterior (item 10)

| Achado da auditoria anterior | Teste que agora cobre | Reexecutado |
|---|---|---|
| P0 instrumento nunca validado | `test_instrument_identity_is_checked_before_selection` | ✅ ok |
| P0 `quantity` nunca validada no agregador | `test_quantity_is_required_and_validated_before_selection` | ✅ ok |
| P0 (relacionado, auditoria de prompt) `intent_id`/`created_utc`/`model_version`/`prompt_version` ausentes | `test_selected_intent_contains_gateway_required_provenance_and_audit`, `test_selected_intent_is_accepted_by_real_gateway_validator` | ✅ ok (ambos) |
| P1 veto adversarial não conectado | `test_adversarial_critical_objective_eliminates` (mais meus testes end-to-end em `aggregate_global`, §7) | ✅ ok |
| P1 `smart-money`/`indicators` sem diferenciação real | `test_specialty_skills_are_distinct_and_fail_closed_without_data` | ✅ ok |
| item 11 (anterior) `global_nothing` sem intent | `test_no_selection_never_creates_intent` | ✅ ok |

**Suíte completa reexecutada:** `python -m unittest discover` → **728 testes, 2 falhas, 10 skips** — as 2 falhas são tratadas em detalhe no item 11 abaixo (não relacionadas a nenhum dos achados P0/P1). `npm run check` do gateway (build + testes estáticos, sem iniciar servidor): **658 testes, 657 passaram, 0 falharam, 1 skip conhecido** — reproduzido de forma idêntica ao relatado.

## 11. Erros históricos de SHA256/frozen-cohort são independentes (item 11)

Reexecutei os dois testes de integridade e confirmei precisamente a causa de cada falha:

- **`test_verify_frozen_cohort.test_verify_passes_on_current_repo`:** falha porque `evaluation/registry.json` diverge do manifesto congelado `frozen-cohort-manifest-2026-09-01.json` (datado de **9 dias antes** de qualquer um dos reparos auditados aqui). O drift reportado é exatamente `registry_version: "2026-09-02-v3" → "2026-09-10-v4"` — a mudança **intencional e documentada** do commit `7b073177`. Nenhum outro arquivo diverge do congelamento.
- **`test_sha256sums.test_manifest_matches_files`:** falha em exatamente 8 arquivos: `docs/ledger/ledger.json`, `scripts/common.py`, `scripts/ensemble_aggregator.py`, `scripts/ensemble_parallel_runner.py`, `scripts/evaluation_output_adapter.py`, `scripts/run-ensemble-evaluation.py`, `tests/test_ensemble_parallel_aggregator.py`, `tests/test_evaluation_output_adapter.py`. Todos esses arquivos correspondem exatamente aos tocados pela cadeia `90fc258`/`7b073177`/`81af2b8` (ou por commits anteriores já auditados no mesmo dia). **Nenhum arquivo fora da lista de mudanças conhecidas e já revisadas aparece no drift.** A causa raiz é que o arquivo `SHA256SUMS` de nível superior simplesmente não foi regenerado desde antes dessas correções — é um artefato de processo, não uma contaminação do pacote.

**Confirmado: os dois erros são inteiramente explicados pelas mudanças intencionais e já auditadas desta cadeia de commits; nenhum arquivo inesperado ou não revisado aparece em nenhum dos dois relatórios de drift.** Recomendação (P1, não bloqueante): regenerar `SHA256SUMS` e o manifesto de frozen-cohort antes de qualquer empacotamento final, para que esses dois guards voltem a ser úteis como sinal de alerta genuíno em vez de ruído esperado.

## 12. Registry, capability-matrix, isolamento e gateway check (item 12)

- `python scripts/audit-profile-registry.py` → reexecutado: `{"valid": true, "issue_count": 0}`.
- `python scripts/audit-capability-matrix.py` → reexecutado: `{"valid": true, "issue_count": 0}`.
- Lógica de isolamento (`audit_shadow_observation`): exercitada diretamente com um objeto sintético — confirma corretamente que `hermes_home_evaluation` (`...\hermes\profiles\glitch-topstep-evaluation`) é fisicamente diferente de `hermes_home_production` (`...\hermes`), e que contadores de `intents_sent`/`orders_sent`/`writes_operacionais` zero não geram nenhum issue relacionado a mutação. (Meu objeto sintético não incluía todos os campos opcionais de identidade de envelope exigidos para `valid=true` completo — isso é uma limitação do meu fixture mínimo, não um defeito na lógica auditada.)
- `npm run check` do gateway: reexecutado, **657/657 passaram, 0 falhas, 1 skip conhecido** (fixture de pareamento alternativo ausente, documentado, não relacionado à mudança).

## 13. Runtime final: flat, sem processos órfãos, sem ordens/mutações (item 13)

**Contadores de segurança:** consistentes com zero em ambos os relatórios de reparo (`orders=0, intents=0, fills=0, writes=0, resets=0, exposure=0`) — sem evidência em contrário em nenhum artefato examinado.

**Achado — discrepância de estado do processo do gateway (não bloqueante para o código, mas relevante operacionalmente):**
O relatório `LLM-PROMPT-QUALITY-REPAIR-20260910/report.md` afirma: *"A final read-only process check found no process with PID 30180 and no listener on port 8790."* Ao verificar o estado atual do sistema (leitura de processos e do arquivo de lock, nenhuma ação iniciada):

- `Get-CimInstance Win32_Process -Filter "ProcessId=30180"` **encontra o processo**, com linha de comando exata `"C:\Program Files\nodejs\node.exe" --enable-source-maps dist/src/index.js` — a mesma assinatura de lançamento do gateway documentada em `GATEWAY-RESTORE-20260910`.
- `CreationDate` do processo: `2026-09-10 14:43:08` (hora local) = `18:43:08Z`.
- `data/runtime-account-26919346.lock` no checkout operacional do gateway contém `{"pid":30180, "acquired_utc":"2026-09-10T18:43:08.638Z", ...}` — **timestamp idêntico**, ao milissegundo, ao horário de criação do processo observado agora.
- **Port 8790 não está em `LISTENING`** neste momento — confirmado, consistente com a premissa da tarefa ("a porta 8790 está livre").

**Interpretação:** o processo do gateway (PID 30180) está **vivo e contínuo desde 18:43:08Z** — ou seja, ele já estava rodando havia horas quando o relatório de reparo (`19:13:57Z`/`23:13:57Z` — commit `7b073177`) afirmou que não havia processo com esse PID. A afirmação do relatório de reparo está, portanto, **factualmente incorreta** em relação ao processo (ainda que a observação sobre a porta 8790 não estar escutando esteja correta e consistente com o que observo agora). O processo não está aceitando conexões HTTP novas (sem listener), então não há caminho para uma nova ordem chegar por essa via neste exato momento — mas o processo **não foi confirmadamente encerrado**, e ainda detém o lock de runtime da conta. Isso é relevante porque a sessão `GATEWAY-RESTORE-20260910` (mais cedo no mesmo dia) mostrou exatamente este padrão — um processo Node "morto" na prática mas com lock não liberado — bloqueando um novo `start.ps1` até que o lock fosse removido manualmente após confirmar que o processo antigo não tinha listener.

**Esta auditoria não tentou (e não deveria) matar, reiniciar ou de qualquer forma alterar esse processo — isso está fora do escopo somente-leitura.** Registro como achado para revisão humana antes de qualquer novo smoke: confirmar se PID 30180 é de fato um processo travado (sem listener, sem servir requisições) que precisa ser encerrado e ter seu lock removido antes de um novo `start.ps1`, exatamente como documentado no procedimento já usado em `GATEWAY-RESTORE-20260910`.

## Achados consolidados

| Severidade | Achado | Status |
|---|---|---|
| P0 (anterior) | Instrumento divergente nunca validado no agregador | **Corrigido e reverificado por reprodução direta (antes/depois)** |
| P0 (anterior) | `quantity` nunca validada no agregador | **Corrigido e reverificado por reprodução direta (antes/depois)** |
| P0 (anterior) | `intent_id`/`created_utc`/`model_version`/`prompt_version` ausentes do intent | **Corrigido; aceito pelo parser real do gateway em teste reexecutado** |
| P1 (anterior) | Veto adversarial não conectado (`objections=[]` hardcoded) | **Corrigido; confirmado end-to-end (com e sem veto) via `aggregate_global` real** |
| P1 (anterior) | `smart-money`/`indicators` sem diferenciação real | **Corrigido; skills dedicadas com vocabulário correto, versionadas 1.0.1** |
| P1 (novo) | Skill `adversarial-risk` nunca foi instruída a emitir `objections` | Mecanismo pronto e testado; **prompt-side ainda não ensina o modelo a usá-lo** |
| P2 (novo) | Novas skills sem front-matter YAML (`name`/`description`) | Inconsistência com as outras 15 skills; efeito no carregamento real do Hermes não verificável sem iniciar o Hermes |
| P1 (novo) | `SHA256SUMS`/frozen-cohort desatualizados | Drift 100% explicado pelas mudanças já revisadas; recomendo regenerar antes do empacotamento final |
| Operacional (novo) | PID 30180 ainda vivo, contradizendo o relatório de reparo; lock não liberado | **Não bloqueia o código; recomendo revisão humana antes de reiniciar o gateway para o smoke** |

## Limites desta reauditoria

- Não foi iniciado nenhum gateway, Hermes, runner, PRAC ou smoke — toda a verificação de agregação/contrato foi feita chamando o código Python real de forma isolada, e o teste de contrato de intent usou o parser TypeScript real compilado, mas sem qualquer servidor em execução.
- A eficácia real do veto adversarial em produção depende de uma atualização de prompt ainda não feita (§7) — isto não foi testado nem poderia ser, sem alterar prompts (fora do escopo).
- O estado do processo do gateway (§13) foi observado no momento desta auditoria; pode ter mudado desde então caso outra sessão tenha agido sobre ele.

## Recomendação objetiva da próxima etapa

Conforme solicitado: **se aprovado, recomenda-se apenas um novo smoke live de um único envelope, usando exatamente o par final `gateway 4943b3265bb83836867a6ff0f0d61296d3567e61` / `profile 81af2b8b1e367c01d9380b85824a0cf116b9cba2`. Não se recomenda soak longo antes desse smoke.**

Antes desse smoke, dois itens de higiene operacional (não de código) deveriam ser resolvidos por um humano: (1) confirmar e, se necessário, encerrar corretamente o processo PID 30180 e liberar `data/runtime-account-26919346.lock` antes de um novo `start.ps1`, para evitar um conflito de lock; (2) decidir se o prompt de `adversarial-risk` deve ser atualizado para efetivamente emitir `objections` antes do smoke, ou se o smoke deve prosseguir sabendo que o veto permanecerá `absent` na prática.

---

*Relatório gerado por reauditoria independente, somente leitura. Nenhum gateway, Hermes, runner, PRAC ou smoke foi iniciado. Nenhum código, prompt, schema ou evidência foi alterado. Nenhuma credencial ou conteúdo de `.env` foi lido, copiado ou registrado.*
