# Auditoria independente — PRAC extended soak

- Sessão auditada: `PRAC-EXTENDED-20260910-4e7a1c6d2f48a0b5e3c7f9d1a6b8e2`
- Evidência primária: `docs/evidence/PRAC-EXTENDED-20260910-4e7a1c6d2f48a0b5e3c7f9d1a6b8e2/report.md`
- Auditor: sessão Claude Code independente, somente leitura, worktree `prac-extended-soak-audit-b69a3a`
- Data da auditoria: 2026-09-10
- **Classificação final: `audited_pass_execution_not_exercised`**

## 1. Método e escopo

Auditoria estática, somente leitura, sem iniciar gateway, Hermes, runner ou PRAC, sem retry/reset/alteração de evidência ou código, e sem ler `.env`/credenciais. Verificação feita por:

1. Leitura integral de `report.md` e `extended-summary.json` da sessão.
2. Parsing programático dos 21 `envelope-*.json` brutos e comparação campo-a-campo contra as 21 linhas (`rows`) de `extended-summary.json` (não apenas o texto-resumo).
3. Varredura de todos os arquivos JSON da sessão por padrões de risco (`order`, `fill`, `write`, `reset`, `flatten`, `cancel`, `intent`, `selected`, `entry`, `stop`, `target`) para confirmar ausência real, não apenas textual.
4. Verificação cruzada de SHAs declarados contra os checkouts git operacionais reais em disco (`.prac-operational-20260910/gateway`, `.runner-implementation-20260910/profile`), com `git -c safe.directory='*'` local (nenhuma configuração git foi alterada).
5. Reconstrução da linha do tempo de autorização do Profile SHA ao longo do dia, usando os demais relatórios de evidência do mesmo diretório (`PRAC-ACCEPTANCE-*`, `PRAC-UTF8-*`, `GATEWAY-RESTORE-20260910`, `HERMES-RUNTIME-20260910`, `PRAC-SMOKE-*`, `PRAC-SOAK-20260910-7c1e9a4b...`).
6. Comparação entre timestamps de conteúdo (`started_utc`/`finished_utc` dentro dos envelopes) e o `mtime` do sistema de arquivos de cada `envelope-*.json`.

## 2. Artefatos examinados

- `PRAC-EXTENDED-20260910-4e7a1c6d2f48a0b5e3c7f9d1a6b8e2/report.md`, `extended-summary.json`, `envelope-001.json` … `envelope-021.json` (todos os 21, integralmente).
- `PRAC-SOAK-20260910-7c1e9a4b6d2f48a0b5e3c7f9d1a6b8e2/report.md` (soak-base imediatamente anterior, mesmo PID/SHA/hash).
- `PRAC-SMOKE-20260910-9b4e7a1c6d2f48a0b5e3c7f9d1a6b8e2/report.md`, `PRAC-UTF8-20260910-.../report.md`, `PRAC-ACCEPTANCE-2026-09-10-runtime-correction/report.md`, `PRAC-ACCEPTANCE-2026-09-10-launch-fixed/preflight-report.md`, `PRAC-ACCEPTANCE-2026-09-10-quote-diagnosis/diagnosis-report.md`, `GATEWAY-RESTORE-20260910/report.md`, `HERMES-RUNTIME-20260910/report.md`, `PRAC-ACCEPTANCE-2026-09-10-68f3f53d/session.json`.
- Checkouts git operacionais em disco: `.prac-operational-20260910/gateway`, `.prac-operational-20260910/profile`, `.runner-implementation-20260910/profile` (apenas `git log`/`git status`/`git rev-parse`, leitura).

## 3. Verificações aprovadas

