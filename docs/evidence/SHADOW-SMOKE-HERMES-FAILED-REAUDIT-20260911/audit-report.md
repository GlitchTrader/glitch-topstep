# Reauditoria independente — shadow smoke v17.2 e `provider_error:hermes_failed`

- Auditor: sessão Claude Code independente, somente leitura, worktree `prac-extended-soak-audit-b69a3a`
- Data: 2026-09-11
- Evidência: `C:/Users/arifr/Projects/glitch-topstep-hermes-profile/docs/evidence/shadow-smoke-20260911/` (`README.md`, `report.md`, `run.json`, `run-2.json`, `run-3.json`)
- Nenhum overnight, canary, paper armado, sizing, gateway armado ou ordem real foi iniciado. Nenhum código/prompt/skill/contrato/ledger/evidência foi alterado. Nenhuma credencial/`.env` foi lida (inclusive um arquivo `auth.lock` encontrado durante a investigação — apenas seus metadados de arquivo foram inspecionados, nunca seu conteúdo).

## Veredito independente

**Classificação mínima confirmada e mantida:** `capability_present_but_unproven` + `shadow-only` + `needs-human-review`.

**Recomendação final: `blocked` para qualquer avanço em direção a canário/promoção, combinado com `needs-human-review` para dois problemas concretos e não relacionados entre si que esta reauditoria encontrou e que a evidência declarada não menciona:** (1) o par gateway/profile está **byte-incompatível agora**, comprovado por um teste real reproduzível (§3); (2) a suíte de testes que finalmente provava seleção vencedora de MES/MCL — que eu havia descoberto e validado na reauditoria de ontem — **foi perdida** entre ontem e hoje (§6). Nenhum dos dois é causado pelo `hermes_failed` em si, mas ambos bloqueiam qualquer recomendação além de `shadow-only`/`blocked`.

## 1. Confirmação ou divergência dos SHAs

| Item | Declarado na tarefa | Declarado em `report.md` | Confirmado nesta auditoria |
|---|---|---|---|
| Profile canônico | `7f68b23` | `5849e2309f01cd526eb11835954599793444d175` | **HEAD real de ambos os checkouts (`glitch-topstep-hermes-profile` e `.runner-implementation-20260910/profile`) é `7f68b235e30cb1f26e9946ae4806b0193f5c4b5b` — bate exatamente com o valor da tarefa.** O valor citado em `report.md` é um commit **2 posições atrás** de `7f68b23` na mesma linhagem (`5849e23 feat(profile): integrate runner and fail-closed skill wiring` → `6169866 test(profile): record blocked v17.2 shadow smoke` → `7f68b23 chore(profile): refresh evidence manifest`). Isso é explicável: o smoke rodou contra `5849e23`, e os dois commits seguintes apenas registraram o resultado e atualizaram o manifesto de evidência — não alteraram código de execução. **Não é uma divergência real de código, mas o campo do relatório está desatualizado em relação ao HEAD atual e deveria ser corrigido.** |
| Gateway pareado | `928ed96` | `928ed96dafb435ca9c8f7bdc590fd4d7711eaa7d` | **Existe, mas apenas na branch dedicada `codex/prompt-v17-2-paired` do repositório principal — não está mergeada em nenhum branch padrão e, mais importante, não está deployada no checkout operacional do gateway (`.prac-operational-20260910/gateway`, que permanece em `4943b3265bb83836867a6ff0f0d61296d3567e61`, o commit já auditado nos dias anteriores).** `928ed96` é filho direto e mais recente de `4943b326` (progressão normal, sem conflito de histórico), e seu conteúdo (`chore(release): pair prompt v17.2 with profile wiring`) bump `src/domain/operator.ts` e `release/paired-contract.json` de `glitch-topstep-v17.1` para `v17.2` — exatamente a contraparte gateway-side do bump feito no profile. **Mas isso nunca foi aplicado ao checkout que de fato roda.** Ver §3 para a consequência concreta e comprovada disso. |
| Paired-contract SHA256 | `83992E...D8897A` | não citado explicitamente em `report.md` | **Não localizado em nenhum arquivo do profile, gateway ou evidência examinados.** Nenhum `paired-contract.json`, `SHA256SUMS`, ou artefato de release em nenhum dos checkouts contém um hash começando por `83992E` e terminando em `D8897A`. Registrado como **não confirmável com a evidência disponível** — não presumo que esteja errado, apenas que não encontrei a fonte dele. |
| Prompt version | (não citado diretamente) | `glitch-topstep-v17.2` | Confirmado: `paired-contract.json` do profile (`7f68b23`) declara `profile.prompt_version = "glitch-topstep-v17.2"`. **O gateway operacional real ainda declara `v17.1`** (ver §3). |

