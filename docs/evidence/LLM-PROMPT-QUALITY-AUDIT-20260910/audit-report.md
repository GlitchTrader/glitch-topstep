# Auditoria independente — qualidade de prompts, JSONs e respostas do ensemble Hermes

- Auditor: sessão Claude Code independente, somente leitura, worktree `prac-extended-soak-audit-b69a3a`
- Data: 2026-09-10
- Escopo: prompts/skills dos 6 perfis, envelopes, normalização, agregador, decisão global, contrato de entrega ao gateway — comparados contra (a) arquitetura anterior de operador único e (b) roadmap Glitch NT
- Nenhum gateway, Hermes, runner, PRAC, soak ou ordem foi iniciado. Nenhum código, prompt, schema ou evidência foi alterado. Nenhuma credencial ou `.env` foi lido.

**Classificações (separadas, conforme solicitado):**

| Dimensão | Classificação |
|---|---|
| Qualidade de prompt/skills | `prompt_quality_pass_with_findings` |
| Schema/contrato de execução | `schema_contract_concern` |
| Cobertura de execução real | `execution_quality_not_exercised` |
| Necessidade de revisão humana | `needs-human-review` |

---

## 1. Referências e versões examinadas

**Implementação atual (ensemble, 6 perfis)** — checkout `.runner-implementation-20260910/profile`, HEAD `90fc2585b87a6c855350eadf9396afc615ee7265` (`fix(profile): normalize reason as thesis fallback`, filho de `435a64a40fd7e5c4285f2bef5c17ccf42c0ee0d7`):

- `evaluation/registry.json` (`registry_version=2026-09-02-v3`), `evaluation/capability-matrix.json` (`matrix_version=2026-09-02-v3`), `evaluation/aggregator_rules.v1.json` (`rules_version=2026-09-01-v2`), `evaluation/schemas/normalized_candidate.v1.json`.
- `scripts/prac_live_ensemble.py` (runner live), `scripts/run-ensemble-evaluation.py` (`build_normalized_candidate`), `scripts/ensemble_capacity_overlay.py`, `scripts/evaluation_output_adapter.py` (normalizador `thesis`/`reason`, corrigido em `90fc258…`).
- `SOUL.md` (identidade/constituição do operador — 55 linhas), `skills/topstep-*/SKILL.md` e `skills/orderflow-liquidity/SKILL.md` (17 arquivos, 432 linhas totais).
- Gateway pareado: `.prac-operational-20260910/gateway`, HEAD `4943b3265bb83836867a6ff0f0d61296d3567e61`, `src/domain/intents.ts` (contrato `glitch.intent.v3`).

**Implementação anterior ao ensemble (operador único)** — `operator.json` (`schema_version=glitch.topstep.hermes.operator.v2`) e `SOUL.md` no mesmo checkout do profile: descrevem o operador contínuo único (`core_decision` a cada 1–5 min, `model=gpt-5.6-luna`, `provider=openai-codex`, `execution_authority=false` mas com `cognitive_overlay_default=propose_only` e skill `topstep-submit-intent` habilitada). **Lacuna registrada:** não foi encontrado, dentro deste repositório, um snapshot histórico versionado (tag/branch) do prompt único anterior à decomposição em skills — `SOUL.md` e `operator.json` são o estado atual do operador de referência, não um congelamento datado do "antes". A comparação abaixo usa `operator.json`/`SOUL.md` como a melhor referência disponível e documenta essa lacuna em vez de presumir equivalência total.

**Arquitetura Glitch NT** — `docs/plans/2026-08-20-nt-adaptation-roadmap.md` (roadmap completo, ondas 0–11) e `docs/plans/2026-08-25-complete-audit-implementation-plan.md` (plano de auditoria P0/P1/P2 de confiabilidade gateway/profile, ortogonal à qualidade cognitiva). Políticas congeladas: *daily-capture* pode bloquear novas entradas após meta realizada; *breakeven* automático é gateway-owned, tighten-only, intent-free (`docs/plans/2026-08-20-nt-adaptation-roadmap.md` §1).

