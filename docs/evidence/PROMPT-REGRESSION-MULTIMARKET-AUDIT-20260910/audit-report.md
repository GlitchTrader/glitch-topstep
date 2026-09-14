# Auditoria independente — regressão de prompt e avaliação multimercado

- Auditor: sessão Claude Code independente, somente leitura, worktree `prac-extended-soak-audit-b69a3a`
- Data: 2026-09-10
- Repositórios examinados: `glitch-topstep` (gateway, checkout `.prac-operational-20260910/gateway`, HEAD `4943b3265bb83836867a6ff0f0d61296d3567e61`) e `glitch-topstep-hermes-profile` (profile, checkout `.runner-implementation-20260910/profile`, HEAD `81af2b8b1e367c01d9380b85824a0cf116b9cba2`)
- Referências obrigatórias lidas: `docs/plans/2026-08-20-nt-adaptation-roadmap.md`, `docs/plans/2026-08-25-complete-audit-implementation-plan.md`, `docs/ledger/ledger.json` (63 itens), `C:\Users\arifr\Downloads\2026-09-01-hermes-ensemble-implementation-plan.md` (589 linhas), mais quatro auditorias anteriores deste mesmo dia já publicadas em `docs/evidence/` (`PRAC-EXTENDED-AUDIT-20260910-...`, `NORMALIZATION-REPAIR-AUDIT-20260910`, `LLM-PROMPT-QUALITY-AUDIT-20260910`, `COGNITION-DECISION-AUDIT-20260910`, `COGNITION-AGGREGATION-CONTRACT-REPAIR-AUDIT-20260910`).
- Nenhum gateway, Hermes, PRAC, soak, paper, canary ou ordem foi iniciado. Nenhuma credencial/`.env` foi lida. Nenhum código/prompt/schema/ledger/evidência foi alterado.

---

## 1. Veredito executivo

| Dimensão | Classificação | Base |
|---|---|---|
| Qualidade do prompt (SOUL.md + skills, como conjunto) | `pass_with_findings` | Ver §3; crescimento histórico líquido, um "trim" bem executado, dois gaps já corrigidos hoje |
| Diversidade cognitiva entre os seis perfis | `pass_with_findings` | Ver §3.4; diferenciação real hoje (pós-reparo `7b073177`), mas dependente de commit muito recente |
| Avaliação multimercado (capacidade do **ensemble** de 6 perfis) | `capability_present_but_unproven` — na verdade **nunca existiu no ensemble**, não é uma regressão dele | Ver §4 |
| Avaliação multimercado (capacidade do **operador único**, `run-topstep-cycle.py`) | `capability_present_but_unproven` para seleção vencedora não-MNQ; `pass` para o contrato/ledger em si | Ver §4 |
| Agregação (determinismo, gates, veto) | `pass_with_findings` | Já auditado e corrigido hoje em `COGNITION-DECISION-AUDIT-20260910` + `COGNITION-AGGREGATION-CONTRACT-REPAIR-AUDIT-20260910`; reconfirmado aqui por referência, não re-testado |
| Contrato de entrega (`glitch.intent.v3`) | `pass_with_findings` | Corrigido e validado contra o parser real do gateway hoje; nunca exercitado ao vivo |
| Cobertura de execução real | `blocked_by_missing_evidence` | Zero decisões `selected`, zero ordens, zero seleção multimercado, em toda a evidência disponível, em qualquer commit |
| Estado geral | `needs-human-review` | Antes de qualquer smoke, um humano deve decidir se a lacuna multimercado do ensemble (§4) é aceitável para o próximo passo ou se precisa ser fechada primeiro |

**Não há evidência de que a suspeita 1 (qualidade de prompt reduzida pela decomposição) seja verdadeira como regressão líquida.** Houve, sim, dois defeitos concretos introduzidos pelo próprio projeto de ensemble mais cedo hoje (perfis `smart-money`/`indicators` sem vocabulário próprio; campos de proveniência do intent ausentes) — **mas ambos já foram corrigidos e reverificados por este auditor antes desta sessão**, com testes contrafactuais e reprodução direta (ver `COGNITION-DECISION-AUDIT-20260910` e `COGNITION-AGGREGATION-CONTRACT-REPAIR-AUDIT-20260910`). Não encontrei conteúdo cognitivo real removido de `SOUL.md` sem ter sido preservado em uma skill.

**A suspeita 2 (capacidade multimercado perdida) está parcialmente correta, mas com uma causa diferente da suposta:** o **ensemble de seis perfis nunca teve** capacidade de comparar/selecionar entre instrumentos — ele opera sobre um único envelope de um único instrumento por ciclo, por desenho (confirmado no próprio plano de 2026-09-01, que não menciona multi-instrumento nenhuma vez). A capacidade multimercado que existe no sistema (scanner de universo, ledger `INSTRUMENT_COMPARISON_V1`, admissão account-wide para MNQ/MES/MCL) pertence exclusivamente ao **operador único mais antigo** (`run-topstep-cycle.py`), continua presente no código, é ativamente mantida (commits recentes na era do prompt v17.1), mas **nunca teve, em toda a história do repositório, um teste ou fixture em que um instrumento diferente de MNQ vencesse a comparação** — isso não é uma regressão (nunca funcionou de forma comprovada), é uma lacuna de evidência desde a origem.