| # | Item do escopo | Resultado |
|---|---|---|
| 1 | Evidência pertence à sessão/gateway/profile declarados | **Confirmado.** `session_id` idêntico em `report.md`, `extended-summary.json` e implicitamente nos 21 envelopes (mesmos `envelope_id`/`envelope_hash` referenciados). Gateway SHA `4943b326…` = HEAD atual de `.prac-operational-20260910/gateway` (limpo, sem modificações). Profile SHA `435a64a4…` = HEAD atual de `.runner-implementation-20260910/profile` (árvore de trabalho sem alterações rastreadas, apenas diretórios de saída de execução não rastreados — ver item 10). |
| 2 | 21 envelopes comuns, 126 invocações, 6 perfis/ciclo | **Confirmado.** 21 arquivos `envelope-*.json`, cada um com exatamente os 6 perfis (`baseline-current`, `structure`, `adversarial-risk`, `smart-money`, `indicators`, `orderflow`), sem IDs de envelope duplicados. 21 × 6 = 126 invocações, batendo com `completed_envelopes=21` e o total de perfis contado diretamente nos arquivos brutos. |
| 3 | Uma decisão global por ciclo | **Confirmado.** 21 linhas em `extended-summary.json`, cada uma com exatamente um bloco `decision` e um `delivery`. |
| 4 | `no_selection` → `global_nothing`, sem intent | **Confirmado.** 21/21 `decision.outcome = "no_selection"`, 21/21 `delivery.status = "not_delivered"`, `delivery.reason = "global_nothing"`, `delivery.orders_sent = 0`, `decision.delivery_count = 0`. |
| 5 | Ausência real de ordens/fills/intents/writes/resets/exposição | **Confirmado por varredura bruta**, não apenas pelo resumo: nenhum arquivo contém campo de risco (`orders_sent`, `fills`, `writes`, `resets`, `flatten`, `cancel`, `intent`, `entry`, `stop`, `target`) com valor diferente de `0`/`null`/`false`/`[]` em nenhum dos 21 envelopes nem no `extended-summary.json`. Nenhuma ocorrência de `"outcome": "selected"` em todo o conjunto. |
| 6 | Health/packet/contrato/TTL/conta flat/reconciliação | **Confirmado em todas as 21 linhas + estado inicial**: `health=200`, `packet=200`, `ttl_valid=true`, `contract=selected_contract="CON.F.US.MNQ.U26"`, `flat=true`, `account_id=26919346` — valores idênticos e constantes do início ao fim, sem uma única divergência. |
| 7 | Encerramento antes da manutenção oficial | **Confirmado, com ressalva de precisão.** Última atividade registrada: `2026-09-10T20:00:17.345813Z`; manutenção oficial: `20:10:00Z` → margem real de **9 min 43 s**, folga de segurança mantida. Ver divergência 4.b abaixo sobre o rótulo "10m early". |
| 8 | Ausência de processos órfãos Hermes / segunda instância do gateway | **Não verificável a partir dos artefatos brutos desta pasta** (nenhum artefato de sistema — `tasklist`/`ps`/lock file — está incluído no bundle da sessão). A alegação é apenas textual no `report.md`. Há, porém, continuidade narrativa forte entre sessões vizinhas do mesmo dia (`GATEWAY-RESTORE-20260910` documenta a origem do PID `30180` após término controlado do PID órfão `28908`; `HERMES-RUNTIME-20260910`, `PRAC-SMOKE-20260910-9b4e7a1c…` e `PRAC-SOAK-20260910-7c1e9a4b…` relatam o mesmo PID `30180` "not restarted" de forma consistente e crescente ao longo do dia). Isso é consistente, mas não é prova direta. Ver risco residual 2. |
| 9 | Integridade, timestamps, hashes, consistência cruzada | **Confirmado com alta confiança.** Cross-check completo (programático, todos os 21 arquivos) entre `envelope-*.json` e `extended-summary.json` = 0 divergências em `envelope_id`, `envelope_hash`, `snapshot_hash` e `invocation_id` por perfil. `mtime` de cada `envelope-*.json` bate com o timestamp de conteúdo mais recente (`finished_utc`) com diferença de poucos milissegundos, de forma consistente do envelope 1 ao 21 — forte evidência de escrita contemporânea real, não retroativa. |
| 10 | Nenhuma alteração de código/prompt/contrato/API/risco/config durante o soak | **Confirmado por proxy.** `.prac-operational-20260910/gateway` está limpo (HEAD = SHA declarado, sem modificações). `.runner-implementation-20260910/profile` está com HEAD = SHA declarado; as 68 entradas não rastreadas presentes são exclusivamente diretórios `evaluation/runs/parallel_slots/<run_id>/` — saídas geradas pela própria execução (um dos `run_id`, `187f2102-e29f-4952-b593-040546a34c93`, corresponde exatamente ao `run_id` do envelope 001) — nenhum arquivo de código, prompt, config ou contrato foi modificado. Ressalva: este check reflete o estado do checkout **no momento da auditoria**, não uma captura contínua durante a janela 19:42–20:00Z. |