## 2. Hashes (SHA-256, arquivos completos)

| Arquivo | SHA-256 |
|---|---|
| `SOUL.md` | `4850fc21ebb3aa905c6cef0c7e33237c3cbc592af51f26d2e256b35784006119` |
| `operator.json` | `bdeb8c880be09bbe0a4c545c79e36a8fa0f95e5248f6baa234473610cede1d98` |
| `evaluation/registry.json` | `b11062a9818d445aefb57bfc9fff314b19d4fc29043b41c51672378cdb63a68d` |
| `evaluation/capability-matrix.json` | `7e4be060f4906ac268ec91546fdd17fcb0f90ac8c8dc2a9ec5e80d9f1c6414c0` |
| `evaluation/aggregator_rules.v1.json` | `2e5b0c4acafcfa49514cca0784e522e974fb76602af08f0d0f7a5b7125d3346b` |
| `evaluation/schemas/normalized_candidate.v1.json` | `fa2fb6962f2716411246f40e945444cc9066e8486369ec4ef4fea87f0b69fb8f` |
| `scripts/evaluation_output_adapter.py` | `4faf98da28b13a81cdbec85b87af2ecb5207407eb06fd98e001c85c6257efc37` |
| `scripts/prac_live_ensemble.py` | `71c68ec441b17cfc28070fb384beccd2c0607f1101d269011da4867e2ad55eda` |
| `skills/topstep-form-thesis/SKILL.md` | `195b6a312b63f2d70f9ef709d24acdbf6bf57b5e2418a51f21f9cfc2e5462bf3` |
| `skills/topstep-observe-market/SKILL.md` | `faba4f16792bfa5ccb8b29d129203a594c60bd015291a7cf7f4866ff8727da8c` |
| `skills/topstep-setup-state/SKILL.md` | `b4e404b9d2b956314d4fbb8cb2e4d2e8a1b3d472badbed35aea6ce0192eaa326` |
| `skills/topstep-assess-risk/SKILL.md` | `bebb236c8ec4cf26b20e7f7652704502676bfc684b14b5663e2d9aee26c17145` |
| `skills/orderflow-liquidity/SKILL.md` | `b3313d8c277cd1f1ebcf54a33f12f798f1ca22711ab6d05a92ef4b34aeb52454` |
| `skills/topstep-build-intent/SKILL.md` | `76e8e0e470f9c97ab8b4d4b668096070558d09457e4423643f893d98e672753d` |
| `skills/topstep-position-management/SKILL.md` | `8e625d923acdbec2285a1893472deb9289f819727ac73eff99e56334c97fcfef` |
| `skills/topstep-market-scan/SKILL.md` | `e3a7e8ec31677572fb6acc65787ca80ad59e790f2e7b60feeac5badb9ea11375` |
| gateway `src/domain/intents.ts` | `0a2580bd234fe6e78c7f56098e0c6b52f3e2e7f0f08465fae3145c29dbfea355` |

Commits: gateway `4943b3265bb83836867a6ff0f0d61296d3567e61`; profile `90fc2585b87a6c855350eadf9396afc615ee7265` (pai `435a64a40fd7e5c4285f2bef5c17ccf42c0ee0d7`).

## 3. Como o prompt é efetivamente montado (achado estrutural prévio a tudo mais)

Lido em `scripts/prac_live_ensemble.py::_invoke_hermes`: o payload enviado ao Hermes CLI (`hermes chat --source trading --max-turns 4 --skills <lista> -Q -q <prompt>`) contém apenas:

```json
{"instruction": "Return exactly one UTF-8 JSON object...", "envelope": <mesmo envelope para os 6 perfis>, "profile_id": "<id>", "skills": ["<skill-a>", "<skill-b>", ...], "output_contract": {...}}
```