## 2. Comparação antes/depois

### 2.1 Prompt (`SOUL.md`)

| | Antes | Agora |
|---|---|---|
| Linhas | 18 (commit inicial `99431a4`) | 54 |
| Commit "SOUL trim" (Wave 8, `5dd61d9`, 2026-08-21) | 51 linhas antes | 51 linhas depois — **líquido zero**, 2 parágrafos detalhados sobre `MOVE_STOP`/`MOVE_TP`/`protection_status` foram substituídos por referências a `topstep-position-management`/`topstep-setup-state`, e o conteúdo detalhado foi **adicionado** a essas skills (+12 e +10 linhas respectivamente) | 
| Conclusão | O histórico do SOUL.md mostra **crescimento líquido monotônico** ao longo de ~30 commits nomeados por versão de prompt (`v6` até `v17.1`). O único "trim" documentado moveu conteúdo para skills sem perda líquida, exatamente como o roadmap Glitch NT prescreve ("Remove duplicated procedural prose only after tests prove equivalent obligations"). |

**Grau de confiança: alto.** Baseado em `git log --follow` completo do arquivo e diff linha-a-linha do commit de trim, não em amostragem.

### 2.2 Prompt efetivo por perfil do ensemble (skills realmente carregadas)

| Perfil | Skills há ~2h (antes do reparo `7b073177`, commit `90fc258`) | Skills agora (`81af2b8`) | Mudança |
|---|---|---|---|
| `baseline-current` | observe-market, market-scan, assess-risk, form-thesis, build-intent, position-management | idêntico | sem mudança |
| `structure` | observe-market, setup-state, form-thesis, build-intent | idêntico | sem mudança |
| `adversarial-risk` | assess-risk, form-thesis | idêntico | sem mudança |
| `smart-money` | observe-market, setup-state, form-thesis (**idêntico a `indicators`**) | + `topstep-smart-money` (nova, dedicada) | **corrigido hoje** |
| `indicators` | observe-market, setup-state, form-thesis (**idêntico a `smart-money`**) | + `topstep-indicators` (nova, dedicada) | **corrigido hoje** |
| `orderflow` | observe-market, orderflow-liquidity, form-thesis | idêntico | sem mudança (já era diferenciado) |

**Achado principal desta seção, já confirmado em auditoria anterior do mesmo dia e revalidado agora:** durante uma janela de aproximadamente 2 horas hoje (entre o commit `90fc258` e o commit `7b073177`), `smart-money` e `indicators` receberam **prompt efetivo idêntico**, diferenciados apenas pela string `profile_id`. Isso **foi corrigido** no mesmo dia; o estado atual (`81af2b8`) tem os dois perfis com skills genuinamente distintas e testadas (`test_specialty_skills_are_distinct_and_fail_closed_without_data`, reexecutado nesta sessão em auditoria anterior — `ok`).

### 2.3 Capacidade multimercado

| | Antes (histórico) | Agora |
|---|---|---|
| Scanner/ledger multi-instrumento (`scanner_contract.py`, `run-topstep-cycle.py`) | Existe desde antes do ensemble; testado por `test_multimarket_comparison_contract.py` | **Inalterado**, ainda presente e ativamente mantido (commits recentes na era v17.1) |
| Teste de seleção vencedora não-MNQ (MES ou MCL) | **Nunca existiu** — busquei todo o histórico git do fixture `multi01_comparison_ledger.txt`; `SELECTION_INSTRUMENT` é `MNQ` em 100% das versões já commitadas | **Inalterado** — ainda `MNQ` na única fixture existente |
| Admissão/execução account-wide por contrato exato (gateway) | `TS-MULTI-01/02/03` no ledger, status `done`, com nota: *"Simulated armed/shadow sessions per MNQ/MES/MCL→MCLE... Live MCL armed trade outcome remains unknown"* | **Inalterado** desde `last_verified_utc: 2026-08-20` |
| Capacidade multimercado **do ensemble de 6 perfis** | **Nunca existiu** — o plano de 2026-09-01 não menciona instrumento múltiplo nenhuma vez; `ensemble_envelope.py` só aceita um `instrument` string único; não há `market_universe` em nenhum arquivo do runner do ensemble | **Inalterado** — continua não existindo |

**Nada foi "perdido" na capacidade multimercado. O que existe hoje é exatamente o que existia antes de qualquer trabalho de ensemble: uma capacidade de scanner/ledger multi-instrumento no operador único, nunca comprovada além de simulação/fixture, e nunca integrada ao novo ensemble de seis perfis.** A suspeita de "regressão" não se sustenta porque não há um estado anterior, verificável, em que essa integração existisse e tenha sido removida.

## 3. Parte A — achados detalhados sobre qualidade do prompt

### 3.1 Como o prompt é realmente montado (reconfirmado)

