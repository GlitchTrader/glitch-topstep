# Auditoria independente — cognição observável e decisão do ensemble Hermes

- Auditor: sessão Claude Code independente, somente leitura, worktree `prac-extended-soak-audit-b69a3a`
- Data: 2026-09-10
- Método: apenas entradas, saídas estruturadas, evidências, estados, objeções, regras do agregador e decisão final. **Nenhum chain-of-thought privado foi solicitado ou lido.**
- Nenhum gateway, Hermes, runner, PRAC ou ordem foi iniciado. Nenhum código, prompt, schema ou evidência foi alterado.

**Classificações (separadas):**

| Dimensão | Classificação |
|---|---|
| Auditoria de cognição/decisão | `cognition_audit_pass_with_findings` |
| Rastreabilidade da decisão (`decision_trace_insufficient`?) | **Não se aplica** — rastreabilidade foi suficiente: 21/21 decisões recomputadas de forma independente batem exatamente com as registradas, cada `no_selection` carrega `decision_code`/`decision_trace` explícito (ver §2, §11) |
| Cobertura de execução real | `execution_quality_not_exercised` |
| Necessidade de revisão humana | `needs-human-review` |

## Cadeia auditada

`envelope → seis perfis (Hermes) → normalização (`evaluation_output_adapter`/`run-ensemble-evaluation.build_normalized_candidate`) → agregação (`ensemble_aggregator.aggregate_envelope`) → decisão global → intent (`decision_to_gateway_intent`)`

## Artefatos examinados

- Código-fonte completo e executado localmente (leitura + recomputação pura, sem rede/Hermes/gateway): `scripts/ensemble_aggregator.py`, `scripts/ensemble_compare.py`, `scripts/ensemble_geometry.py`, `scripts/prac_live_ensemble.py`, `evaluation/aggregator_rules.v1.json`, `evaluation/registry.json`.
- Dados reais: os 21 `envelope-*.json` + `extended-summary.json` de `docs/evidence/PRAC-EXTENDED-20260910-4e7a1c6d2f48a0b5e3c7f9d1a6b8e2/` (126 invocações de perfil, 0 seleções).
- 13 fixtures contrafactuais sintéticas construídas por este auditor e executadas contra o `aggregate_envelope()` real (não uma reimplementação).

## 1. Matriz por perfil

| Perfil | `profile_version` | `prompt_version` | Papel declarado | Nº vezes que sua remoção mudou a decisão (leave-one-out, 21 envelopes reais) | Nº vezes selecionado |
|---|---|---|---|---:|---:|
| `baseline-current` | 1.0.0 | glitch-topstep-v17.1 | baseline (referência congelada) | 2/21 | 0 |
| `structure` | 1.0.0 | glitch-topstep-v17.1 | challenger (estrutura/swing) | **6/21** | 0 |
| `adversarial-risk` | 1.0.0 | glitch-topstep-v17.1 | observer/reviewer | 2/21 | 0 |
| `smart-money` | 1.0.0 | glitch-topstep-v17.1 | challenger (liquidez/SMC) | 1/21 | 0 |
| `indicators` | 1.0.0 | glitch-topstep-v17.1 | challenger (indicadores técnicos) | **0/21** | 0 |
| `orderflow` | 1.0.0 | glitch-topstep-v17.1 | challenger (tape/orderflow) | **0/21** | 0 |

Nenhum perfil foi selecionado nenhuma vez — não há decisão `selected` em nenhuma evidência disponível (ver §11). A coluna de influência (leave-one-out) é a métrica mais direta disponível de "papel exercido" na ausência de seleções reais.

## 2. Decisão por envelope — recomputação independente

O agregador real (`ensemble_aggregator.aggregate_envelope`) foi executado, offline e isoladamente, contra os 21 conjuntos de candidatos normalizados registrados no soak, com os mesmos `required_profile_ids` e `aggregator_rules.v1.json` usados originalmente.