## 4. Divergências e lacunas identificadas

Nenhuma das divergências abaixo invalida a classificação de segurança da sessão (zero execução em todos os casos), mas devem constar do registro.

**a) Defeito de normalização "missing_thesis" em 124/126 invocações (achado principal).**
O campo `normalized.thesis` está `null` em 124 das 126 invocações, com `raw_status="incomplete_output"` e `error_code="missing_thesis"`. Inspeção do `raw_profile_output` mostra que 5 dos 6 módulos de perfil (`baseline-current`, `smart-money`, `indicators`, `orderflow`, `adversarial-risk`) emitem a explicação textual sob a chave `reason`, não `thesis` — apenas o perfil `structure` usa a chave `thesis` diretamente. O normalizador aparentemente lê só a chave literal `thesis`, perdendo a tese narrativa dos outros cinco perfis mesmo quando ela está presente e completa no bruto (confirmado com exemplo pareado: `envelope-001`, perfil `baseline-current`, tese completa de 3 frases no bruto, `thesis=null` no normalizado).
Isso **não afeta a matemática de decisão**: `comparability="comparable"` em 124/126 (só os 2 casos de `state=error` são `not_comparable`), ou seja, o motor de ensemble usa `state`/`direction`, não a presença de `thesis`. Porém compromete a auditabilidade/qualidade dos dados: praticamente toda a base fica marcada com um `error_code` que sugere problema quando, na maioria dos casos, é um bug de mapeamento de schema, não uma falha real do perfil.

**b) Rótulo "10m early" impreciso.**
`report.md` linha 8 declara `Safe cutoff: 2026-09-10T20:00:00Z`; a última invocação do envelope 21 terminou em `20:00:17.345813Z`, 17,3 s após esse corte interno declarado (embora ainda 9 min 43 s antes da manutenção real às `20:10:00Z`). O `stop_reason="maintenance_cutoff_10m_early"` é, portanto, uma aproximação — o mecanismo de parada evidentemente verifica o corte antes de iniciar um novo ciclo, não a cada invocação individual, permitindo que o envelope 21, já em andamento, termine ~17 s além do alvo interno. Sem impacto de segurança; é uma imprecisão de rotulagem/granularidade.

**c) Lacuna de 60 s no início da sessão sem corroboração bruta.**
`report.md` declara `Start: 19:42:40Z`, mas a primeira invocação de perfil registrada em qualquer envelope é `2026-09-10T19:43:40.136159Z` — 60 s depois. Nenhum artefato bruto no bundle documenta o que ocorreu nesse primeiro minuto (provavelmente preflight/health-check antes do primeiro envelope). Não é uma inconsistência, mas é uma lacuna de evidência não coberta por nenhum arquivo.

**d) Hash de pacote e PID/órfãos não recomputados de forma independente.**
O "Package hash" (`a88ca564…`) e as alegações de PID/ausência de órfãos Hermes são consistentes entre todos os relatórios do dia, mas nenhum manifesto bruto (ex.: `SHA256SUMS` do pacote específico, captura de `tasklist`) foi encontrado dentro deste bundle para recomputar/confirmar esses valores de forma independente. Classificado como consistente-porém-não-recomputado (hash) e não-verificável-no-bundle (processos), não como falha.

## 5. Classificação da estabilidade do pipeline live

**Estável, com padrão persistente de dados parciais.** Em 100% das 126 invocações, `completeness_used.ohlc="partial"` e `completeness_used.structure="partial"`; `quote`, `risk_context` e `session` estiveram `available` em 100% dos casos; `indicators`/`orderflow` estiveram presentes e `available`/`partial` conforme o perfil consultado. Health/packet retornaram `200` de forma constante, TTL válido em todas as 21 leituras, sem nenhum erro de conectividade ou reconexão registrado nos artefatos. O padrão de `ohlc`/`structure` sempre "partial" é consistente ao longo de toda a janela de 18 minutos (não é um evento isolado) e é coerente com a barra mais recente estar sempre em formação — mas, como não há um artefato bruto que comprove essa é a causa (vs. uma limitação de captação de dados), o padrão fica registrado aqui como observação, não como diagnóstico definitivo.