`scripts/prac_live_ensemble.py::_invoke_hermes` envia ao Hermes CLI (`hermes chat --source trading --skills <lista> -Q -q <prompt>`) um JSON contendo apenas `instruction` (genérica, igual para todos), `envelope` (idêntico para os 6 perfis, mesmo `envelope_hash` — confirmado nos 21 envelopes do soak `PRAC-EXTENDED-20260910-...`), `profile_id`, `skills` (lista), e `output_contract`. **`capability-matrix.json` — que contém `forbidden_inference`, `horizon_bars`, `required_sources` por perfil — nunca é serializado no payload.** Esses metadados são usados **somente depois** da resposta, pelo `capacity_gate`/`ensemble_capacity_overlay`, para calcular `comparability`/`capacity_gate_reason` — nunca chegam ao modelo como instrução. Isso responde diretamente a uma das perguntas centrais da tarefa: **os metadados do registry/capability-matrix não chegam ao modelo; são usados apenas depois da resposta.**

`SOUL.md` presumivelmente permanece carregado como identidade base para toda invocação `--source trading` (o mesmo mecanismo usado pelo operador único), o que explica por que todos os seis perfis produzem saídas de qualidade e estrutura consistentes mesmo quando suas listas de `skills` diferem bastante. **Grau de confiança: médio** — não foi possível confirmar isso inspecionando o carregador de skills do próprio Hermes (fora do escopo/repositório acessível), apenas inferir pela convenção `--source trading` e pela consistência observada nas 126+ respostas reais do soak.

### 3.2 Regras de `NOTHING`/`no_edge`/`held`/`missing_required_evidence`/`timeout`

Confirmado (já auditado em detalhe em `LLM-PROMPT-QUALITY-AUDIT-20260910`, reconfirmado aqui por leitura): `topstep-form-thesis` distingue explicitamente confiança de `NOTHING` por qualidade de evidência (0.70–0.85 para dados usáveis mas simétricos; 0.95+ reservado para `DATA_DEGRADED`/evidência realmente inválida) — isso **evita exatamente o risco citado na tarefa** de o prompt confundir "não há edge" com "não há evidência", tratando-os como categorias de confiança distintas. O aggregator trata `missing_required_evidence` e `no_edge` como **estados totalmente separados** (`EXCLUDED_STATES` vs `ABSTENTION_STATES`), nunca contados um pelo outro — confirmado por leitura de código e por reprodução em `COGNITION-DECISION-AUDIT-20260910` (12 testes contrafactuais, incluindo o caso "dados insuficientes" isolado do caso "unanimidade em no_edge").

### 3.3 Separação cognição/execução/risco/autoridade do gateway

Confirmada de forma consistente em `SOUL.md` ("Glitch independently enforces..."), em `topstep-assess-risk` ("Glitch performs final monetary validation"), em `topstep-build-intent` ("Glitch performs final identity, freshness, geometry, risk, and execution validation"), e em `operator.json` (`"invariant": "Hermes decides. Glitch Topstep verifies factual execution safety..."`). Nenhuma skill ou trecho do SOUL.md atribui a Hermes autoridade de execução, admissão ou validação final de risco.

### 3.4 Políticas congeladas (daily capture / automatic breakeven)

`topstep-position-management`: *"Gateway `AUTO_BREAKEVEN` and daily-capture protection are tighten-only and intent-free — never confuse them with Hermes `MOVE_STOP` structural amendments."* `SOUL.md` linha 33: *"`reached=true` may cause the gateway to lock new exposure durably; reductions and flatten remain available."* Ambas as políticas congeladas do roadmap Glitch NT (§1 do roadmap 2026-08-20) estão corretamente descritas como **autoridade exclusiva do gateway**, não do Hermes, em texto de prompt atual. **Nenhuma mudança detectada nessas passagens em nenhum commit examinado hoje.**

### 3.5 Gates de confiança/sizing indevidos

Já verificado e reconfirmado: `aggregator_rules.v1.json` declara explicitamente `"Does not use raw LLM confidence"`; `evidence_score()` (código real, `ensemble_aggregator.py`) não lê o campo `confidence` em nenhum ponto. Nenhum gate de confiança textual influencia seleção ou sizing. `decision_scores` (opcional, cognitivo) é explicitamente descrito em `topstep-form-thesis` como *"never a wire field, never a worker gate"*.

### 3.6 Diversidade real entre perfis (estado atual, pós-reparo)

| Perfil | Vocabulário de especialidade nas skills atribuídas? | Confirmado em saída real? |
|---|---|---|
| `baseline-current` | N/A (referência completa) | — |
| `structure` | Sim (`topstep-setup-state`: CURRENT/BULLISH/BEARISH/NEXT) | Sim, linguagem de EMA/VWAP/estrutura nos 21 envelopes do soak |
| `smart-money` | **Sim, desde `7b073177` de hoje** (`topstep-smart-money`: FVG, order blocks, liquidity sweeps, displacement) | **Não verificado em produção real** — a skill é nova; nenhum ciclo live rodou com ela ainda (o soak de 21 envelopes usado como evidência de "linguagem genérica" é de **antes** deste reparo) |
| `indicators` | **Sim, desde `7b073177` de hoje** (`topstep-indicators`: RSI, MACD, ATR, divergências) | **Não verificado em produção real**, mesma razão |
| `orderflow` | Sim (`orderflow-liquidity`, desde antes) | Sim, granularidade de janelas 15s/60s/300s nas saídas reais do soak |
| `adversarial-risk` | Parcial (`assess-risk` é genuinamente focado em risco/geometria, mas não recebe `observe-market`) | Sim, framing de risco/geometria nas saídas reais |