## 2. Confirmação do `HERMES_HOME`

Confirmado por leitura de código (`scripts/prac_live_ensemble.py::_invoke_hermes`, inalterado desde a reauditoria de ontem): `env["HERMES_HOME"] = str(hermes_home)`, onde `hermes_home = default_glitch_topstep_hermes_home()` resolve para `%LOCALAPPDATA%\hermes\profiles\glitch-topstep` — o mesmo caminho canônico verificado ontem, forçado em toda invocação real, antes de qualquer chamada ao Hermes CLI. Não houve mudança neste mecanismo entre ontem e hoje. Os hashes de skill citados em `report.md` (`topstep-smart-money`: `B45C43AD…`, `topstep-indicators`: `2D2A3B08…`) **são idênticos aos que confirmei ontem em canon/runner/live** — nenhuma divergência de conteúdo de skill detectada.

## 3. Achado principal, não coberto pela evidência declarada: par gateway/profile byte-incompatível agora

Ao reexecutar a suíte de testes do profile (`python -m unittest discover`, ver §5), obtive **uma falha real e reproduzível**:

```
FAIL: test_selected_intent_is_accepted_by_real_gateway_validator
AssertionError: 1 != 0 : prompt_version_mismatch
```

Este teste invoca o parser TypeScript **real e compilado** do gateway (`dist/src/domain/intents.js`, gerado a partir do checkout operacional `.prac-operational-20260910/gateway`) via subprocesso Node, com um intent construído pelo profile atual. Investigando a causa:

- `paired-contract.json` do profile (`7f68b23`): `"prompt_version": "glitch-topstep-v17.2"`.
- `src/domain/operator.ts` do gateway operacional: `export const GLITCH_TOPSTEP_PROMPT_VERSION = "glitch-topstep-v17.1";` — **inalterado desde 2026-09-10T07:17**, ou seja, de antes de qualquer trabalho desta semana.
- `release/paired-contract.json` do gateway operacional: também `"prompt_version": "glitch-topstep-v17.1"`.
- O commit que corrige isso do lado do gateway (`928ed96`, branch `codex/prompt-v17-2-paired`) existe mas **nunca foi aplicado ao checkout operacional**.

**Consequência concreta:** o gateway real, hoje, rejeitaria qualquer intent construído pelo profile atual com `prompt_version_mismatch` — antes mesmo de qualquer outra validação. Isso é **independente e mais grave** do que o `provider_error:hermes_failed` investigado no smoke (que impediu a cognição de rodar); este é um problema de **entrega**, que se manifestaria assim que uma decisão `selected` fosse produzida e a entrega fosse tentada contra o gateway real. Isso responde diretamente à pergunta da tarefa "se gateway e profile continuam byte/semanticamente compatíveis" — **não estão, agora, comprovado por um teste real e não por inferência.**

Isso também é a manifestação exata do risco que eu havia sinalizado na reauditoria de ontem (§4, "risco de falsa equivalência de versão... recomendo bump de prompt_version"): o bump foi feito do lado certo (profile), mas o processo de release pareado não completou o lado do gateway antes de o profile já ter avançado — criando uma nova incompatibilidade que não existia ontem.

## 4. Análise causal de `provider_error:hermes_failed`

### O que a evidência prova, com alta confiança

