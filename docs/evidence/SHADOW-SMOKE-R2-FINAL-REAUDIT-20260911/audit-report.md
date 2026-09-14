# Reauditoria independente final — shadow smoke v17.2 (r2) e causa raiz do provider Hermes

- Auditor: sessão Claude Code independente, somente leitura, worktree `prac-extended-soak-audit-b69a3a`
- Data: 2026-09-11
- Evidência: `C:/Users/arifr/Projects/glitch-topstep-hermes-profile/docs/evidence/shadow-smoke-20260911-r2/` (`report.md`, `run-1.json`, `run-2.json`, `run-3.json`)
- Nenhum overnight, canary, paper armado, sizing, gateway armado ou ordem real foi iniciado. Nenhum código/prompt/skill/contrato/ledger/evidência foi alterado. Nenhuma credencial/`.env`/token foi lido, tentado contornar ou registrado.

## Veredito final

**Classificação mantida, exatamente como a tarefa antecipa: `blocked` + `needs-human-review` + `shadow-only`.**

Esta reauditoria **identifica com alta confiança a causa raiz** do erro que bloqueia a avaliação cognitiva (§4) — algo que a reauditoria anterior não conseguiu fazer por falta de instrumentação. Isso é um avanço real de diagnóstico, não uma mudança de prontidão: a causa é uma lacuna de autenticação do provedor do Hermes, que **continua impedindo qualquer saída de modelo**. A classificação não muda até que essa lacuna seja resolvida por um humano e uma nova execução produza saída real.

## 1. Confirmação de integridade final

| Item | Declarado na tarefa | Confirmado nesta auditoria |
|---|---|---|
| Profile canônico | `5d33cfd` | **Confirmado exatamente**: HEAD de `glitch-topstep-hermes-profile` (CANON) e de `.runner-implementation-20260910/profile` (RUNNER) é `5d33cfd1a490145bc053538b8d58ef1a85e9bcec` — os dois continuam sincronizados desde a reauditoria anterior. |
| Gateway operacional | `6446984` | **Não confirmado para o checkout que de fato roda.** `64469847c0df58f468717e46a23204a982a1d222` existe, está no branch `main`, e é **um commit somente de documentação** (`docs/ledger/ledger.json` + `docs/release-notes/2026-09-11-prompt-v17.2-pair.md`, 32 linhas, zero arquivos de código-fonte). Ele tem `928ed96` como ancestral (a correção de pareamento `chore(release): pair prompt v17.2 with profile wiring`, que **agora está mergeada em `main`**). Porém **o checkout operacional real do gateway (`.prac-operational-20260910/gateway`) permanece, sem alteração, em `4943b3265bb83836867a6ff0f0d61296d3567e61`** — não foi atualizado, não tem `928ed96` nem `6446984` na sua árvore local, e seu `src/domain/operator.ts` ainda declara `GLITCH_TOPSTEP_PROMPT_VERSION = "glitch-topstep-v17.1"`. **Este é o mesmo achado da reauditoria anterior, ainda não resolvido.** |
| `prompt_version=v17.2` em gateway e profile | Ambos | **Profile: confirmado** (`paired-contract.json` do profile → `"prompt_version": "glitch-topstep-v17.2"`). **Gateway operacional: não confirmado** — ainda `v17.1`, ver acima. |
| Paired-contract SHA256 | `8399…8897A` | **Confirmado por recomputação independente.** `sha256(paired-contract.json do profile) = 83992E681F3EA0784667F36DAE509E1F04E96318CC61FED5B0E58F5B22D8897A` — bate exatamente com o valor completo implícito pela tarefa. |
| Runner sincronizado e limpo | — | **RUNNER: limpo**, nenhuma modificação de arquivo rastreado. **CANON: quase limpo** — 5 arquivos de artefato gerado (`evaluation/release/six-profile-evaluation-package-2026-09-02.json` e quatro `evaluation/runs/test-milestone-six-*.json`) têm diffs de conteúdo não commitados (não apenas normalização de fim de linha desta vez — até 51 linhas alteradas em um deles). São arquivos de saída/relatório de execução, não código ou configuração; registrado como discrepância menor de higiene, não como risco. |
| `HERMES_HOME` apontando para o profile canônico | — | **Confirmado por leitura de código, inalterado desde as duas reauditorias anteriores**: `scripts/prac_live_ensemble.py::_invoke_hermes` força `env["HERMES_HOME"] = str(default_glitch_topstep_hermes_home())` = `%LOCALAPPDATA%\hermes\profiles\glitch-topstep`, em toda invocação. O próprio `report.md` da evidência declara o mesmo caminho. |
| `gateway_supervised_overnight=false` | — | Não encontrei esse campo explicitamente em `run-*.json` ou `report.md` desta evidência; porém `mode: "offline"`, `authorized: false`, `orders_sent: 0` em todos os três `run-*.json`, e `report.md` afirma explicitamente "No overnight, canary, armed paper, sizing change, gateway promotion, or live order was started" — consistente com a intenção do campo, ainda que o campo nomeado não esteja presente neste artefato específico. |