**Limitação de confiança explícita:** a correção de `smart-money`/`indicators` é de **hoje**, posterior ao único soak de 21 envelopes disponível como evidência real. **Não existe, até o momento desta auditoria, nenhuma saída live real gerada com as novas skills `topstep-smart-money`/`topstep-indicators`.** A afirmação de que esses dois perfis "agora são distintos" está provada apenas em nível de (a) conteúdo do arquivo de skill e (b) um teste unitário que verifica que as duas listas de skills diferem — **não** em nível de saída real observada do modelo. Classificação correta: `capability_present_but_unproven` para o comportamento observável desses dois perfis especificamente, apesar do código estar corrigido.

### 3.7 Achado adicional não coberto pelas auditorias anteriores de hoje

As duas novas skills (`topstep-smart-money`, `topstep-indicators`) **não têm o cabeçalho YAML `---\nname: ...\ndescription: ...\n---`** presente em todas as outras 15 skills do repositório. Não foi possível verificar (sem iniciar o Hermes, proibido) se isso afeta o carregamento real da skill pelo mecanismo do Hermes ou se é cosmético. Já registrado como achado em `COGNITION-AGGREGATION-CONTRACT-REPAIR-AUDIT-20260910`; repetido aqui porque afeta diretamente a suspeita 1 desta tarefa.

## 4. Parte B — achados detalhados sobre avaliação multimercado

### 4.1 Matriz de evidência por instrumento

| Instrumento | Observado | Candidato formado | Comparado | Pode ser selecionado | Contrato resolvido | Entrega validada | Evidência |
|---|---|---|---|---|---|---|---|
| **MNQ** | Sim (produção real, todo o corpus PRAC do dia) | Sim (126 invocações reais no soak) | Sim (agregador real, 21 decisões recomputadas) | Sim, **mecanicamente** (nunca ocorreu de fato — 0 `selected` em toda a evidência) | Sim (`CON.F.US.MNQ.U26`, packet real) | Parcial — contrato do intent corrigido e aceito pelo parser real do gateway em teste, **nunca enviado de fato** | `docs/evidence/PRAC-EXTENDED-20260910-...`, `tests/test_prac_live_ensemble.py` |
| **MES** | Não, no ensemble (nenhum envelope MES já foi construído); Sim, no gateway (fixture simulada `multi-contract-session.test.ts`, modo `shadow`/`armed`, dados em memória) | Não, no ensemble; parcialmente, no ledger do operador único (fixture `multi01_scanner_packet.json`, sempre com `SELECTION_INSTRUMENT=MNQ`, nunca MES) | Não, no ensemble (aggregator exige `candidate.instrument == envelope.instrument`, e o envelope nunca é MES); Sim/parcial no ledger do operador único, mas só como candidato **perdedor** no ranking | **Não comprovado em nenhum caminho** — nenhum teste em todo o histórico do repositório tem `SELECTION_INSTRUMENT=MES` | Sim, isoladamente, no gateway (`resolveInstrumentUniverse`, `validatePortfolioSelection`, fixtures em memória) | Não | `tests/multi-contract-session.test.ts` (gateway), `tests/test_multimarket_comparison_contract.py` (profile) |
| **MCL/MCLE** | Mesma situação que MES | Mesma situação que MES | Mesma situação que MES | **Não comprovado** — ledger explicitamente registra: *"Live MCL armed trade outcome remains unknown (residual in PARITY.md)"* | Sim, isoladamente (`MCL` é alias operador, resolve para `CON.F.US.MCLE.*` real) | Não | `docs/ledger/ledger.json` item `TS-MULTI-01`, mesmos testes acima |

**Nenhuma allowlist, tipo ou mock foi tratado como "suporte comprovado."** A coluna "Pode ser selecionado" só recebe "Sim" quando um teste real demonstra a seleção vencedora daquele instrumento especificamente — isso nunca ocorre para MES/MCL em nenhum teste encontrado.

### 4.2 Por que isto não é uma regressão