`evaluation/capability-matrix.json` (que descreve `required_sources`, `forbidden_inference`, `horizon_bars`, `comparability` por perfil) **não é serializado no payload enviado ao Hermes** — é usado apenas do lado Python, pelo `capacity_gate`/`ensemble_capacity_overlay`, para calcular `comparability` e `capacity_gate_reason` **depois** da resposta do modelo. Isso significa que, para o modelo, a única diferenciação real entre os seis perfis, cycle a cycle, é: (a) a lista de `skills` carregada (que muda o conteúdo textual injetado via `SKILL.md`), e (b) a string `profile_id`. `SOUL.md` (constituição/identidade base) é presumivelmente carregada pelo Hermes para toda invocação `--source trading`, independente do perfil — isso explica a base de qualidade consistente entre os seis, mas também significa que **qualquer diferenciação analítica depende inteiramente do conjunto de skills**, não do capability-matrix.

## 4. Matriz de skills por perfil (diferenciação real)

| Perfil | Skills atribuídas (`registry.json`) | Especialidade declarada (`capability-matrix.json`) | Vocabulário da especialidade presente em algum SKILL.md atribuído? |
|---|---|---|---|
| `baseline-current` | observe-market, market-scan, assess-risk, form-thesis, build-intent, position-management | "Frozen production cognition reference" | N/A — é a referência completa |
| `structure` | observe-market, setup-state, form-thesis, build-intent | Trend, breakout, pullback, levels, swing structure | Parcial — `setup-state` dá framework CURRENT/BULLISH/BEARISH/NEXT genuinamente estrutural |
| `adversarial-risk` | assess-risk, form-thesis | Invalidation, missing evidence, late entry, geometry contest | Parcial — `assess-risk` é genuinamente focado em risco/geometria, mas não tem `observe-market` |
| `smart-money` | observe-market, setup-state, form-thesis | Liquidity pools, displacement, absorption, FVG, order blocks, sweeps | **Não.** Nenhum termo (FVG, order block, liquidity sweep, displacement, absorption, smart money) aparece em nenhum SKILL.md do repositório |
| `indicators` | observe-market, setup-state, form-thesis | VWAP, moving averages, ATR, momentum, RSI/MACD, divergences | **Não.** Nenhum termo (RSI, MACD, ATR, moving average, divergence) aparece em nenhum SKILL.md; "VWAP" aparece uma vez em `topstep-observe-market`, genérico para todos os perfis que o usam |
| `orderflow` | observe-market, orderflow-liquidity, form-thesis | Aggression, delta, depth, tape, liquidity | Sim — `orderflow-liquidity` é dedicado, com instrução própria ("never infer hidden liquidity") |

**Achado central (P1):** `smart-money` e `indicators` recebem exatamente o mesmo conjunto de skills (`observe-market` + `setup-state` + `form-thesis`) — texto de prompt **idêntico** entre os dois, diferenciado apenas pela string `profile_id`. Nenhum arquivo de skill ou `SOUL.md` ensina os dois vocabulários analíticos que o `capability-matrix.json` promete (SMC para `smart-money`; indicadores técnicos clássicos para `indicators`). A skill alvo do roadmap NT (`topstep-market-structure`, Wave 8) nunca foi criada — não existe `skills/topstep-market-structure/`.

**Confirmação empírica (não apenas arquitetural):** ver §6.

## 5. Achados por perfil

### `baseline-current`
Objetivo explícito ("Frozen production cognition reference; no challenger enrichments"), skill set completo (6 skills, inclui `build-intent` e `position-management`, únicas entre os 6 a receber ambas). Comportamento para estados canônicos: coberto amplamente por `topstep-form-thesis` (checklist obrigatório antes de `NOTHING`, calibração de confiança 0.70–0.85 vs 0.95+). Separação cognição/execução clara ("Glitch performs final monetary validation" em `assess-risk`). Compatível com políticas congeladas NT (breakeven/daily-capture descritos como gateway-owned em `position-management`). **Sem achados bloqueantes.**

### `structure`
Objetivo e skills coerentes com "trend, breakout, pullback, levels, swing structure" via `setup-state` (framework CURRENT/BULLISH/BEARISH/NEXT, revisão de gatilhos `HELD/FAILED/EXPIRED`). Recebe `build-intent` apesar de não ter autoridade de execução — redundante mas não perigoso (o schema completo do intent nunca é de fato usado pela via de entrega do ensemble, ver §8). **Achado menor:** inconsistência de design — por que `structure` recebe `build-intent` e os outros três challengers direcionais (`smart-money`, `indicators`, `orderflow`) não recebem, sem explicação documentada.