- **Não foi timeout.** O código-fonte (`scripts/prac_live_ensemble.py:327-342`) chama `subprocess.run(..., timeout=...)`; se houvesse estourado o timeout, uma exceção Python `TimeoutExpired` seria lançada e a linha `if completed.returncode:` nunca seria alcançada. O fato de o erro ser exatamente `"hermes_failed"` (não `ensemble_timeout` nem uma exceção de timeout) prova que o subprocesso **completou** dentro do orçamento e retornou um código de saída diferente de zero.
- **O Hermes CLI foi de fato invocado** — não houve degradação silenciosa. As marcas de tempo (`started_utc`/`finished_utc`) de cada perfil mostram uma janela real de **~2,0 a 4,6 segundos** por invocação (ex.: `adversarial-risk` em `run.json`: `14:28:32.033013Z` → `14:28:34.678671Z`), tempo compatível com um processo que de fato iniciou, tentou algo (bootstrap de sessão, chamada de rede ao provedor, ou validação interna) e terminou — não uma falha instantânea de "executável não encontrado" nem um travamento até o limite de tempo.
- **O wiring/preload de skills foi concluído antes da chamada ao Hermes na esmagadora maioria dos casos** — 17 das 18 invocações (6 perfis × 3 execuções) falharam com `hermes_failed`, que só é alcançável **depois** que `assert_declared_skills_ready(...)` já retornou com sucesso (linha 295-302 do runner, antes do `subprocess.run`). Isso confirma que a falha ocorreu no próprio processo/chamada do Hermes, não no wiring de skills, para essas 17 invocações.
- **Nenhuma saída bruta de modelo foi produzida.** `raw_profile_output` é sempre `{"state": "error", "error_code": "hermes_failed"}` — não há tese, direção, nem qualquer conteúdo cognitivo. O erro **impede totalmente** qualquer avaliação cognitiva para essas invocações — confirmado, não presumido.
- **O smoke foi genuinamente offline e não alterou estado operacional:** `mode: "offline"`, `authorized: false`, `orders_sent: 0` nas três execuções; nenhuma chamada ao gateway real ocorreu (o pacote usado é uma fixture estática local, `tests/fixtures/shadow_smoke_packet_v17.2.json`, com `snapshot_hash` propositalmente sintético `aaaa…aaaa`).

### O que a evidência NÃO permite determinar — e por quê, com precisão de código

**A causa exata externa (autenticação, rede, provedor, limite de chamadas, incompatibilidade de CLI) não pode ser determinada a partir desta evidência, porque o próprio código descarta a informação que a revelaria.**

Lido diretamente em `scripts/prac_live_ensemble.py:336-342`:

```python
try:
    stdout = completed.stdout.decode("utf-8", errors="strict")
    completed.stderr.decode("utf-8", errors="strict")   # decodificado e imediatamente descartado
except UnicodeDecodeError as exc:
    raise SafetyStopError("safety_stop:hermes_utf8_decode_failed") from exc
if completed.returncode:
    raise RunnerError("hermes_failed")                   # nem o returncode nem stdout/stderr são incluídos
```

Comparando com o **mesmo tipo de checagem em outros dois scripts do mesmo repositório**, que preservam exatamente a informação que falta aqui:

- `scripts/run-topstep-cycle.py:981`: `f"hermes_failed:{completed.returncode}:{detail[:400]}"`
- `scripts/evaluation_cognitive_replay.py:305`: `f"evaluation_hermes_failed:{completed.returncode}:{detail[:800]}"`

**O runner do ensemble é o único, entre os três, que não anexa o código de saída nem um trecho sanitizado de stdout/stderr ao erro.** Isso não é uma falha desta auditoria em investigar — é uma lacuna de instrumentação já existente no código, e é exatamente o "o que falta" que a tarefa pede para eu declarar: **para determinar a causa raiz real, é preciso primeiro corrigir `_invoke_hermes` para preservar `completed.returncode` e uma versão sanitizada de stdout/stderr no erro, e então reexecutar.**

### Achado que contradiz a alegação de reprodutibilidade total

O `report.md` afirma: *"all six profile invocations were classified as `provider_error:hermes_failed`"* nas três execuções. **Isso é impreciso.** Lendo os três arquivos `run.json`/`run-2.json`/`run-3.json` diretamente, encontrei que **17 de 18 invocações** (não 18/18) tiveram exatamente `provider_error:hermes_failed`. A 18ª — `structure`, na terceira execução (`run-3.json`) — teve um erro **diferente**:

```
provider_error:skill_preload_incomplete:loaded=topstep-observe-market,topstep-form-thesis;missing=topstep-setup-state,topstep-build-intent
```

Isso é o gate `require_hermes_preload()` (o mesmo mecanismo fail-closed auditado e aprovado ontem) capturando, ao vivo e sem intervenção, um carregamento **parcial e intermitente** de skills pelo próprio Hermes — duas das quatro skills declaradas de `structure` não foram carregadas desta vez, e o gate corretamente abortou antes de qualquer chamada ao modelo, exatamente como projetado. **Isto é evidência positiva de que o fail-closed funciona sob uma falha real e não planejada** (diferente dos meus testes sintéticos de ontem) — mas também prova que **as três execuções não são idênticas**, e sugere que a instabilidade pode ter uma componente de carregamento/preload do próprio Hermes, não apenas uma causa externa única e uniforme.