1. O plano de implementação do ensemble (2026-09-01, referência obrigatória desta auditoria) **não lista multi-instrumento como objetivo** — ao contrário, seus "não objetivos" (§2) e fases (§11) tratam exclusivamente de comparação **entre perfis cognitivos sobre o mesmo instrumento/envelope**, nunca entre instrumentos.
2. O código do ensemble (`ensemble_envelope.py`, `ensemble_aggregator.py`, `prac_live_ensemble.py`) nunca teve, em nenhum commit examinado, um campo `market_universe` ou qualquer noção de múltiplos candidatos-instrumento — não há diff que remova essa capacidade porque ela nunca foi adicionada ali.
3. O scanner multi-instrumento mais antigo (`scanner_contract.py`, `run-topstep-cycle.py`) permanece no repositório, é ativamente mantido (commits recentes na era do prompt v17.1, o mesmo dia dos reparos de hoje), e seu contrato/ledger (`INSTRUMENT_COMPARISON_V1`) não sofreu nenhuma alteração que reduza sua capacidade nominal.
4. O que nunca existiu — uma prova de que esse scanner seleciona corretamente um instrumento diferente de MNQ — **também nunca existiu antes**, então não pode ter sido "perdido."

**Conclusão para a Parte B: `capability_present_but_unproven`, não `capability_degraded` nem `regression_confirmed`.** A capacidade multimercado do operador único está presente em código e parcialmente testada (identidade, contrato, admissão), mas a seleção vencedora de um instrumento não-MNQ nunca foi demonstrada em nenhum ponto da história do repositório — e essa mesma capacidade nunca fez parte do desenho do ensemble de seis perfis, então não pode ter regredido dele.

### 4.3 Itens explicitamente checados e não encontrados evidência de perda

- Prevenção de fallback automático para MNQ: o **validador** (`validate_comparison_ledger` em `scanner_contract.py`) não força `SELECTION_INSTRUMENT=MNQ` — aceita qualquer instrumento presente no `ranking`. O default para MNQ observado é uma propriedade da **fixture de teste**, não do código de validação. Achado preciso: risco de vício de confirmação não identificado no código, apenas ausência de teste que exercite o caminho alternativo.
- `account_selection.mode=single_active_position`, serialização account-wide, e proibição de exposição simultânea: presentes e inalterados (`TS-MULTI-03`, ledger `done`).
- Daily-capture e hard-loss-floor account-wide: fora do escopo do ensemble (autoridade exclusiva do gateway, não tocada por nenhum commit revisado hoje).

## 5. Parte C — ensemble, agregador e qualidade das avaliações (por referência)

Esta seção foi extensivamente auditada em duas sessões anteriores no mesmo dia, com recomputação independente do agregador real e reprodução direta de casos contrafactuais. Resumo, com remissão ao relatório completo em vez de repetição integral:

- **Envelope imutável/hash:** confirmado idêntico entre os 6 perfis em 21/21 ciclos reais (`COGNITION-DECISION-AUDIT-20260910` §2).
- **Determinismo do agregador:** confirmado por reexecução dupla de cada um dos 21 ciclos reais e por testes dedicados (`test_determinism_same_input_same_output`, `test_order_permutations_same_decision`, `test_reversed_order_same_decision`), reexecutados nesta sessão em `COGNITION-AGGREGATION-CONTRACT-REPAIR-AUDIT-20260910` §9.
- **Leave-one-out / influência marginal:** `structure` influenciou 6/21 decisões; `indicators` e `orderflow` influenciaram 0/21 no soak disponível (nota: esse soak antecede a correção das skills de `smart-money`/`indicators` de hoje, então essa medição específica de influência **precisa ser refeita** após um novo corpus com as skills corrigidas — ver §9).
- **Veto adversarial:** mecanismo corrigido hoje (`81af2b8`) e confirmado end-to-end (com e sem objeção, via `aggregate_global` real) — mas **nenhuma skill foi atualizada para ensinar o modelo a emitir o campo `objections`**; portanto, mesmo corrigido no código, o veto deve continuar inobservado em ciclos live reais até uma atualização de prompt correspondente.
- **Preservação de candidatos não selecionados:** confirmada — `candidates_preserved` no objeto de seleção sempre contém todos os candidatos, inclusive os eliminados.
- **Normalização sem invenção:** confirmada extensivamente (thesis/reason fail-closed, instrumento e quantity agora validados objetivamente, nenhum default perigoso encontrado em 126+ registros reais examinados).

**Grau de confiança desta seção: alto para os fatos citados (recomputação direta com código real); médio para a generalização a qualquer sessão futura, já que a amostra é um único regime de mercado de ~18 minutos.**

## 6. Parte D — contratos e prontidão de entrega (por referência)

Também extensivamente auditada hoje. Resumo:

- `intent_id`, `created_utc`, `model_version`, `prompt_version`, `scope_hash`/`scope_generation`, `decision_audit` completo: todos corrigidos e **aceitos pelo parser TypeScript real do gateway** (`dist/src/domain/intents.js`, invocado via subprocesso Node em teste, reexecutado nesta sessão — `ok`).
- `paired-contract.json` referencia versões semânticas (`profile.version=0.2.9`, `gateway.version=0.2.6`, `prompt_version=glitch-topstep-v17.1`), consumidas em tempo de execução pelo novo módulo `scripts/paired_contract.py` — não é apenas documentação estática.
- Drift de `SHA256SUMS`/frozen-cohort: 100% explicado pelas mudanças já revisadas hoje; nenhum arquivo surpresa.
- **Nenhum teste em todo o histórico do repositório exercita uma decisão `selected` de fato entregue a um gateway real em execução** (o teste mais próximo usa o parser TS isoladamente, sem servidor rodando). Isso vale tanto para MNQ quanto — a fortiori — para qualquer outro instrumento.