### `adversarial-risk`
Skills mínimas e propositalmente focadas (`assess-risk` + `form-thesis`), papel de "observer"/reviewer explícito em `role`. Notavelmente **não recebe `observe-market`** — mesmo assim, nas saídas reais observadas, o modelo ainda descreve estrutura de mercado detalhada (ver exemplo §6), sugerindo que a diferenciação por ausência de skill é mais fraca do que a arquitetura pressupõe (o modelo preenche a lacuna com conhecimento geral do envelope). `forbidden_inference` declarado ("implicit execution veto", "silent NOTHING substitution") não tem instrução textual espelhada em nenhum SKILL.md atribuído — mitigado parcialmente pelas regras gerais anti-invenção de `form-thesis`, mas não é uma cobertura 1:1.

### `smart-money`
**Achado P1 confirmado** (ver §4 e §6): vocabulário da especialidade ausente do prompt efetivo; saídas reais convergem para a mesma narrativa estrutural genérica dos demais perfis.

### `indicators`
**Achado P1 confirmado**, idêntico ao de `smart-money`: skill set idêntico, vocabulário técnico clássico (RSI/MACD/ATR/MA) ausente do prompt efetivo e das saídas reais observadas.

### `orderflow`
Melhor diferenciação real entre os quatro perfis "challenger": `orderflow-liquidity` é dedicada, curta e precisa ("never infer hidden liquidity or off-book size"; "This skill never emits an intent or blocks ENTER_*"). Saídas reais mostram vocabulário de tape genuinamente mais granular (janelas 15s/60s/300s, delta) que os outros perfis. **Sem achados bloqueantes.**

## 6. Achados sobre JSON, normalização e respostas — verificação campo a campo

- **Envelope de entrada:** idêntico (mesmo `envelope_hash`) para os 6 perfis em cada ciclo — confirmado nas duas auditorias anteriores (soak de 21 envelopes) e nesta.
- **Proveniência `thesis`/`reason` (`thesis_source`):** correta desde `90fc258…` — precedência `thesis` > `reason`, fail-closed para ausência/vazio/tipo inválido, `state`/`comparability` preservados no caminho comum. Já verificado por reexecução de teste na auditoria anterior; **confirmado agora também em invocação live real** (`PRAC-SMOKE-20260910-8e5c2a7f1d4b6e9c3a0f2b8d6e1c4a7f/live-run.json`, commit `90fc258…`): `indicators` e `structure` retornaram `thesis_source="reason"` com texto real preservado.
- **Novo dado observado nesta smoke (n=1 envelope, amostra pequena):** 4 dos 6 perfis (`adversarial-risk`, `baseline-current`, `orderflow`, `smart-money`) retornaram, nesta única invocação, saída **sem `thesis` nem `reason`** (`error_code="missing_explanation"`, fail-closed corretamente aplicado — nenhum default perigoso, nenhuma invenção). Isso é diferente do padrão do soak de 21 envelopes anterior (onde os mesmos 5 perfis não-`structure` emitiam `reason` de forma quase universal, 124/126). Com n=1 não é possível concluir se é ruído estatístico ou uma regressão de comportamento do modelo/CLI; **registrado como item que exige teste adicional (§10)**, não como defeito confirmado — o comportamento de normalização em si permaneceu correto (fail-closed, sem invenção).
- **Conversão `no_selection` → `global_nothing`:** confirmada 21/21 no soak estendido e 1/1 nesta smoke; `delivery.orders_sent=0`, `delivery_count=0` em 100% dos casos observados em toda a evidência disponível.
- **Rejeição fail-closed de payload incompleto:** confirmada por teste reexecutado (`test_empty_or_invalid_reason_is_fail_closed`, `test_both_explanations_absent_remain_missing_required_evidence`) e por observação live (ver acima).
- **Ausência de defaults perigosos / campos inventados:** confirmada — `entry`/`stop`/`target` nulos em 100% das 126+6 invocações observadas em todo o corpus disponível; nenhuma zona de preço hardcoded encontrada nas saídas brutas revisadas.
- **Estabilidade de tipos/enumerações:** `state` sempre um dos valores canônicos (`candidate`, `no_edge`, `missing_required_evidence`, `error`, `held`, `timeout`, `invalid`); nenhuma ocorrência de tipo inesperado nos 126 registros do soak nem nos 6 desta smoke.
- **Compatibilidade byte/schema com o gateway:** ver achado P0 dedicado em §8 — a via de normalização/candidato está correta, mas a via de **entrega ao gateway** (fora do escopo já auditado da normalização) tem uma lacuna de schema não relacionada ao fix de `thesis`/`reason`.
- **`global_nothing` justificado por evidência vs. defeito de prompt:** nas 21 decisões do soak estendido, os textos brutos de todos os 6 perfis convergem de forma consistente e coerente para "estrutura de alta-timeframe baixista, mas preço próximo de mínima/rebote de curto prazo, sem assimetria limitada de cinco minutos clara" — isto é, os perfis **concordam factualmente** sobre uma leitura de mercado ambígua/sem-edge, o que é uma convergência genuína sobre os fatos observáveis compartilhados (mesmo envelope), não um sintoma de defeito de prompt. O defeito de normalização (`missing_thesis`, corrigido em `90fc258…`) afetava apenas o campo textual `thesis`, não o campo `state`/`direction` usado pelo agregador (`comparability="comparable"` em 124/126 durante o soak com o bug) — portanto **as 21 decisões `global_nothing` daquele soak não foram causadas pelo defeito de normalização**; foram decisões de "sem edge suficiente" tomadas sobre dados de decisão íntegros, apenas com o texto explicativo perdido.

