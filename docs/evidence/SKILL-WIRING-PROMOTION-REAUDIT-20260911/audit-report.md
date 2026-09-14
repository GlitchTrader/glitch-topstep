# Reauditoria independente — wiring de skills, especialização e prontidão para promoção

- Auditor: sessão Claude Code independente, somente leitura, worktree `prac-extended-soak-audit-b69a3a`
- Data: 2026-09-11
- Evidência declarada: `docs/evidence/PRAC-SKILL-WIRING-FIX-20260911/` (`REPORT.md`, `decision.json`, `post-wiring-specialty-smoke.json`, `post-wiring-frozen-envelope.json`, `run_post_wiring_smoke.py`, `smoke-log.txt`)
- Nenhum gateway armado, Hermes de produção, PRAC, overnight, canary, paper armado, sizing ou ordem foi iniciado por esta auditoria. As únicas chamadas "ao vivo" realizadas foram ao **preload de skills do Hermes** (API informativa, sem trade) para reverificar o wiring — a mesma classe de chamada que a própria evidência já fazia. Nenhum código/prompt/skill/contrato/ledger/evidência foi alterado. Nenhuma credencial/`.env` foi lida.

---

## Nota preliminar importante

A "afirmação do programador" resumida na tarefa é **mais otimista do que o próprio `REPORT.md`/`decision.json` que ela cita**. O documento original já classifica o resultado como `capability_present_but_unproven` / `shadow-only`, e diz explicitamente: *"saídas do modelo neste smoke ainda são majoritariamente thin/no_edge — não basta para promoção."* Esta reauditoria confirma essa classificação cautelosa e, em alguns pontos, encontra evidência **mais forte contra a promoção** do que a própria evidência original relatou.

## 1. Classificação final do wiring

**Wiring mecânico: verificado e correto, na cadeia realmente usada em runtime — com uma ressalva séria de governança de checkout (ver §5 e §7).**

- Reconstituí a cadeia completa `registry → evaluation/profiles/* → skills/ → runner → Hermes preload → prompt efetivo` usando o checkout que o próprio runner realmente importa (`.runner-implementation-20260910/profile`, doravante **RUNNER**).
- `scripts/prac_live_ensemble.py::_invoke_hermes` (a função real, chamada em toda invocação ao vivo) chama `assert_declared_skills_ready(...)` **antes** de montar/enviar qualquer prompt, e converte `SkillPreloadError` em `RunnerError` — reexecutei isso diretamente: com uma skill falsa/inexistente, `_invoke_hermes` falha em **16 ms**, antes de qualquer chamada de subprocesso ao modelo (as chamadas reais de modelo levam 10 000–25 000 ms, confirmado nos `latency_ms` do smoke). **Confirma que o fail-closed ocorre no caminho real de invocação, não apenas em teste isolado.**
- `HERMES_HOME` é forçado para `default_glitch_topstep_hermes_home()` (`%LOCALAPPDATA%\hermes\profiles\glitch-topstep`) em toda invocação — confirmado por leitura de código e pela evidência do smoke.
- Reexecutei diretamente, contra RUNNER (não contra a evidência fornecida): `assert_declared_skills_ready` para `smart-money` e `indicators` — ambos carregam com sucesso via a API real de preload do Hermes, com os 4 marcadores de cada especialidade presentes (`fair-value gaps`, `order blocks`, `liquidity`, `displacement` para smart-money; `rsi`, `macd`, `atr`, `indicator` para indicators). Reexecutei também o caso de falha (skill inexistente) — corretamente lança `SkillPreloadError`.
- **`markers substantivos presentes no prompt efetivo`: confirmado** — mas apenas no **texto de entrada** (o preload monta ~18 300 caracteres de prompt cujo hash é registrado; os termos aparecem lá). Isso é uma prova de que a skill chega ao modelo, não de que o modelo a usa (ver §2).

## 2. Classificação final de especialização dos dois perfis

**`capability_present_but_unproven` confirmado — e a evidência real disponível pesa contra, não a favor, de uma promoção futura sem mais dados.**

Li integralmente as 8 respostas brutas reais capturadas em `post-wiring-specialty-smoke.json` (2 de `smart-money`, 6 de `indicators`, todas invocações reais do Hermes, não fixtures sintéticas):