- **21/21 `outcome` recomputados batem exatamente com o registrado.**
- **21/21 `decision_code` recomputados batem exatamente com o registrado.**
- Distribuição recomputada: `INSUFFICIENT_ENSEMBLE_AGREEMENT`=11, `ENSEMBLE_CATEGORY_DIVERGENCE`=6, `ENSEMBLE_UNANIMOUS_ABSTENTION`=4 — idêntica à evidência original.
- **Determinismo confirmado:** cada um dos 21 envelopes foi agregado duas vezes de forma independente; `outcome`, `decision_code` e `selected_profile_id` foram idênticos nas duas execuções em 100% dos casos (item 10 do escopo).

Isso satisfaz o item 9 do escopo (recálculo independente) com prova reprodutível, não apenas confiança no texto do relatório anterior.

## 3. Objeções e motivos de rejeição

**Achado crítico (P0):** no caminho **live** real (`prac_live_ensemble.py::aggregate_global`, linha 352), a chamada ao agregador é:

```python
decision = aggregate_envelope(run_id=run_id, envelope=envelope, candidates=candidates, objections=[], rules=rules, required_profile_ids=list(PROFILE_IDS))
```

`objections=[]` é **hardcoded como lista vazia**. O mecanismo de objeção/veto do agregador (`objections_norm`, elegibilidade `eliminates_candidate`, código `ADVERSARIAL_CRITICAL_OBJECTIVE_ELIMINATION`) existe, é determinístico e **funciona corretamente quando testado isoladamente** (ver testes contrafactuais 8a/8b, §5) — mas **nenhuma saída do perfil `adversarial-risk` é atualmente convertida em uma objeção estruturada em nenhum lugar do código**. O `adversarial-risk` participa hoje apenas como mais um candidato competindo por `evidence_score` no pool — não como um revisor com poder de veto sobre os outros cinco. Isso responde diretamente ao item 15 do escopo: **o veto adversarial é possível no agregador, mas não está habilitado no caminho live atual.**

No soak de 21 envelopes, `adversarial-risk` nunca produziu um candidato direcional com geometria válida (seu histórico de estados no corpus real é majoritariamente `no_edge`/`missing_required_evidence`), então esta lacuna nunca teve efeito observável até agora — mas está pronta para ser um ponto cego silencioso no primeiro ciclo em que `adversarial-risk` de fato levantasse uma objeção séria sobre outro perfil.

Motivos de rejeição/abstenção observados nos 21 envelopes reais (via `decision_trace`, todos com motivo explícito — item 11 confirmado 21/21):

| Motivo (`decision_trace` tail) | Ocorrências |
|---|---:|
| `INSUFFICIENT_ENSEMBLE_AGREEMENT` | 11 |
| `ENSEMBLE_CATEGORY_DIVERGENCE` | 6 |
| `ENSEMBLE_UNANIMOUS_ABSTENTION` | 4 |

## 4. Testes contrafactuais

Executados contra o `aggregate_envelope()` real com fixtures sintéticas sanitizadas (envelope MNQ, tick_size 0.25). "Esperado" reflete a leitura do código-fonte antes da execução; um `FAIL` indica que minha expectativa inicial estava errada quanto ao **código de decisão específico**, não necessariamente um defeito — cada linha abaixo documenta qual é o caso.