## 7. Exemplos sanitizados

**Bom (fail-closed correto, sem invenção)** — `evaluation_output_adapter.adapt_evaluation_output` para `raw={"state": "no_edge", "direction": "flat"}` (nem `thesis` nem `reason`): retorna `state="missing_required_evidence"`, `comparability="not_comparable"`, `error_code="missing_explanation"` — nunca sintetiza uma explicação, nunca promove a candidato.

**Bom (diferenciação genuína, perfil `orderflow`, soak estendido, envelope-008):** *"Downward structure is strong across 5m, 15m, and 60m, but price is pressing the local 5m and 60s lows near 29146.5–29150.75 while immediate tape is mixed: 15s delta is positive against falling price, 60s delta is mildly [...]"* — granularidade de janelas de tape (15s/60s) consistente com a skill dedicada `orderflow-liquidity`.

**Ruim (convergência artificial, perfis `smart-money` vs `indicators`, mesmo dia, envelopes distintos):**
- `smart-money` (env-009): *"Higher-timeframe bearish structure conflicts with an immediate 1m rebound; 5m and 15m remain below VWAP with declining EMA slopes, but tape is neutral/conflicted and depth is unavailable [...]"*
- `indicators` (env-009): *"Usable data supports a bearish higher-timeframe context, but the immediate auction is mixed: price is rebounding from the 5-minute range low, 1-minute momentum is positive, tape is near-neutral [...]"*

Mesmo ciclo, mesmo envelope, vocabulário e estrutura de frase quase intercambiáveis; nenhum dos dois cita um conceito da sua especialidade declarada (nem FVG/order-block para `smart-money`, nem RSI/MACD/ATR para `indicators`).

## 8. Problemas de prompt, schema ou agregação

### P0 — `decision_to_gateway_intent()` constrói um intent incompatível com o schema do gateway

Lido `scripts/prac_live_ensemble.py:364-390` (`decision_to_gateway_intent`) e `gateway/src/domain/intents.ts:7-37` (`CORE_FIELDS`) e a função `stringField()` (linha 69, lança `invalid_string_field` para qualquer campo ausente ou não-string).