| Perfil | Tentativa | Conteúdo | Vocabulário de especialidade usado? |
|---|---|---|---|
| smart-money | 1/2 | `{"state":"no_edge","direction":"flat"}` (sem texto) | Não — sem texto algum |
| smart-money | 2/2 | `{"state":"no_edge","direction":"flat"}` (sem texto) | Não — sem texto algum |
| indicators | 1/6 | mínimo, sem texto | Não |
| indicators | 2/6 | `reason` rico ("sharp downside displacement below VWAP and short EMAs"...) | **Não** — "displacement" aqui é uso genérico de língua inglesa ("movimento brusco"), não o conceito SMC; e mesmo assim, **este é o output de `indicators`, não de `smart-money`** |
| indicators | 3/6 | mínimo, sem texto | Não |
| indicators | 4/6 | `thesis`/`bull_case`/`bear_case`/`flat_case`/`missing_evidence`/`change_condition` completos e ricos | **Não** — menciona VWAP, EMAs, estrutura, delta, mas **nenhuma vez** RSI, MACD, ATR, divergência ou médias móveis |
| indicators | 5/6 | mínimo, sem texto | Não |
| indicators | 6/6 | mínimo, sem texto | Não |

Busquei programaticamente todo o arquivo de evidência por `RSI`, `MACD`, `ATR`, `FVG`, `order block`, `liquidity sweep`, `displacement`, `absorption`, `fair value gap`, `divergence`, `moving average`. **Toda ocorrência fora da seção `preload.specialty_markers` (que é meta-dado sobre o prompt de entrada, não saída do modelo) vem do texto acima e não usa o vocabulário de especialidade de forma substantiva.** Em particular, `indicators` teve sua única chance real e rica de citar um indicador nomeado (tentativa 4/6, resposta completa e elaborada) e **não citou nenhum**; `smart-money` nunca produziu texto algum nas suas 2 únicas execuções reais.

**Conclusão, mais precisa que a do relatório original:** o wiring de entrada está correto (a skill chega ao modelo), mas **não há, na única amostra real disponível, nenhuma evidência de que o modelo de fato usa o vocabulário de especialização em sua saída** — nem nos casos em que produziu texto rico. Isso não prova que a especialização "não funciona"; prova que **ainda não foi demonstrada**, e que a única tentativa rica disponível para `indicators` pesa contra, não a favor.

**Limite de amostra explícito:** n=2 para `smart-money`, n=6 para `indicators`, um único envelope, um único momento de mercado. Não é possível, com esta amostra, distinguir "a skill não influencia a saída" de "o envelope não continha evidência que justificasse um sinal de FVG/RSI desta vez."

## 3. Estabilidade intra-perfil

**`indicators`: gate `pass`, mas de forma trivial — não deve ser lido como validação forte.**

O gate `specialty_intra_profile_stability.v1` (`post-wiring-specialty-smoke.json`, reproduzido e recomputado nesta auditoria a partir do `state_histogram` bruto) passa porque as 6 execuções de `indicators` retornaram `state=no_edge` em 100% dos casos (`mode_share=1.0`), sem nenhuma alternância `no_edge → candidate`. **Isso é estabilidade da abstenção, não estabilidade de um sinal substantivo** — nunca houve um `candidate` nas 6 execuções para verificar se ele se repetiria. `smart-money` não teve gate de estabilidade avaliado (`"result": "n/a_control"`, n=2, deliberadamente rotulado como controle, não como medição).

**Critério de estabilidade usado pela evidência original:** `mode_share >= 5/6` E ausência de alternância `candidate`/`no_edge`. Este critério nunca foi exercitado sob um caso onde `candidate` realmente ocorreu — portanto **não está provado que a divergência anterior `no_edge → candidate` foi resolvida; está apenas provado que ela não apareceu de novo nesta amostra pequena**, exatamente a ressalva que a tarefa pediu para não deixar passar. Nenhum timeout, erro ou instabilidade foi convertido em `NOTHING` silencioso nesta amostra — confirmado, os 2 `err: null` registrados em cada linha do `smoke-log.txt` mostram que todas as 8 tentativas completaram sem erro de processo.

**Número de reexecuções:** 8 no total (2+6), todas em um único envelope (`post-wiring-frozen-envelope.json`, mesmo `envelope_hash` para os dois perfis — confirmado por leitura direta do arquivo). Não realizei novas reexecuções ao vivo nesta auditoria (proibido pelo escopo — chamar o Hermes real repetidamente para gerar mais amostra seria além de "reverificar wiring" e entraria em território de execução ativa não solicitada); a limitação de amostra é, portanto, herdada da evidência original e permanece não resolvida.

## 4. Decisão sobre `prompt_version`