## 7. Achados priorizados

| # | Severidade | Título | Impacto | Causa provável | Evidência | Reprodutibilidade | Risco operacional | Recomendação |
|---|---|---|---|---|---|---|---|---|
| 1 | **P1** | Ensemble de 6 perfis nunca teve capacidade multimercado (não é regressão, é escopo original) | Qualquer expectativa de que o ensemble já compara MNQ/MES/MCL está incorreta | Desenho original do plano de 2026-09-01, nunca alterado | `ensemble_envelope.py` sem campo `market_universe`; plano de 2026-09-01 sem menção a multi-instrumento | Alta (leitura direta de código + plano) | Nenhum (não é um defeito, é um limite de escopo não documentado como tal em nenhum lugar visível) | Documentar explicitamente esse limite de escopo no README/roadmap do ensemble, para não ser confundido com regressão no futuro |
| 2 | **P1** | Nenhum teste, em toda a história, prova seleção vencedora de MES ou MCL | Capacidade multimercado do operador único permanece `unproven`, não `proven`, para o caso que mais importa (trocar de instrumento) | Fixture única (`multi01_comparison_ledger.txt`) nunca foi variada | Busca completa do histórico git do fixture: 0 ocorrências de `SELECTION_INSTRUMENT=MES` ou `MCL` | Alta | Médio — se um dia essa seleção ocorrer ao vivo pela primeira vez sem teste prévio, comportamento é desconhecido | Adicionar variante do fixture com MES ou MCL vencendo, mais teste de ponta a ponta (packet correto, `/packet?contract_id=` para o instrumento vencedor, entrega de intent) antes de qualquer promoção que dependa dessa capacidade |
| 3 | **P2** | Skills `smart-money`/`indicators` corrigidas hoje nunca produziram saída real | A diferenciação está no código mas não foi observada em produção | Correção aconteceu horas atrás; nenhum novo soak rodou desde então | `docs/evidence/LLM-PROMPT-QUALITY-REPAIR-20260910/report.md` (timestamp) vs. soak `PRAC-EXTENDED-20260910` (mais antigo) | Alta (basta rodar um novo smoke) | Baixo | Um smoke de um envelope específico avaliando a saída textual real dessas duas skills antes de qualquer soak longo |
| 4 | **P2** | Veto adversarial corrigido no código, mas nenhuma skill ensina o modelo a emiti-lo | Mecanismo permanecerá inobservado (`adversarial_objection_status=absent`) indefinidamente em produção | Reparo de hoje só tocou código Python, não prompts | `skills/topstep-assess-risk/SKILL.md` sem menção a `objections`; commit `81af2b8` não toca nenhum `SKILL.md` | Alta | Baixo (falha segura — ausência tratada como sem veto) | Decidir e, se aprovado, atualizar o prompt de `adversarial-risk` para emitir `objections` estruturadas |
| 5 | **P3** | Skills novas sem front-matter YAML | Inconsistência de formato; efeito real desconhecido | Provável descuido ao criar os dois novos arquivos | Comparação direta com as outras 15 skills | Alta | Desconhecido, não verificável sem iniciar o Hermes | Adicionar front-matter por consistência; validar carregamento antes do próximo smoke, se possível de forma segura |
| 6 | **P3** | `SHA256SUMS`/frozen-cohort desatualizados | Reduz o valor de alerta desses guards | Falta de passo de regeneração após os reparos de hoje | Reexecução dos dois testes de integridade, hoje | Alta | Nenhum (drift 100% explicado) | Regenerar antes de qualquer empacotamento final |

## 8. Oportunidades de recuperação

**Recuperação de prompt/skills:**
- Repositório: `glitch-topstep-hermes-profile`. Arquivos: `skills/topstep-smart-money/SKILL.md`, `skills/topstep-indicators/SKILL.md` (adicionar front-matter); nenhuma dependência externa; risco baixo; critério de aceite: front-matter presente e consistente com as outras 15 skills; não exige release pareado; pode ser feito shadow-only (não afeta contrato de wire).
- Repositório: `glitch-topstep-hermes-profile`. Arquivo: `skills/topstep-assess-risk/SKILL.md` (ou nova skill dedicada) para ensinar emissão de `objections`; depende da decisão humana de habilitar o veto operacionalmente; risco baixo-médio (mudança de prompt, requer nova rodada de smoke); critério de aceite: uma saída real de `adversarial-risk` contendo `objections` válido, capturada e revisada antes de confiar na métrica de veto; não exige release pareado (formato já aceito pelo agregador); deve começar shadow-only/evaluation-only.