## 2. Verificação/reexecução dos gates declarados

| Gate declarado | Reexecutado | Resultado real |
|---|---|---|
| Profile: 739/739 pass, 8 skips | Sim — `python -m unittest discover -s tests -p "test_*.py"` em RUNNER | **739 testes no total (bate exatamente), mas 1 falha real e 10 skips** — não "739/739 pass" nem "8 skips". A única falha é `test_selected_intent_is_accepted_by_real_gateway_validator`, com `prompt_version_mismatch` — a mesma falha da reauditoria anterior, causada exatamente pelo item §1 (gateway operacional ainda em v17.1). Ela não foi resolvida entre a reauditoria anterior e esta. |
| Gateway: 667/667 pass | Sim — `npm run check` em `.prac-operational-20260910/gateway`, executado **duas vezes** | **Não reproduzido.** Primeira execução: 658 testes, 657 passaram, **1 falha transitória** em `packet-observation-refresh.test.js` (`actual: false, expected: true`). Segunda execução, imediatamente em seguida, sem nenhuma mudança: **657/658 passaram, 0 falhas** — a mesma contagem estável de todas as auditorias anteriores. Registro a falha da primeira execução como uma **flakiness observada, não uma regressão confirmada** (não reproduziu na repetição imediata). Em nenhuma das duas execuções cheguei a 667 testes — esse número provavelmente pertence à árvore de `928ed96`/`6446984` (que modifica ~14 arquivos de teste do gateway, incluindo adições), que não está checked out no diretório operacional que audito. |
| `test_selected_intent_is_accepted_by_real_gateway_validator` | Sim, isoladamente | **Falha, reproduzida de forma determinística**: `AssertionError: 1 != 0 : prompt_version_mismatch`. Usa o parser TypeScript real e compilado do gateway operacional (`dist/src/domain/intents.js`). |
| Replay multimercado MNQ/MES/MCL | Tentado | **Não localizável.** Confirmando o achado da reauditoria anterior: `tests/test_winning_multimarket_selection.py` e as fixtures `multi01_comparison_ledger_win_{mnq,mes,mcl}.txt` **continuam ausentes** em ambos os checkouts (`5d33cfd`), sem histórico git em nenhum dos dois repositórios. A perda registrada ontem não foi revertida. |
| Divergência de instrumento / lease expirado / timeout / stale / ausência de evidência | Parcial | As checagens genéricas de instrumento divergente e quantidade inválida (`validate_candidate_identity`, `validate_candidate_quantity` em `ensemble_aggregator.py`) continuam presentes e cobertas por `tests/test_ensemble_parallel_aggregator.py` (parte dos 739, todos verdes). As checagens **específicas de multi-instrumento com vencedor não-MNQ** (lease/handoff/generation) dependiam do módulo perdido acima e não puderam ser reexecutadas. |
| Preload Hermes sequencial e paralelo | Sim, indiretamente pela própria evidência | Confirmado pela evidência do smoke em si: preload é a etapa que resolve `skill_ids` e chama `require_hermes_preload` **antes** de `subprocess.run` do Hermes chat — todas as 18 invocações do r2 alcançaram a etapa de invocação real do Hermes (evidenciado pelo campo `"command"` completo com `--skills` já resolvido), confirmando que o preload — sequencial dentro de cada perfil, paralelo entre slots — foi concluído com sucesso em 100% dos casos antes da falha. |
| Preservação sanitizada de stdout/stderr em falhas não-zero | Sim | **Confirmado e funcionando** — é exatamente a correção `90d2ef6 fix(profile): preserve Hermes diagnostics and preload stability`, aplicada entre a reauditoria anterior e esta. Ver §4 para o conteúdo capturado. |