| # | Caso | Entrada (resumo) | Decisão esperada | Decisão observada | Motivo | Pass/Fail |
|---|---|---|---|---|---|---|
| 1 | Seis alinhados | 6 candidatos LONG equivalentes, `evidence_score` decrescente | `selected` | `selected`, `EVIDENCE_SCORE_WIN`, vencedor = maior `evidence_score` | correto | **PASS** |
| 2 | Três vs três | 3 LONG vs 3 SHORT, ambos comparáveis | `no_selection` | `no_selection`, `DIRECTION_CONFLICT` | correto — nunca escolhe lado silenciosamente | **PASS** |
| 3 | Candidato único | 1 candidato LONG, 5 `no_edge` | `no_selection` | `no_selection`, `ENSEMBLE_CATEGORY_DIVERGENCE` | minha expectativa de código estava errada (esperava `INSUFFICIENT_ENSEMBLE_AGREEMENT`); o código correto é `ENSEMBLE_CATEGORY_DIVERGENCE` porque a regra "pool não-vazio + houve abstenção" é verificada antes da regra "pool de tamanho 1" — **a propriedade de segurança (não selecionar com 1 candidato isolado) se manteve** | **PASS (propriedade de segurança); FAIL (código previsto)** |
| 4 | Sem stop | 2 candidatos LONG equivalentes, um sem `stop` | `no_selection` | `no_selection`; candidato sem stop eliminado por `invalid_stop_geometry`; sobrevivente único → `INSUFFICIENT_ENSEMBLE_AGREEMENT` | correto | **PASS** |
| 5 | Sem target (ambos) | 2 candidatos LONG equivalentes, ambos sem `target` | `selected` | `selected`, `EVIDENCE_SCORE_WIN` | correto — `target` é opcional pelas regras (`target_absence_reason`) | **PASS** |
| 6 | Dados insuficientes (perfil ausente) | 5 de 6 perfis presentes | `classified_failure` | `classified_failure`, `PROFILE_MISSING` | correto | **PASS** |
| 6b | Dados insuficientes (todos presentes, todos `missing_required_evidence`) | 6 perfis, todos `missing_required_evidence`/`not_comparable` | `no_selection` | `no_selection`, `INSUFFICIENT_ENSEMBLE_AGREEMENT` | correto — evidência insuficiente não conta como abstenção `no_edge`, cai em pool vazio | **PASS** |
| 7 | Divergência de instrumento | 2 candidatos LONG equivalentes, **ambos declarando `instrument="ES"` enquanto `envelope.instrument="MNQ"`** | `no_selection` (identidade deveria eliminar) | **`selected`, `EVIDENCE_SCORE_WIN`, vencedor = `baseline-current`, sem nenhuma entrada de `identity_mismatch` no trace** | **defeito confirmado — ver P0 dedicado abaixo** | **FAIL — achado de segurança** |
| 8a | Perfil adversarial rejeitando (1) | Objeção `critical`+`objective_rule_match=true` contra 1 de 2 candidatos equivalentes | `no_selection` | `no_selection`, `INSUFFICIENT_ENSEMBLE_AGREEMENT` (sobrevivente único) | correto — mecanismo funciona isoladamente | **PASS** |
| 8b | Perfil adversarial rejeitando (parcial) | Mesma objeção, mas com 1 terceiro candidato equivalente ileso | `selected` (o não-vetado) | `selected`, vencedor = candidato não-alvo da objeção | correto | **PASS** |
| 9 | Perfil com JSON inválido | 1 candidato `state=invalid` (simulando saída não-parseável) | `no_selection` | `no_selection`, candidato excluído do pool inteiramente (`SCHEMA_INVALID`), sobrevivente único → `INSUFFICIENT_ENSEMBLE_AGREEMENT` | correto — nunca promovido | **PASS** |
| 10 | Perfil substituído por `no_edge` | 2 candidatos LONG equivalentes + 4 `no_edge` | `no_selection` | `no_selection`, `ENSEMBLE_CATEGORY_DIVERGENCE` | correto — abstenção de outros perfis bloqueia seleção mesmo com acordo local | **PASS** |
| 11 | `quantity` ausente | 2 candidatos LONG equivalentes, `quantity=None` em ambos | (verificar se agregador exige `quantity`) | **`selected`, `EVIDENCE_SCORE_WIN` — `quantity` nunca foi lido pelo agregador** | confirma achado dedicado (ver P0/P1 abaixo) | **achado de arquitetura, não uma falha isolada** |

**11 de 13 casos corresponderam exatamente à expectativa de segurança (mesmo quando o `decision_code` específico diferiu da minha previsão inicial). Os casos 7 e 11 revelam lacunas reais e reprodutíveis, detalhadas abaixo.**

## 5. Achados P0/P1/P2

### P0 — `aggregate_envelope()` nunca valida que o instrumento do candidato corresponde ao instrumento do envelope