O payload construído pelo runner do ensemble **não inclui** `intent_id`, `created_utc`, `model_version`, `prompt_version`, `scope_hash` nem `scope_generation` — todos listados em `CORE_FIELDS` no gateway, e pelo menos os quatro primeiros são explicitamente descritos como "Required core fields" no próprio `skills/topstep-build-intent/SKILL.md`. `git grep` confirma que `decision_to_gateway_intent` **não é referenciado por nenhum teste** em todo o repositório profile.

**Consequência:** se o ensemble algum dia produzir uma decisão `selected` e tentar entrega (`authorize=true`, modo `prac_live`), a primeira tentativa de POST `/intent` seria muito provavelmente rejeitada pelo gateway com `invalid_string_field` (ex.: `intent_id`) antes de qualquer risco de execução real — o fail-closed do lado do gateway provavelmente protege a conta, mas a entrega falharia de forma não testada e não observada em nenhuma evidência até agora, porque **nenhuma decisão `selected` jamais ocorreu** em todo o corpus de evidência revisado (soak de 21 envelopes, smokes anteriores, esta smoke). Isto não é um risco de segurança (o gateway deve rejeitar corretamente), mas é um **problema de prontidão de contrato não testado**, exatamente o tipo de lacuna que só apareceria na primeira sessão que produzisse um `selected`.

**Recomendação:** adicionar teste unitário chamando `decision_to_gateway_intent()` com um candidato `selected` sintético completo e validando o payload resultante contra `CORE_FIELDS`/`stringField` do gateway (ou um fixture espelho), **antes** de qualquer sessão live que possa produzir `selected`.

### P1 — Diferenciação de prompt fraca/ausente para `smart-money` e `indicators` (ver §4, §6, §7)

### P1 — Skill do roadmap `topstep-market-structure` (Wave 8) nunca foi criada; refatoração SOUL→skills incompleta
`docs/plans/2026-08-20-nt-adaptation-roadmap.md` Wave 8 lista `topstep-market-structure` como skill-alvo ("timeframe roles, location, auction state, continuation/reversal alternatives, and no indicator voting"); não existe em `skills/`. `SOUL.md` continua com 55 linhas densas cobrindo conteúdo que o roadmap pede para mover a skills — a decomposição está parcialmente feita (muitas skills já espelham parágrafos do SOUL), mas o exit gate "SOUL is materially shorter" não está demonstravelmente atingido sem uma versão histórica para comparar (lacuna registrada, não inferida).

### P2 — Inconsistência de atribuição de `topstep-build-intent`
`structure` recebe `build-intent`, os outros três challengers direcionais não — sem justificativa documentada no registry ou capability-matrix.

## 9. Riscos de comportamento

- **Excesso de trades:** baixo risco pelo texto do prompt — `form-thesis` e `SOUL.md` contêm múltiplas salvaguardas explícitas contra "manufacture a mid-range trade," contra reentrada mecânica pós-stop, e a calibração de confiança para `NOTHING` (0.70–0.85 vs 0.95+) desencoraja abstenção preguiçosa sem recompensar entrada forçada.
- **Viés direcional:** não identificado nos textos revisados — os prompts pedem explicitamente avaliação simétrica long/short/flat em múltiplos pontos (`form-thesis` checklist, `SOUL.md` "symmetric flat/positioned evaluation").
- **Falsa precisão:** mitigada — `aggregator_rules.v1.json` documenta explicitamente "Does not use raw LLM confidence," alinhado ao stop-line do roadmap NT (Wave 6: "No minimum confidence gate"). `decision_scores` opcional é marcado como "cognitive only," removido antes da entrega ao gateway.
- **`NOTHING` excessivo por conservadorismo em vez de evidência:** avaliado no soak de 21 ciclos — convergência factual real entre perfis (§6), não um padrão de recusa vazia; texto de `decision_audit`/`reason` mostra raciocínio específico por ciclo (níveis de preço, EMAs, VWAP, delta), não texto padronizado repetido.
- **Convergência artificial entre perfis:** **risco confirmado** para `smart-money`/`indicators` (P1, §4/§6/§7) — 2 dos 6 "pontos de vista" do ensemble não são, na prática, pontos de vista distintos.
- **Seleção inconsistente:** não observável — zero decisões `selected` em toda a evidência disponível.