## 3. Auditoria do smoke shadow (os três runs)

- **Mesmo envelope hash em todos os três runs**: confirmado — `61b94ab398990dd58d2193c1de6628f9b527e77dd1c2001885f904dac2cfe952`, idêntico em `run-1.json`, `run-2.json`, `run-3.json`.
- **Mesmo profile/prompt/schema/model version**: confirmado por perfil — `prompt_version: "glitch-topstep-v17.2"` e `model_version: "gpt-5.6-luna"` idênticos em todas as 18 linhas de perfil across os três runs.
- **Mesmo conjunto de skills**: confirmado pelo campo `"command"` de cada diagnóstico (ex.: `adversarial-risk` sempre `--skills topstep-assess-risk,topstep-form-thesis`).
- **Preload concluído**: confirmado (§2, linha "Preload Hermes").
- **Delivery desabilitado**: confirmado — `delivery: {"status": "not_delivered", "reason": "delivery_disabled_by_mode", "orders_sent": 0}` nos três runs.
- **`orders_sent=0`**: confirmado nos três runs, no nível raiz e no bloco `delivery`.
- **Nenhuma alteração operacional**: confirmado — `mode: "offline"`, `authorized: false` nos três runs; nenhuma chamada ao gateway real ocorreu (envelope sintético, `snapshot_hash` = `aaaa…aaaa` como antes).
- **Classificação correta de erro**: confirmado — `error_code: "hermes_provider:hermes_process_nonzero"`, `raw_status: "incomplete_output"` (ou `null` quando `capacity_gate_reason` já excluía o perfil antes mesmo de olhar o erro), nunca reclassificado como `no_edge` nem descartado.
- **Diagnóstico sanitizado preservado**: confirmado e é o achado central desta auditoria (§4) — presente, completo, e sem nenhum credencial/token visível em nenhuma das 18 entradas que li.
- **Erro ocorreu depois do preload e antes de qualquer saída de modelo**: confirmado — `hermes_diagnostic.stage = "provider"` (não `"preload"` nem `"skill_gate"`) em todas as 18 entradas; `raw_profile_output` nunca contém `thesis`/`reason`/`direction` além de `null`.
- **Ausência de falha silenciosa de skill, normalização, agregação ou contrato**: confirmado por leitura direta do bloco `decision` de `run-1.json` — os 6 candidatos com `state="error"` foram corretamente excluídos do pool (`SCHEMA_INVALID`/`MISSING_REQUIRED_EVIDENCE` no `decision_trace`), resultando em `outcome: "no_selection"`, `decision_code: "INSUFFICIENT_ENSEMBLE_AGREEMENT"`, `selected_profile_id: null` — nunca um candidato inválido foi promovido, nunca uma decisão fantasma de `NOTHING` com justificativa fabricada foi criada.

## 4. Investigação do provider Hermes — causa raiz identificada com alta confiança

Lendo o campo `hermes_diagnostic` (novo nesta evidência, produto direto da correção `90d2ef6`), obtive, para **as 18 de 18 invocações** (6 perfis × 3 runs, sem exceção — reprodutibilidade total, diferente do r1 de ontem onde uma invocação divergiu):