**Um arquivo `auth.lock` foi encontrado na raiz do checkout canônico (`glitch-topstep-hermes-profile/auth.lock`), modificado no mesmo minuto (`10:28`) das execuções do smoke.** Não li seu conteúdo (por restrição de credenciais). Sua existência e timing são **consistentes com** uma hipótese de autenticação/sessão do Hermes como fator contribuinte, mas **não constituem confirmação** — registro isso como hipótese não testada, não como causa confirmada.

### Classificação da causa

**Bloqueio externo, causa raiz indeterminada por falta de instrumentação — não um defeito de especialização, prompt ou wiring.** Consistente com a orientação da tarefa de não converter isso automaticamente em falha de especialização: **não converto**. O que falta especificamente para diagnosticar: (1) preservar `completed.returncode` e stdout/stderr sanitizado no erro do runner; (2) reexecutar; (3) se a causa for autenticação/sessão do Hermes, verificar o estado do `auth.lock` e da sessão do agente (sem que esta auditoria leia seu conteúdo).

## 5. Testes reexecutados

| Verificação | Comando/local | Resultado | Comparação com o alegado |
|---|---|---|---|
| Suíte completa do profile | `python -m unittest discover -s tests -p "test_*.py"` em `.runner-implementation-20260910/profile` (= `7f68b23`) | **732 testes, 1 falha, 10 skips** | Tarefa cita "732 testes aprovados e 8 skips esperados" — **a contagem total de 732 bate**, mas há **1 falha real** (`prompt_version_mismatch`, §3) que não é "aprovado", e **10 skips**, não 8. Ambas as divergências são novas achados desta reauditoria, não presentes na evidência declarada. |
| `npm run check` (gateway) | `.prac-operational-20260910/gateway` (commit `4943b326`, o checkout operacional real) | **658 testes, 657 passaram, 0 falharam, 1 skip** | Tarefa cita "667/667" — **não bate**. A contagem mais alta provavelmente vem da branch `codex/prompt-v17-2-paired` (`928ed96`), que modifica ~14 arquivos de teste do gateway incluindo adições — mas essa branch **não está checked out no diretório operacional**, então não pude reproduzir 667 a partir do checkout que de fato roda. Não fiz checkout da branch de pareamento para não me afastar do "checkout canônico" que a tarefa pede para eu auditar. |
| Wiring/fail-closed (`test_specialty_skill_wiring.py`) | `.runner-implementation-20260910/profile` | **7/7 `ok`** (reexecutado; agora presente e commitado em RUNNER, diferente de ontem quando só existia em CANON) | Confirma a alegação; e resolve a lacuna de governança que eu havia sinalizado ontem — RUNNER agora tem esta suíte. |
| `SHA256SUMS` / frozen-cohort | `test_sha256sums`, `test_verify_frozen_cohort` | **7/7 `ok`, ambos verdes** | **Corrige o P1 pendente de ontem** — os manifestos foram regenerados; nenhuma divergência de hash detectada agora. |
| Fixtures MNQ/MES/MCL — seleção vencedora | `tests.test_winning_multimarket_selection` | **`ModuleNotFoundError` — arquivo não existe mais em nenhum dos dois checkouts** | **Achado sério, não coberto pela tarefa nem pela evidência declarada.** Os 9 testes que eu havia descoberto e validado ontem (incluindo `test_winning_selection_matrix_mnq_mes_mcl`, que finalmente provava `SELECTION_INSTRUMENT=MES`/`MCL` vencendo) e as fixtures correspondentes (`multi01_comparison_ledger_win_mes.txt`, `_win_mcl.txt`, `_win_mnq.txt`, e os `.json` de pacote correspondentes) **não existem em nenhum lugar hoje, nem têm histórico git em nenhum dos dois repositórios.** Esse trabalho, que estava apenas não commitado em CANON ontem, foi **perdido** durante a reconciliação de histórico que trouxe CANON de volta à paridade com RUNNER. A função que ele testava (`scanner_contract.validate_selected_candidate_handoff`) continua no código — apenas a cobertura de teste específica desapareceu. |

## 6. Riscos de versionamento

1. **Confirmado, não apenas hipotético (ver §3):** manter o bump de `prompt_version` do lado do profile sem o gateway operacional correspondente cria incompatibilidade real e comprovada por teste, não apenas risco de "falsa equivalência" em replay futuro (que também continua existindo enquanto o gateway não for atualizado).
2. `report.md` cita um commit de profile (`5849e23…`) diferente do HEAD atual (`7f68b23`) — pequeno, mas é exatamente o tipo de desalinhamento que, acumulado, leva a atribuir uma saída à versão errada em auditorias futuras.
3. O hash de paired-contract `83992E...D8897A` citado na tarefa não foi localizado em nenhum artefato — se esse hash for usado em algum processo de release automatizado, ele está referenciando algo que não existe nos checkouts examinados.