Reproduzido isoladamente e de forma limpa (dois candidatos LONG equivalentes, geometria idêntica, **ambos declarando `instrument="ES"` contra `envelope.instrument="MNQ"`**): resultado = `outcome="selected"`, `decision_code="EVIDENCE_SCORE_WIN"`, `selected_profile_id="baseline-current"`, **`decision_trace=["EVIDENCE_SCORE_WIN"]`** — nenhuma menção a `identity_mismatch` em nenhum lugar.

Causa raiz: `aggregator_rules.v1.json` declara a regra `identity_mismatch` (`validator: validate_candidate_identity`) na lista `objective_elimination_rules`, mas **a função `validate_candidate_identity` não existe em nenhum arquivo `.py` do repositório** (confirmado por busca em todo o código). O único validador de geometria realmente conectado ao agregador (`_objective_geometry_codes` → `validate_entry_candidate_geometry`) só verifica `stop`/`target`, nunca `instrument`. O mesmo vale para a segunda regra documentada, `contradictory_required_evidence` (`validator: validate_candidate_evidence_consistency`) — também sem implementação correspondente.

**Por que isso ainda não causou dano:** a sessão PRAC atual opera em modo de instrumento único (MNQ); todos os seis perfis recebem o mesmo envelope e, empiricamente, sempre relataram `instrument="MNQ"` nos 126 registros do soak. **Por que isso importa:** o roadmap Glitch NT (Wave 5, `docs/plans/2026-08-20-nt-adaptation-roadmap.md`) planeja explicitamente selecionar entre MNQ/MES/MCL a partir do mesmo fluxo global — no momento em que isso for habilitado, ou se qualquer perfil algum dia rotular incorretamente o instrumento (alucinação de identidade), o agregador **selecionaria silenciosamente** um candidato para o instrumento errado, sem qualquer objeção ou eliminação.

### P0 — `quantity` nunca é validado no nível do agregador/decisão