```json
{
  "stage": "provider",
  "classification": "provider",
  "returncode": 1,
  "command": ["hermes.exe", "chat", "--source", "trading", "--max-turns", "4", "--skills", "<lista resolvida>", "-Q", "-q"],
  "duration_ms": ~1840–2800,
  "stdout": "No Codex credentials stored. Run `hermes auth` to authenticate. Run `hermes model` to re-authenticate.",
  "stderr": ""
}
```

**Classificação da causa: autenticação do provedor (Codex/`openai-codex`) — não há credenciais armazenadas para o Hermes CLI neste ambiente/`HERMES_HOME`.** Isso é determinado com alta confiança, não por inferência:

- **Não é timeout**: a mensagem de erro específica (`hermes_process_nonzero`, `returncode=1`) só é alcançável depois que `subprocess.run` retorna normalmente; um timeout geraria uma exceção Python diferente, nunca capturada com um `returncode`.
- **Não é falha de launcher/executável**: o comando resolveu para `hermes.exe` com todos os argumentos corretos, incluindo a lista de skills já resolvida pelo preload — o processo correto foi de fato iniciado.
- **Não é incompatibilidade de CLI nem de configuração de skills**: a mensagem não menciona nada sobre schema, skills, ou argumentos inválidos — é literalmente uma mensagem de autenticação do provedor, textual e inequívoca.
- **Não é limite de chamadas (rate limit)**: a mensagem não menciona limite ou quota; a duração (~2 segundos) é consistente com uma checagem de credenciais local e rápida, não com uma chamada de rede que retornou 429.
- **Não é transporte/rede**: nenhuma mensagem de timeout de socket, DNS, ou conexão recusada.
- **É, com alta confiança, uma condição de autenticação do provedor**: a própria mensagem instrui explicitamente `hermes auth` / `hermes model` — exatamente a assinatura de uma sessão sem token de provedor armazenado.

**Isto é totalmente consistente com — e reforça — a hipótese não confirmada que registrei na reauditoria anterior** (a existência de um arquivo `auth.lock`, modificado no mesmo minuto do smoke de ontem, em `glitch-topstep-hermes-profile/auth.lock`). Não abri esse arquivo hoje também (mantendo a restrição de não ler credenciais), mas a mensagem de erro agora capturada é evidência textual direta e suficiente por si só, sem necessidade de inspecionar `auth.lock`.

**O que falta, precisamente, para resolver:** uma pessoa autorizada, fora do escopo desta auditoria somente-leitura, precisa executar `hermes auth` (ou `hermes model`) interativamente no ambiente correto (`HERMES_HOME` = `%LOCALAPPDATA%\hermes\profiles\glitch-topstep`, o mesmo caminho canônico confirmado em §1) para estabelecer credenciais do provedor Codex, e então repetir o smoke.

## 5. Limites da conclusão (separados rigorosamente, conforme exigido)

| Dimensão | Status |
|---|---|
| **Código e contrato pareado validados** | Parcial. Profile: sim, hash de paired-contract confirmado, `prompt_version=v17.2` confirmado. Gateway: **não** — checkout operacional ainda em v17.1, incompatibilidade real e reproduzida (§1, §2). |
| **Wiring e preload validados** | Sim — 18/18 invocações alcançaram a etapa de invocação real do Hermes com a lista de skills corretamente resolvida; nenhuma falha de preload nesta rodada (diferente de ontem, onde uma ocorreu). |
| **Fail-closed validado** | Sim — nenhuma saída inválida foi convertida em decisão válida; o erro se propagou corretamente até `no_selection`. |
| **Replay multimercado validado** | **Não** — a suíte que provava isso foi perdida (confirmado novamente hoje, §2) e permanece ausente. |
| **Execução live/shadow do modelo** | **Não produziu saída de modelo válida** — 0 de 18 invocações retornaram um JSON de candidato. Confirmado bloqueio externo de autenticação (§4), não um problema de especialização. |
| **Especialização `smart-money`** | **Não comprovada, não declarada como comprovada.** Nenhuma saída foi produzida por este perfil no r2. |
| **Especialização `indicators`** | **Não comprovada, não declarada como comprovada.** Idem. |
| **Estabilidade cognitiva** | **Não avaliável** — não há saída de estado (`candidate`/`no_edge`) do modelo para medir estabilidade; o único "padrão estável" observado é o de uma falha de autenticação idêntica 18/18 vezes, o que não é estabilidade cognitiva. |
| **Prontidão para canary ou overnight** | **Não.** Nenhuma condição de promoção foi satisfeita; uma nova incompatibilidade de contrato foi confirmada como persistente. |