## 7. Limites da conclusão (separados explicitamente, conforme pedido)

| Dimensão | Status |
|---|---|
| **Wiring comprovado** | Sim — reconfirmado hoje por leitura de código (inalterado desde ontem) e, adicionalmente, pela própria evidência do smoke, que mostra o gate de preload funcionando ao vivo sob uma falha real (run-3). |
| **Fail-closed comprovado** | Sim — tanto para skill ausente (testado ontem) quanto para skill parcialmente carregada pelo Hermes ao vivo (observado hoje, run-3, não planejado). |
| **Integração canônica comprovada** | Parcial. O profile está genuinamente sincronizado (CANON = RUNNER = `7f68b23`, git limpo) — isso é uma melhora real desde ontem. **O par gateway/profile não está integrado/compatível agora** (§3). |
| **Estabilidade do modelo** | **Não avaliável.** Zero saídas de modelo válidas nas 18 invocações do smoke; nenhuma tese cognitiva foi produzida. |
| **Especialização substantiva** | **Não avaliável, e não declarada como demonstrada**, conforme instruído — sem saída de modelo, não há texto para verificar uso de vocabulário FVG/RSI/etc. Permanece exatamente onde estava ontem: não comprovada. |
| **Multimercado por replay/fixture** | **Regrediu desde ontem** — a suíte que provava vitória de MES/MCL foi perdida (§5). A capacidade documentada (`validate_selected_candidate_handoff`) permanece no código, mas sem teste que a exercite com um vencedor não-MNQ. |
| **Capacidade live** | Zero, inalterado — nenhuma decisão `selected`, nenhuma ordem, nenhuma saída de modelo válida, em nenhuma evidência disponível até hoje. |

## 8. Próximo desbloqueio mínimo

1. **Bloqueador técnico imediato para qualquer nova tentativa de smoke render dados úteis:** instrumentar `scripts/prac_live_ensemble.py::_invoke_hermes` para preservar `completed.returncode` e uma versão sanitizada de stdout/stderr no erro `hermes_failed`, espelhando o padrão já usado em `run-topstep-cycle.py`/`evaluation_cognitive_replay.py`. Sem isso, qualquer repetição do smoke produzirá a mesma evidência não diagnosticável.
2. **Bloqueador de release:** aplicar `928ed96` (ou equivalente) ao checkout operacional do gateway, e então reexecutar `test_selected_intent_is_accepted_by_real_gateway_validator` para confirmar que o `prompt_version_mismatch` desaparece.
3. **Recuperação de cobertura:** recriar (e desta vez commitar, em RUNNER, não apenas em CANON) a suíte `test_winning_multimarket_selection.py` e suas fixtures — o trabalho já existiu e passou ontem; refazer é conhecido e de baixo risco.
4. Somente depois de 1–3: uma nova tentativa de smoke offline/shadow, com o erro instrumentado, para finalmente obter uma saída de modelo válida (ou um diagnóstico definitivo, caso o bloqueio seja externo/de autenticação).

## 9. Recomendação final

**`blocked`** para qualquer avanço além de investigação e correção de instrumentação — não porque algo esteja inseguro (todos os contadores de segurança permanecem `0` e o modo permanece offline/shadow em toda a evidência), mas porque **nenhuma das condições de promoção já exigidas nas duas auditorias anteriores foi adicionalmente satisfeita hoje, e duas novas lacunas concretas foram encontradas** (incompatibilidade real gateway/profile; perda da cobertura de teste multimercado). `needs-human-review` aplica-se em paralelo, especificamente para as duas questões de §3 e §6 do texto acima, que exigem uma decisão humana sobre processo de release e sobre como recuperar o trabalho perdido.

Como instruído: **não recomendo canary, overnight ou operação armada enquanto o erro `hermes_failed` impedir a avaliação das saídas especializadas** — e, adicionalmente, enquanto o par gateway/profile permanecer byte-incompatível como demonstrado em §3.

---

*Relatório gerado por reauditoria independente, somente leitura. Nenhum chain-of-thought privado da LLM foi solicitado. Nenhum overnight, canary, paper armado, sizing, gateway armado ou ordem real foi iniciado. Nenhum código, prompt, skill, contrato, ledger ou evidência foi alterado. Nenhuma credencial ou conteúdo de `.env`/`auth.lock` foi lido, copiado ou registrado.*