**Recomendação: deveria ter havido bump de `prompt_version` (por exemplo, para `glitch-topstep-v17.2`). Manter `v17.1` cria risco real de falsa equivalência em replay futuro.**

Raciocínio, baseado no contrato e no histórico real do repositório:

- O histórico de `SOUL.md` (auditado ontem, `git log --follow`) mostra que praticamente toda mudança de conteúdo cognitivo substantivo ao longo do projeto foi acompanhada de um bump de `prompt_version` nomeado (`v6` até `v17.1`, ~15 commits com nomes como `feat(prompt-vX): ...`). A adição de duas skills inteiramente novas (`topstep-smart-money`, `topstep-indicators`), que mudam o conteúdo real enviado ao modelo para dois dos seis perfis, é exatamente o tipo de mudança que historicamente disparava um bump.
- `paired-contract.json`/`scripts/paired_contract.py` usa `prompt_version` como **chave de compatibilidade/segurança** (`decision_to_gateway_intent` rejeita com `prompt_version_mismatch` se divergir) — seu propósito imediato é integridade de contrato, não rastreabilidade de conteúdo. Manter `v17.1` **não quebra** essa checagem de compatibilidade (o wire contract `glitch.intent.v3` de fato não mudou).
- Mas **replay/auditoria futura usa `prompt_version` como identificador de "qual prompt gerou esta decisão."** Duas decisões rotuladas `glitch-topstep-v17.1` — uma de antes de hoje (sem `topstep-smart-money`/`topstep-indicators`) e uma de depois — **não são geradas pelo mesmo prompt efetivo para os perfis `smart-money`/`indicators`**, mas carregam o mesmo identificador. Isso é exatamente a "falsa equivalência" que a tarefa pede para investigar, e ela **existe** neste caso específico.
- **Recomendação prática:** introduzir uma granularidade adicional (por exemplo, um campo `skill_set_version` por perfil, ou um bump de `prompt_version` restrito aos dois perfis afetados) antes que qualquer replay ou auditoria de atribuição de causa precise diferenciar saídas de antes/depois desta mudança.

## 5. Confirmação do profile/`HERMES_HOME` efetivamente auditado

**Esta é a seção com o achado mais sério desta reauditoria.**

Existem hoje **três** localizações relevantes, e a evidência original rotula uma delas de forma enganosa:

| Local | Papel na evidência | HEAD git | Estado |
|---|---|---|---|
| `C:\Users\arifr\Projects\glitch-topstep-hermes-profile` | Rotulado `CANON` no script `run_post_wiring_smoke.py`; usado **apenas** para comparar hashes de `SKILL.md` | `a1ac0f5bef81a15a0693241e732d1c33abb8e361` | **8 commits atrás** da cadeia de correções já auditada (antecede até a criação de `prac_live_ensemble.py`, que **não existe neste checkout**); tem mudanças não commitadas nos mesmos arquivos que a evidência descreve como "corrigidos" (`registry.json`, `capability-matrix.json`, `evaluation/profiles/*.v1.json`, `SHA256SUMS`, `scripts/ensemble_aggregator.py`) |
| `C:\Users\arifr\Projects\glitch-topstep\.runner-implementation-20260910\profile` (**RUNNER**) | Onde `run_post_wiring_smoke.py` de fato importa e executa (`sys.path.insert(0, str(RUNNER / "scripts"))`); onde os 8 invocações reais do Hermes aconteceram | `81af2b8b1e367c01d9380b85824a0cf116b9cba2` (commitado) | HEAD limpo e correto; **porém** tem mudanças locais não commitadas de hoje (`scripts/prac_live_ensemble.py`, `evaluation/registry.json`, `evaluation/capability-matrix.json`, novo `scripts/ensemble_skill_gate.py` não rastreado) |
| `%LOCALAPPDATA%\hermes\profiles\glitch-topstep` | `HERMES_HOME` live real, usado pelo Hermes CLI | N/A (não é repo git) | Confirmado com os mesmos hashes de `SKILL.md` que RUNNER (verificado nesta auditoria) |

**`ensemble_aggregator.py` e `evaluation/capability-matrix.json` diferem entre CANON e RUNNER neste momento** (`diff` direto, não apenas comparação de commit). `registry.json` está, por coincidência de cópia manual, idêntico nos dois. **`prac_live_ensemble.py` não existe em CANON.**