## 10. Itens que exigem teste adicional

1. Teste de contrato para `decision_to_gateway_intent()` cobrindo todos os `CORE_FIELDS` do gateway antes de qualquer smoke que possa produzir `selected` (P0, ver §8).
2. Amostra maior (múltiplos envelopes/ciclos) do padrão "sem `thesis` nem `reason`" observado 4/6 vezes nesta smoke de 1 envelope, para determinar se é ruído de amostra pequena ou uma mudança real de comportamento do Hermes/CLI pós-fix.
3. Uma bateria comparativa dedicada (mesmo envelope, mesmo timestamp) checando se `smart-money` e `indicators`, quando explicitamente instruídos com vocabulário de especialidade (teste A/B de skill), produzem análises materialmente diferentes — isso confirmaria se o problema é a ausência de skill dedicada (corrigível) ou uma limitação mais profunda do modelo.
4. Fixture pareado profile↔gateway para o schema `glitch.intent.v3` completo, incluindo os campos hoje ausentes, para fechar a lacuna do achado P0.

## 11. Limites da evidência atual

Conforme instruído explicitamente pela tarefa:

- O soak e os smokes disponíveis produziram **21 + 1 decisões `global_nothing` e zero decisões `selected`**. É possível avaliar qualidade de abstenção, schema, consistência e cobertura de dados — **não é possível** concluir qualidade de entrada, stop, target, fill, ou gestão de posição.
- **Não é possível concluir eficácia financeira** da estratégia nem segurança do caminho de execução sob exposição real — nenhuma ordem, fill, flatten ou recovery foi exercitada em nenhuma evidência revisada até o momento.
- Ausência de ordens **não** é tratada aqui como prova de qualidade estratégica — é tratada apenas como evidência de que o caminho de abstenção/segurança funciona como projetado.
- Não foi localizado, dentro do repositório, um snapshot datado e congelado do "prompt único anterior" pré-decomposição em skills; a comparação usa o estado atual de `SOUL.md`/`operator.json` como melhor referência disponível, com a lacuna registrada explicitamente (§1) em vez de presumida como equivalente.
- O achado P0 de §8 é **estático** (leitura de código nos dois lados do contrato), não uma falha observada em produção — nenhuma tentativa de entrega `selected` ocorreu para confirmá-lo empiricamente, e nenhuma foi provocada por este auditor (proibido pelo escopo).

## 12. Decisão sobre prontidão cognitiva

A camada cognitiva de **abstenção/comparação** (formação de tese, checklist anti-`NOTHING` preguiçoso, separação cognição/execução, fail-closed na normalização, ausência de gate por confiança bruta, conversão correta `no_selection`→`global_nothing`) está bem fundamentada, documentada, testada onde importa, e alinhada com as políticas congeladas do Glitch NT (daily-capture, breakeven intent-free). Isso sustenta `prompt_quality_pass_with_findings`.

Dois problemas concretos impedem uma classificação mais forte ou qualquer recomendação de avanço: (1) a diversidade real do ensemble é mais estreita do que a documentação declara — 2 dos 6 perfis carecem de diferenciação textual e empírica; e (2) o caminho de entrega ao gateway para uma decisão `selected` tem uma lacuna de schema concreta e nunca testada que provavelmente falharia na primeira tentativa real. Nenhum dos dois é uma falha de segurança observada — mas ambos são lacunas de prontidão que um humano deveria revisar e resolver antes de qualquer smoke ou soak desenhado para produzir (ou correr o risco de produzir) uma decisão `selected`.

**Esta auditoria não recomenda promoção `armed` com base nestes achados — nem foi solicitada a fazê-lo.**

---

*Relatório gerado por auditoria independente, somente leitura. Nenhum gateway, Hermes, runner, PRAC, soak ou ordem foi iniciado. Nenhum código, prompt, schema ou evidência foi alterado. Nenhuma credencial ou conteúdo de `.env` foi lido, copiado ou registrado.*