## 6. Classificação da validade das decisões `global_nothing`

**Válidas quanto à mecânica de decisão, mas com telemetria de justificativa degradada.** As 21 decisões `global_nothing` são suportadas por dados comparáveis (124/126 comparáveis, 2/126 `not_comparable`/`error`) e pela distribuição de estados observada (94 `no_edge`, 21 `missing_required_evidence`, 9 `candidate` sem geometria de entrada executável, 2 `error`) — em nenhum momento um perfil produziu uma tese com entrada/stop/alvo executável que tenha sido descartada silenciosamente; os 9 casos "candidate" tinham direção mas nenhum tinha `entry`/`stop`/`target` preenchidos (0 entradas não-nulas em toda a base). Isso sustenta que `INSUFFICIENT_ENSEMBLE_AGREEMENT` (11), `ENSEMBLE_CATEGORY_DIVERGENCE` (6) e `ENSEMBLE_UNANIMOUS_ABSTENTION` (4) refletem genuinamente falta de convergência/geometria executável, não uma supressão indevida de sinal. Ressalva: o defeito de mapeamento de `thesis` (item 4.a) reduz a capacidade de qualquer revisor humano de confirmar *por que* cada perfil individual chegou à sua conclusão, mesmo que o resultado agregado esteja correto.

## 7. Classificação da cobertura de execução real

**Cobertura de execução real: zero.** Confirma-se explicitamente, sem exceção, em todos os 21 ciclos:

- Nenhuma decisão `selected` ocorreu.
- Nenhuma entrada, stop, proteção, fill, flatten ou recovery foi exercitada.
- A sessão não demonstra eficácia da estratégia nem segurança do caminho de execução sob exposição real (nenhuma ordem chegou a ser roteada, nenhum protetor foi testado, nenhum fluxo de erro/retry de execução foi exercitado).
- `prac_acceptance_complete` reflete apenas que a sessão terminou dentro das regras operacionais e de segurança declaradas (sem execução) — **não deve ser interpretado como promoção "armed"** nem como validação do caminho de ordens.

## 8. Riscos residuais

1. O defeito de mapeamento `thesis`/`reason` (item 4.a) deve ser corrigido antes de qualquer auditoria futura que dependa da tese textual por perfil — hoje ela é sistematicamente perdida para 5 dos 6 perfis.
2. Nenhum artefato bruto de processo (PID/órfãos) está incluído no bundle; sessões futuras deveriam anexar uma captura leve (ex.: `tasklist`/`Get-Process` sanitizado) para permitir verificação independente sem depender de texto narrativo.
3. Como o caminho de execução real (ordem → fill → proteção → flatten → recovery) nunca foi exercitado em nenhuma das sessões do dia revisadas, esse caminho permanece **não validado empiricamente** até a presente data.

## 9. Recomendação objetiva da próxima etapa

Corrigir o mapeamento `reason`→`thesis` no normalizador de perfis (arquivo responsável mais provável: o mesmo `scripts/prac_live_ensemble.py`/normalizador em `.runner-implementation-20260910/profile`, dado que já foi o arquivo corrigido para o bug `bar_1m_close_missing` no mesmo dia) e reexecutar um soak curto para confirmar que `thesis` deixa de ficar nulo para os 5 perfis afetados. Somente depois disso considerar uma extensão de escopo (ex.: sessão com decisão `selected` em ambiente controlado/paper) para começar a cobrir o caminho de execução real, que continua inteiramente não exercitado.

---

*Relatório gerado por auditoria independente, somente leitura. Nenhum artefato original da sessão `PRAC-EXTENDED-20260910-4e7a1c6d2f48a0b5e3c7f9d1a6b8e2` foi modificado. Nenhuma credencial ou conteúdo de `.env` foi lido, copiado ou registrado.*