**Recuperação de cobertura multimercado:**
- Repositório: `glitch-topstep-hermes-profile`. Arquivo: `tests/fixtures/paired/multi01_comparison_ledger.txt` (nova variante com MES ou MCL vencendo) + `tests/test_multimarket_comparison_contract.py` (novo teste). Dependências: nenhuma mudança de contrato necessária (o validador já aceita qualquer instrumento do ranking). Risco baixo. Critério de aceite: teste verde com `SELECTION_INSTRUMENT` diferente de MNQ. Não exige release pareado. Pode ficar shadow-only/replay-only indefinidamente até que uma decisão real de negócio queira usar isso ao vivo.
- Repositório: ambos, pareado. Se a decisão for eventualmente integrar multi-instrumento **ao ensemble de seis perfis** (não apenas ao operador único), isso é uma mudança de arquitetura significativa (o envelope precisaria carregar candidatos por instrumento, e o agregador precisaria de uma nova camada de comparação entre instrumentos, distinta da atual comparação entre perfis) — não recomendado antes das Fases 7–10 do plano de 2026-09-01 (shadow, replay, paper, canary) estarem concluídas para o caso de um único instrumento.

**Recuperação de testes e fixtures:**
- Ampliar o corpus congelado (Fase 4 do plano de 2026-09-01) para incluir pelo menos um ciclo com `smart-money`/`indicators` usando as novas skills, permitindo remedir influência marginal (leave-one-out) e correlação com dados atualizados.

**Recuperação de observabilidade:**
- Registrar `adversarial_objection_status` (já implementado no código) em todo relatório de sessão daqui em diante, para que a ausência de veto seja visível e rastreável ao longo do tempo, não apenas inferível por auditoria.

**Recuperação de contrato:**
- Regenerar `SHA256SUMS` e o manifesto de frozen-cohort (P3 acima).

**Recuperação de replay e avaliação:**
- Nenhuma pendente além do já recomendado nas auditorias anteriores (fixture pareado completo para o contrato de intent, já parcialmente entregue hoje via `test_selected_intent_is_accepted_by_real_gateway_validator`).

**Melhorias de arquitetura:**
- Documentar explicitamente, em um único lugar (ex.: um novo `docs/plans/*-ensemble-scope.md` ou seção no próprio plano de 2026-09-01), que o ensemble de 6 perfis é **deliberadamente single-instrument** e que a comparação multi-instrumento é uma capacidade **separada e não integrada**, para eliminar a ambiguidade que motivou esta própria auditoria.

## 9. Plano mínimo de recuperação

1. **Congelar a baseline atual:** usar exatamente `gateway 4943b3265bb83836867a6ff0f0d61296d3567e61` / `profile 81af2b8b1e367c01d9380b85824a0cf116b9cba2` como ponto de partida — já auditado, já com P0/P1 anteriores corrigidos.
2. **Reconstruir a baseline histórica verificável:** feito nesta auditoria via `git log --follow` de `SOUL.md` e do histórico completo do fixture multimercado — não há necessidade de repetir, mas deve ser referenciado em qualquer auditoria futura.
3. **Comparar prompts efetivos:** já feito para os seis perfis (§3.6); repetir especificamente para `smart-money`/`indicators` **depois** de um novo smoke real com as skills corrigidas (ainda não existe saída real).
4. **Criar corpus congelado multimercado:** adicionar a variante de fixture com MES/MCL vencendo (§7 item 2) antes de qualquer promessa de capacidade multimercado.
5. **Testar perfis individualmente:** já coberto pela suíte reexecutada hoje (101+15+33 testes focados, todos verdes).
6. **Testar agregação global:** já coberto (recomputação independente dos 21 ciclos reais, determinismo confirmado).
7. **Testar seleção vencedora por instrumento:** **pendente** — é exatamente a lacuna do item 2 de §7; nenhuma seleção vencedora de MES/MCL foi testada em toda a história.
8. **Testar falhas de identidade, contrato, lease, timeout e evidência:** já coberto para o caso single-instrument (identidade e quantity corrigidos e testados hoje); **pendente** para o caso multi-instrumento (nunca testado).
9. **Executar shadow-only:** ainda não ocorreu para o ensemble com as skills novas de `smart-money`/`indicators`; recomendado como próximo passo imediato (um smoke de um envelope, já recomendado na auditoria anterior).
10. **Definir critérios de promoção e rollback:** já documentados de forma extensa no plano de 2026-09-01 (§13, §16); nenhuma mudança recomendada.

**Não se recomenda execução armada em nenhum instrumento, e especialmente não em MES/MCL, antes que o item 4/7/8 (corpus e testes multimercado) exista — mesmo que o ensemble MNQ single-instrument esteja pronto para um smoke.**

## 10. Testes faltantes (lista concreta)