O único conjunto de "7 testes de wiring" (`tests/test_specialty_skill_wiring.py`, que citei como "7/7") **existe fisicamente apenas em CANON**, não em RUNNER — reexecutei-o diretamente de CANON (7/7 `ok`, confirmado), mas ele testa os arquivos de skill **de CANON**, não o caminho de invocação real de `prac_live_ensemble.py` (que não está presente ali para ser testado). Para cobrir essa lacuna, reexecutei manualmente o equivalente contra **RUNNER** (§1) e confirmei que o comportamento é o mesmo — mas isso exigiu trabalho adicional desta auditoria; **não está garantido por nenhuma suíte de teste automatizada existente hoje**, porque `python -m unittest discover` a partir de RUNNER (729 testes) não inclui `test_specialty_skill_wiring.py`.

**O campo `"gateway_sha": "51cd6c9b1e5872166f5c74ade898ca2ae6833458"` em `post-wiring-specialty-smoke.json` está incorreto/mal rotulado.** Esse hash é, na verdade, o HEAD do **repositório principal** `glitch-topstep` (o meta-repositório que contém toda a árvore, incluindo `docs/evidence/`), não do checkout operacional do gateway. O gateway operacional real (`.prac-operational-20260910/gateway`) permanece, sem alteração, em `4943b3265bb83836867a6ff0f0d61296d3567e61` — o mesmo commit auditado e validado ontem (confirmei que `4943b326…` é ancestral do HEAD atual do repositório principal, ou seja, não há divergência real de código, apenas um rótulo de campo errado na evidência).

**Confirmação direta ao pedido do item 1 da tarefa:** a auditoria de fato examinou o checkout **RUNNER**, que é comprovadamente o mesmo usado pelo smoke (mesmo `sys.path`, mesmos hashes de skill reportados no próprio `post-wiring-specialty-smoke.json` como `specialty_skill_sha256_runner`, que bati contra o arquivo real em disco). **CANON, apesar do nome, não deveria ser tratado como fonte de verdade neste momento** — está desatualizado, incompleto e com edições não commitadas paralelas e divergentes das de RUNNER em pelo menos dois arquivos centrais (`ensemble_aggregator.py`, `capability-matrix.json`).

## 6. Status da capacidade multimercado

**Confirmado, inalterado desde ontem: `replay/fixture only`, nunca live-proven — mas com cobertura de fixture significativamente melhorada hoje, ainda não integrada de forma segura.**

- O ensemble continua recebendo **um instrumento por envelope**; não é, por si só, o ranking multimercado global — reconfirmado por leitura de `ensemble_envelope.py` (inalterado desde ontem) e por ausência total de `market_universe` no código do ensemble.
- O ranking pertence exclusivamente ao scanner do operador único (`scanner_contract.py`/`run-topstep-cycle.py`) — inalterado desde ontem no que toca a esse papel.
- **Novidade descoberta nesta auditoria, não mencionada na evidência declarada `PRAC-SKILL-WIRING-FIX-20260911`:** existe hoje, em CANON (não commitado, não presente em RUNNER), um novo módulo de teste `tests/test_winning_multimarket_selection.py` com **9 testes**, todos passando quando reexecutados por mim agora, incluindo `test_winning_selection_matrix_mnq_mes_mcl` (com fixtures reais de MNQ, MES **e** MCL cada um vencendo o ranking em seu próprio cenário — `SELECTION_INSTRUMENT=MES`/`MCL` finalmente exercitados, o item que eu havia recomendado como prioridade máxima na auditoria de ontem), além de `test_instrument_divergence_fails_closed`, `test_contract_divergence_fails_closed`, `test_expired_packet_rejects_handoff_via_lease`, `test_missing_evidence_fails_closed`, e um teste explicitamente rotulado `test_deterministic_scanner_to_handoff_replay_flow` com docstring *"Replay/fixture only: scanner → ranking → selected → envelope identity → handoff."*
- **Isto é um avanço real e bem-vindo**, mas com duas ressalvas sérias: (1) está **fora de RUNNER e não commitado** — corre risco real de ser perdido ou nunca integrado; (2) o próprio autor do teste rotula corretamente como "replay/fixture only" — **não constitui evidência live**, e esta auditoria não trata como tal, conforme instruído.
- **Não há evidência live fora de MNQ.** Nenhuma sessão PRAC real, em qualquer evidência disponível até hoje, envolveu MES ou MCL/MCLE. `docs/ledger/ledger.json` (item `TS-MULTI-01`) continua registrando: *"Live MCL armed trade outcome remains unknown."*
- **Não há fallback silencioso para MNQ** — reconfirmado: `validate_comparison_ledger` (`scanner_contract.py`) aceita qualquer instrumento presente no `ranking`, sem preferência hardcoded por MNQ; a nova suíte de testes prova isso ativamente ao validar MES e MCL vencendo.
- Os novos testes de seleção vencedora **realmente validam identidade, contrato, geração, lease e handoff** — `test_instrument_divergence_fails_closed`, `test_contract_divergence_fails_closed`, `test_expired_packet_rejects_handoff_via_lease` cobrem exatamente essas quatro dimensões, além do `test_deterministic_scanner_to_handoff_replay_flow` que percorre a cadeia completa scanner→ranking→seleção→identidade de envelope→handoff.