`aggregate_envelope()`, `ensemble_compare.classify_candidate()` e `ensemble_geometry.validate_entry_candidate_geometry()` **não leem o campo `quantity` em nenhum momento** (confirmado por busca em todo `scripts/`: `quantity` só aparece em `prac_live_ensemble.py`). A validação de `quantity` (junto com `entry`/`stop`/`target`) só ocorre **depois** da agregação, em `decision_to_gateway_intent()` (`required = ("entry", "stop", "target", "quantity")`), que lança `RunnerError` se ausente — antes de qualquer tentativa de entrega ao gateway. **Isto significa que o item 12 do escopo ("nenhuma decisão `selected` sem instrumento, direção, entrada, stop, target e quantity válidos") é satisfeito apenas em duas camadas separadas, não em uma única barreira no ponto de decisão**: a camada de agregação pode retornar `outcome="selected"` com `quantity` nulo (confirmado no teste #11); a segunda camada (entrega) barra a entrega, mas não corrige nem reclassifica a `outcome="selected"` original — o objeto de decisão em si permanece marcado como "selected" com um candidato tecnicamente inexecutável. Isso já foi identificado de forma relacionada na auditoria de qualidade de prompt/schema anterior (campos `intent_id`/`created_utc`/`model_version`/`prompt_version` ausentes do mesmo payload).

### P1 — Papel do `adversarial-risk` como revisor com poder de veto não está habilitado no caminho live (ver §3)

### P1 — `indicators` e `orderflow` tiveram influência zero nas 21 decisões reais do soak (leave-one-out)

Combinado com o achado da auditoria de prompt anterior (skill set de `indicators` idêntico ao de `smart-money`, sem vocabulário de especialidade em nenhum dos dois), isso reforça a preocupação de que nem todos os seis "pontos de vista" estão de fato contribuindo de forma distinta e decisiva — embora, com zero seleções em toda a evidência, isso não possa ainda ser atribuído com certeza a uma falha de design vs. uma característica real do período observado (mercado sem edge para specifically essas lentes analíticas).

### P2 — Campo estruturado `uncertainties` nunca é populado (0/126 invocações no soak)

O schema `normalized_candidate.v1.json` reserva um campo `uncertainties` (lista) para preservar incerteza explícita de forma estruturada — auditável programaticamente sem depender de parsing de texto livre. Em 100% das 126 invocações do soak, esse campo está vazio, mesmo quando o texto de `reason`/`thesis` menciona explicitamente incerteza ("depth is unavailable," "tape is mixed/conflicted"). A incerteza existe na prosa, mas não no campo estruturado desenhado para isso.

## 6. Métricas

Calculadas sobre os 21 envelopes reais / 126 invocações de perfil do soak `PRAC-EXTENDED-20260910-4e7a1c6d2f48a0b5e3c7f9d1a6b8e2`:

| Métrica | Valor |
|---|---:|
| Taxa de acordo de direção entre perfis (por envelope, unanimidade entre os que declararam direção) | 15/21 = 71,4% |
| Taxa de divergência de direção | 6/21 = 28,6% |
| Taxa de `global_nothing` | 21/21 = 100% |
| Motivos de abstenção (`decision_code`) | `INSUFFICIENT_ENSEMBLE_AGREEMENT` 11 · `ENSEMBLE_CATEGORY_DIVERGENCE` 6 · `ENSEMBLE_UNANIMOUS_ABSTENTION` 4 |
| Frequência de cada perfil ser `selected` | 0/21 para todos os seis (nenhuma seleção ocorreu) |
| Influência por remoção (leave-one-out) | `structure` 6/21 · `baseline-current` 2/21 · `adversarial-risk` 2/21 · `smart-money` 1/21 · `indicators` 0/21 · `orderflow` 0/21 |
| Envelopes com decisão dependente de pelo menos 1 perfil específico | 11/21 = 52,4% |
| Proporção de respostas com evidência suficiente (`comparability="comparable"`) | 124/126 = 98,4% |
| Proporção de respostas com incerteza estruturada explícita (`uncertainties` não-vazio) | 0/126 = 0% |
| Divergência entre `profile_declared_state` e `state` normalizado | 0/126 = 0% (override do runner live preserva o estado declarado em 100% dos casos observados) |
| Códigos de erro de normalização (herdados do bug já corrigido em `90fc258…`, soak anterior à correção) | `missing_thesis` 124 · `directional_without_geometry` 2 |

## 7. Riscos de consenso artificial

- **Confirmado (P1, §5):** `indicators` e `smart-money` compartilham o mesmo conjunto de skills, texto de prompt efetivo idêntico, e influência de remoção quase nula (0 e 1, respectivamente) — dois dos seis "votos" do ensemble carregam risco real de não serem, de fato, perspectivas independentes.
- **`structure` domina a influência marginal** (6/21) — em mais de um quarto dos ciclos, a decisão final depende inteiramente da participação desse perfil específico. Isso não é por si um defeito, mas concentra o "poder de decisão" do ensemble em menos perfis do que os seis nominais sugerem.
- A convergência de 71,4% de acordo de direção entre os perfis, no soak observado, refletiu leitura factual compartilhada de um mercado sem edge claro (mesmo envelope, mesmos dados) — **não deve ser lida automaticamente como qualidade estratégica**, conforme instruído. É evidência de coerência de leitura de dados, não de acerto preditivo (nunca testado, ver §9).

## 8. Riscos de abstenção excessiva

Nenhuma evidência, nos 21 ciclos reais nem nos 13 testes contrafactuais, de abstenção **não-justificada**: todo `no_selection`/`ENSEMBLE_*` teve um `decision_code` e `decision_trace` explícitos e reproduzíveis (item 11 confirmado). O padrão observado (`INSUFFICIENT_ENSEMBLE_AGREEMENT` dominante, seguido por `ENSEMBLE_CATEGORY_DIVERGENCE`) é consistente com dados reais de mercado sem convergência suficiente para uma seleção segura, não com um defeito de agregação — confirmado pela recomputação bit-a-bit em §2. O risco real de abstenção excessiva permanece **não avaliável** com apenas 21 ciclos de um único regime de mercado (ver limitações, §9) — um período com mais oportunidades genuínas de entrada ainda não foi observado para confirmar que o agregador de fato seleciona quando deveria, e não apenas que se abstém corretamente quando deve.

## 9. Limitações da evidência

Conforme explicitamente exigido pela tarefa:

- **Provado offline (nesta auditoria):** o agregador é determinístico e reproduz exatamente as 21 decisões registradas; o mecanismo de veto adversarial funciona corretamente quando exercitado isoladamente; gates de dados/risco têm precedência sobre consenso (candidatos com evidência insuficiente são excluídos do pool antes de qualquer comparação); confiança textual da LLM nunca é lida pelo agregador (`evidence_score` não usa `confidence`); `no_selection` sempre carrega motivo explícito e rastreável; **o agregador não valida identidade de instrumento nem `quantity`** (defeitos confirmados, §5).
- **Observado live (evidência real, não sintética):** 21 envelopes, 126 invocações, 21 decisões `no_selection`, zero decisões `selected`, zero intents, zero ordens — replicados nesta auditoria por recomputação, não apenas lidos do relatório anterior.
- **Nunca ocorreu, em nenhuma evidência disponível até esta data:** uma decisão `selected`; um veto adversarial real (`adversarial-risk` nunca gerou objeção estruturada, e o mecanismo está desabilitado no caminho live); uma entrega de intent ao gateway; qualquer ordem, fill, stop, target ou flatten.
- Não é possível, com esta evidência, avaliar se o agregador **selecionaria corretamente** quando deveria — apenas que ele se abstém corretamente e nunca seleciona incorretamente **nos casos observados e testados**. Os dois defeitos de §5 (instrumento, `quantity`) só seriam expostos em cenários que ainda não ocorreram na evidência real (multi-instrumento; um candidato genuinamente vencedor sem `quantity`).
- Consenso e abstenção observados não foram interpretados como prova de qualidade estratégica nem como falha, conforme instruído — ambos foram avaliados apenas quanto à corretude mecânica e rastreabilidade.

## 10. Recomendações para instrumentação adicional

1. **P0** — Implementar `validate_candidate_identity` (checagem `candidate.instrument == envelope.instrument`, e idealmente `contract_id`/`contract_generation`) e conectá-la a `_objective_geometry_codes` ou equivalente, com teste de regressão reproduzindo exatamente o caso #7 desta auditoria.
2. **P0** — Adicionar uma checagem de `quantity` (e, quando aplicável, `contract_id`/`scope_generation`) **no próprio `aggregate_envelope()`**, não apenas na entrega, para que `outcome="selected"` nunca seja retornado para um candidato que a camada de entrega rejeitaria de qualquer forma — hoje as duas camadas podem divergir silenciosamente.
3. **P1** — Decidir explicitamente (e documentar) se `adversarial-risk` deve gerar objeções estruturadas no caminho live; se sim, implementar a conversão candidato→objeção antes de `aggregate_global`; se não, atualizar `capability-matrix.json`/`aggregator_rules.v1.json` para não sugerir um poder de veto que não existe operacionalmente.
4. **P1** — Popular o campo `uncertainties` a partir do texto/estrutura já disponível (ou explicitamente descontinuar o campo se não for prioridade), para permitir auditoria estruturada de incerteza sem depender de parsing de prosa.
5. **P2** — Expandir a amostra de recomputação para múltiplos regimes de mercado (não apenas o período de 18 minutos observado) antes de tirar qualquer conclusão sobre a taxa "correta" de `global_nothing`.
6. **P2** — Adicionar aos testes automatizados (`tests/`) os 13 cenários contrafactuais construídos nesta auditoria — atualmente nenhum teste no repositório cobre divergência de instrumento, ausência de `quantity` no nível do agregador, ou o caso "3 vs 3".

---

*Relatório gerado por auditoria independente, somente leitura. Nenhum chain-of-thought privado da LLM foi solicitado, acessado ou reportado — toda a análise usa apenas entradas, saídas estruturadas e código determinístico. Nenhum gateway, Hermes, runner, PRAC ou ordem foi iniciado. Nenhum código, prompt, schema ou evidência foi alterado.*