1. Mesmo envelope para todos os perfis — **já coberto e testado** (`test_all_profiles_share_same_envelope_hash`).
2. Prompt realmente diferente por especialidade — **coberto no código** (`test_specialty_skills_are_distinct_and_fail_closed_without_data`); **faltando** validação de saída real pós-correção.
3. `smart-money` e `indicators` com vocabulário e comportamento próprios em saída real — **faltando**, nenhuma execução ainda.
4. `orderflow` com dados presentes e ausentes — parcialmente coberto pelas 21 execuções reais do soak (dados variados naturalmente); **faltando** um teste dirigido especificamente à ausência total de order flow.
5. Quatro perfis concordando contra `adversarial-risk` — **coberto no agregador isolado** (`test_adversarial_critical_objective_eliminates` e meus testes end-to-end em `aggregate_global`); **faltando** com uma saída real do modelo emitindo a objeção (depende do item 4 de §8).
6. Empate e 3-vs-3 — **coberto** (`three_v_three_direction_conflict` em `COGNITION-DECISION-AUDIT-20260910`).
7. Todos em timeout — **coberto** (`test_timeout_is_not_abstention`, `test_timeout_classified`).
8. Instrumento divergente — **coberto para o caso single-instrument malicioso/hallucinado** (`test_instrument_identity_is_checked_before_selection`); **faltando** para o caso multi-instrumento legítimo (item 2 de §7).
9. Contrato/generation divergente — parcialmente coberto (`scope_generation` agora validado no intent); **faltando** um teste específico de `contract_id`/`scope_generation` divergentes entre candidatos do mesmo envelope.
10. Ausência de `quantity` — **coberto** (`test_quantity_is_required_and_validated_before_selection`).
11. `selected` válido por MNQ, MES e MCL/MCLE — **coberto apenas para MNQ**; **faltando integralmente** para MES e MCL (item 2 de §7, o achado mais importante desta auditoria).
12. Nenhum fallback silencioso — **coberto para instrumento e quantity**; **não testado** para o caso de fallback de instrumento dentro de um cenário multi-instrumento real (não existe esse cenário ainda).
13. `global_nothing` por ausência de edge versus ausência de evidência — **coberto** (`ENSEMBLE_UNANIMOUS_ABSTENTION` vs. `INSUFFICIENT_ENSEMBLE_AGREEMENT`/`MISSING_REQUIRED_EVIDENCE`, testado e recomputado).
14. Reexecução e estabilidade — **coberto** (determinismo do agregador); **não coberto** estabilidade intra-perfil do próprio LLM (reexecutar o mesmo envelope no Hermes real e medir concordância semântica) — isto está fora do escopo de um agregador puramente determinístico e exigiria uma sessão live, não recomendada aqui.
15. Correlação e leave-one-out — **coberto** para o soak existente; **precisa ser refeito** após um novo corpus com as skills corrigidas.
16. Replay determinístico — coberto para o agregador; **não coberto** para o pipeline completo envelope→Hermes→normalização com fixtures gravadas (Fase 8 do plano de 2026-09-01 ainda não iniciada).
17. Rejeição pelo gateway e paridade do contrato — **coberto** (`test_selected_intent_is_accepted_by_real_gateway_validator`, usa o parser TS real).

## 11. Limitações

- **Acesso ao repositório pareado:** o checkout do gateway (`.prac-operational-20260910/gateway`) e do profile (`.runner-implementation-20260910/profile`) foram acessados como checkouts locais de trabalho, não via GitHub remoto — histórico e branches remotos não foram verificados além do que existe localmente.
- **Ausência de snapshot histórico "oficial" pré-ensemble:** não existe uma tag ou branch explicitamente nomeada "antes do ensemble"; a reconstrução histórica usou `git log --follow` sobre arquivos individuais (`SOUL.md`, fixtures), que é confiável para esses arquivos específicos mas não constitui um snapshot completo e datado de todo o sistema em um ponto único no tempo.
- **Ausência de corpus com trades vencedores:** nenhuma decisão `selected` jamais ocorreu em nenhuma evidência disponível; toda avaliação de "qualidade" cognitiva é necessariamente sobre abstenção/comparação, nunca sobre acerto de entrada, gestão ou saída.
- **Ausência de evidência de execução multimercado:** confirmado extensivamente nesta auditoria (§4); é a limitação central do relatório.
- **Amostra pequena:** um único soak de 21 ciclos, ~18 minutos, um único regime de mercado, é a única evidência live real disponível para qualquer métrica de diversidade/correlação/influência.
- **Dependência de modelo/CLI:** não foi possível (nem permitido) verificar como o Hermes CLI real carrega e prioriza `SOUL.md` vs. skills vs. `profile_id`; essa parte da análise (§3.1) tem confiança média, não alta.
- **Impossibilidade de validar comportamento live sem violar o modo somente leitura:** as duas skills corrigidas hoje (`topstep-smart-money`, `topstep-indicators`) e o veto adversarial nunca puderam ser observados em uma saída real do modelo dentro desta auditoria, porque isso exigiria iniciar o Hermes — explicitamente proibido pelo escopo. Essas duas lacunas específicas (§3.6, achado 3 de §7) são, portanto, `blocked_by_missing_evidence`, não `regression_confirmed` nem `capability_degraded`.

---

*Relatório gerado por auditoria independente, somente leitura. Nenhum chain-of-thought privado da LLM foi solicitado. Nenhum gateway, Hermes, PRAC, soak, paper, canary ou ordem foi iniciado. Nenhum código, prompt, schema, ledger ou evidência foi alterado. Nenhuma credencial ou conteúdo de `.env` foi lido, copiado ou registrado.*