**Classificação mantida: `replay/fixture-proven`, não `live-proven`, para MNQ, MES e MCL/MCLE igualmente — exatamente como a tarefa pede que permaneça, mesmo com a cobertura de fixture agora mais completa.**

## 7. Discrepâncias entre código, preload, smoke e evidências

| # | Discrepância | Gravidade |
|---|---|---|
| 1 | `CANON` (rotulado assim no script) está 8 commits atrás e sem `prac_live_ensemble.py`; tem edições não commitadas paralelas às de RUNNER em `ensemble_aggregator.py` e `capability-matrix.json` que **diferem** das de RUNNER | **Alta** — risco de confusão sobre qual código é "a verdade"; risco de perda de trabalho se CANON for resetado |
| 2 | `"gateway_sha"` no `post-wiring-specialty-smoke.json` é na verdade o HEAD do repositório principal, não do checkout operacional do gateway | Média — rótulo de campo incorreto, mas não há divergência real de código por trás dele |
| 3 | Suíte "7/7" de wiring existe apenas em CANON, não em RUNNER; `python -m unittest discover` a partir de RUNNER (729 testes) não a inclui | Média-alta — cobertura de regressão real não está garantida para o checkout que efetivamente roda em produção |
| 4 | `npm run check` do gateway: esta auditoria obteve **657 passaram / 658 total / 0 falhas / 1 skip**, idêntico a ontem; a tarefa cita "**667 testes**" — não bate com o que reexecutei no checkout operacional pinado | Baixa-média — pode refletir execução contra um checkout gateway diferente (o repositório principal avançou com PRs #283–#285 não relacionados, que provavelmente adicionam testes); não investigado a fundo pois está fora do escopo de mudanças auditadas aqui |
| 5 | `smart-money` teve apenas 2 execuções e nenhum gate de estabilidade real avaliado (`n/a_control`), mas a linguagem da tarefa ("a estabilidade foi classificada como pass") implica uma validação mais ampla do que a que de fato ocorreu | Média — mais um problema de como a evidência foi resumida do que do conteúdo da evidência em si (que já era honesto sobre isso) |
| 6 | `prompt_version` não foi incrementado apesar de mudança substantiva de conteúdo cognitivo (§4) | Média — risco de atribuição incorreta em replay futuro, não um risco de segurança imediato |
| 7 | `SHA256SUMS`/frozen-cohort: mesma lista de 8 arquivos divergentes de ontem, ainda não regenerada, apesar de duas rodadas de correções desde então | Baixa — já era um item de recomendação pendente, permanece pendente |

## 8. Testes reexecutados nesta auditoria (resultado real, não apenas confiança no relatório)

| Teste/verificação | Local | Resultado |
|---|---|---|
| `tests.test_specialty_skill_wiring` (7 testes) | CANON | **7/7 `ok`**, reexecutado agora |
| `assert_declared_skills_ready` para `smart-money`/`indicators` | RUNNER (manual, equivalente ao acima) | Ambos carregam com sucesso; 4/4 marcadores presentes em cada |
| Fail-closed com skill inexistente (`ensure_skill_files_exist`) | RUNNER | Corretamente lança `SkillPreloadError` |
| Fail-closed no caminho real (`_invoke_hermes` com skill falsa) | RUNNER | Corretamente lança `RunnerError` em 16 ms, antes de qualquer chamada de modelo |
| Suíte completa `python -m unittest discover` | RUNNER | **729 testes, 2 falhas, 10 skips** — as 2 falhas são as mesmas de ontem (`SHA256SUMS`/frozen-cohort), causa já rastreada e inalterada |
| `tests.test_winning_multimarket_selection` (9 testes, novo, não mencionado na evidência declarada) | CANON | **9/9 `ok`**, reexecutado agora, descoberto por esta auditoria |
| `npm run check` (gateway) | `.prac-operational-20260910/gateway` | **657 passaram / 658 total / 0 falhas / 1 skip conhecido** |
| Paridade de hashes de skill canon/runner/live | RUNNER + CANON + live | `topstep-smart-money`/`topstep-indicators` SKILL.md idênticos nos três locais (confirmado por leitura direta, não apenas pelo campo do smoke) |
| Validação de contrato pareado (`paired-contract.json`/`paired_contract.py`) | RUNNER | `PROMPT_VERSION` carregado corretamente de `paired-contract.json`, continua `glitch-topstep-v17.1`; nenhuma mudança de wire contract detectada |
| Fixtures de seleção MNQ/MES/MCL, instrumento ausente, divergência, stale, timeout | CANON (novo) | Cobertos pela suíte de 9 testes acima, todos verdes |
| `global_nothing` | RUNNER + evidência | Reconfirmado: `orders_sent=0` em toda a evidência; `authorized=False` no smoke |

## 9. Limitações de amostra

- Apenas 8 invocações reais do modelo em toda a evidência de especialização (2 + 6), em um único envelope, um único momento de mercado — insuficiente para provar ou refutar especialização de forma estatisticamente robusta; suficiente apenas para registrar que, **nesta amostra**, a especialização não apareceu na saída.
- O gate de estabilidade nunca foi exercitado sob um caso real de `candidate` — permanece formalmente não comprovado para o cenário que mais importa.
- Não realizei novas chamadas ao vivo ao Hermes além das já necessárias para reverificar o wiring de skills (uma operação informativa, não geradora de decisão) — não gerei nova amostra de saída de modelo, por estar fora do escopo autorizado desta reauditoria.
- A investigação da discrepância de contagem do `npm run check` (657 vs. 667 citados) não foi aprofundada além de constatar que o repositório principal avançou com commits não relacionados (#283–#285); não foi possível, dentro do escopo somente-leitura, determinar com certeza qual checkout gerou o número "667".
- CANON e RUNNER divergem em arquivos centrais (`ensemble_aggregator.py`, `capability-matrix.json`) sem que eu tenha auditado linha-a-linha o conteúdo específico dessa divergência (fora do escopo desta tarefa, que pediu revalidação de wiring/especialização/estabilidade/versionamento, não uma nova auditoria completa do agregador) — registrado como discrepância a resolver, não como defeito caracterizado.

## 10. Recomendação final

**`shadow-only`** (mantendo a recomendação operacional da evidência original) **+ `needs-human-review`** (para a governança de checkout, ver §5 e §7).

**`canary-ready` não é justificável agora.** O próprio critério que a tarefa define para considerar promoção — *"o wiring canônico, o prompt efetivo, a especialização real, a estabilidade e o versionamento forem comprovados independentemente"* — não está satisfeito: o wiring está correto no checkout operante mas o checkout rotulado "canônico" está desatualizado e divergente; a especialização real **não apareceu em nenhuma das 8 saídas reais disponíveis**; a estabilidade medida é trivial (100% abstenção idêntica, nunca testada sob sinal real); e o versionamento (`prompt_version`) não reflete a mudança de conteúdo. A capacidade multimercado continua corretamente classificada como replay/fixture-proven, não live, para MNQ, MES e MCL/MCLE igualmente, como a tarefa exige.

Antes de qualquer novo passo em direção a canário: (1) resolver a divergência CANON/RUNNER — decidir qual é de fato a fonte de verdade, commitar as mudanças pendentes em um único checkout git real, e re-etiquetar ou aposentar o outro; (2) mover/commitar `test_specialty_skill_wiring.py` e `test_winning_multimarket_selection.py` para RUNNER, de forma que rodem como parte da suíte padrão; (3) obter uma amostra maior (múltiplos envelopes/momentos de mercado) de saídas reais de `smart-money`/`indicators` antes de declarar especialização demonstrada; (4) decidir e aplicar o bump de `prompt_version` (§4); (5) regenerar `SHA256SUMS`/frozen-cohort.

---

*Relatório gerado por reauditoria independente, somente leitura. Nenhum chain-of-thought privado da LLM foi solicitado. Nenhum gateway armado, Hermes de produção, PRAC, overnight, canary, paper armado, sizing ou ordem foi iniciado. Nenhum código, prompt, skill, contrato, ledger ou evidência foi alterado. Nenhuma credencial ou conteúdo de `.env` foi lido, copiado ou registrado.*