Conforme instruído: não declarei especialização comprovada, não declarei estabilidade cognitiva comprovada, não declarei `canary-ready`, e não inferi qualidade a partir apenas dos markers de preload (que, aliás, nem chegaram a ser reavaliados nesta rodada especificamente, já que a falha ocorreu na etapa de provedor, depois do preload).

## 6. Achados confirmados, regressões inexistentes, e falhas externas

**Achados confirmados (novos ou reafirmados):**
- Causa raiz do erro do provedor: autenticação Codex ausente — confirmado com alta confiança (§4).
- Incompatibilidade `prompt_version` gateway/profile: **persiste, não resolvida**, confirmada por teste real reproduzido novamente.
- Paired-contract SHA256 da tarefa: confirmado por recomputação.
- Profile canônico SHA da tarefa: confirmado exatamente.
- "Gateway operacional: 6446984" da tarefa: **não confirmável para o checkout que roda de fato** — é um commit de documentação em `main`, cujo ancestral de código (`928ed96`) nunca foi aplicado ao checkout operacional.

**Regressões que investiguei e não encontrei** (ou seja, seguem estáveis desde a reauditoria anterior): wiring de skills, `HERMES_HOME`, hashes de skill canon/runner/live, sincronização RUNNER↔CANON (que aliás melhorou desde a penúltima reauditoria), `SHA256SUMS`/frozen-cohort (permanecem regenerados e verdes — não testei novamente nesta rodada por já estar confirmado ontem sem nenhuma mudança de arquivo relevante desde então).

**Regressão real confirmada nesta rodada:** a suíte de teste de seleção multimercado vencedora continua perdida (era esperado que talvez tivesse sido recuperada; não foi).

**Falha externa (não é código do repositório):** ausência de credenciais Codex armazenadas para o Hermes CLI no `HERMES_HOME` canônico (§4).

## 7. Próximo desbloqueio mínimo

1. **Bloqueador imediato, fora do escopo desta auditoria:** uma pessoa autorizada executa `hermes auth`/`hermes model` no `HERMES_HOME` canônico e confirma credenciais Codex válidas armazenadas.
2. **Bloqueador de contrato, independente do item 1:** atualizar o checkout operacional do gateway (`.prac-operational-20260910/gateway`) para incluir `928ed96`/`6446984` (ou equivalente), reconstruir `dist/`, e reexecutar `test_selected_intent_is_accepted_by_real_gateway_validator` até que ele passe.
3. **Recuperação de cobertura, de menor urgência:** recriar e commitar `tests/test_winning_multimarket_selection.py` e as fixtures correspondentes — perdidas há dois ciclos de reauditoria consecutivos.
4. Somente depois de 1 e 2: uma nova execução shadow, offline, com o mesmo envelope imutável, para finalmente obter saída real de `smart-money`/`indicators` e permitir avaliação de especialização e estabilidade.

---

*Relatório gerado por reauditoria independente, somente leitura. Nenhum chain-of-thought privado da LLM foi solicitado. Nenhum overnight, canary, paper armado, sizing, gateway armado ou ordem real foi iniciado. Nenhum código, prompt, skill, contrato, ledger ou evidência foi alterado. Nenhuma credencial ou conteúdo de `.env`/token foi lido, contornado ou registrado.*
