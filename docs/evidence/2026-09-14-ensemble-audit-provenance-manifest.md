# Hermes Ensemble — manifesto de proveniência documental

Data do manifesto: 2026-09-14

## Escopo e canonicalidade

Este pacote é documental. O HEAD de referência do gateway é `main` em
`92780bc72b8f36b5dd34508a49714fd3099cc022`. O plano
`2026-09-01-hermes-ensemble-implementation-plan.md` é externo e não está
versionado neste repositório.

Os arquivos abaixo foram recuperados sem alteração de conteúdo. A origem
verificável é o worktree `C:\Users\arifr\Projects\glitch-topstep\.claude\worktrees\prac-extended-soak-audit-b69a3a`,
branch `claude/prac-extended-soak-audit-b69a3a`, em que os nove arquivos
permaneciam como `untracked`; o HEAD do worktree era
`f0bf4f49fdbfc432df8ede4d7c801a377a09c213`. O commit não continha esses nove
relatórios. Cada arquivo também existia no checkout de trabalho do gateway como
cópia não rastreada, com o mesmo hash.

## Relatórios preservados

| Arquivo | SHA-256 | Criado UTC | Modificado UTC | Classificação | Escopo probatório | Relação conhecida |
|---|---|---|---|---|---|---|
| `docs/evidence/COGNITION-AGGREGATION-CONTRACT-REPAIR-AUDIT-20260910/audit-report.md` | `D30B6624782C225925CB3F41232A449DCD2E8B97BA2EABFAA40DFF53AC6FB136` | `2026-09-10T23:35:22Z` | `2026-09-10T23:35:22Z` | relatório/evidência | offline/reauditoria | agregação, identidade, quantidade, veto adversarial e determinismo |
| `docs/evidence/COGNITION-DECISION-AUDIT-20260910/audit-report.md` | `1778CD4CB3E705086743BF001E1E6EF30E13EC551042DEFB17D440B07BA3AD04` | `2026-09-10T23:10:13Z` | `2026-09-10T23:10:13Z` | relatório/evidência | offline/reauditoria | decisões do ensemble, envelopes, objeções e consenso |
| `docs/evidence/LLM-PROMPT-QUALITY-AUDIT-20260910/audit-report.md` | `9F2ED6FE2C0FB3627059D78DC3E7E9B890349611286B846033564E6AA30224B3` | `2026-09-10T23:00:41Z` | `2026-09-10T23:00:41Z` | relatório/evidência | offline/reauditoria | montagem de prompt, skills e compatibilidade de intent |
| `docs/evidence/NORMALIZATION-REPAIR-AUDIT-20260910/audit-report.md` | `9EECF12CE5B3DF74D07245F4970C8F97E60BE4A688D2CFA8AE781CA4D7E2FC23` | `2026-09-10T22:37:18Z` | `2026-09-10T22:37:23Z` | relatório/evidência | offline/reprodução independente | normalização de thesis/reason; testes registrados no relatório |
| `docs/evidence/PRAC-EXTENDED-AUDIT-20260910-4e7a1c6d2f48a0b5e3c7f9d1a6b8e2/audit-report.md` | `F5B5B75A460298801317AEB7AF854982E9B87D807DFE3688D2B6C55582E85C94` | `2026-09-10T22:00:55Z` | `2026-09-10T22:00:55Z` | relatório/evidência | PRAC extended, não live conclusivo | estabilidade, global_nothing e cobertura de execução |
| `docs/evidence/PROMPT-REGRESSION-MULTIMARKET-AUDIT-20260910/audit-report.md` | `81CE8E03E0E0C4A4FE5FAE3062828445F71B44B944BE5F1D604A36C2D258E167` | `2026-09-11T02:41:45Z` | `2026-09-11T02:41:45Z` | relatório/evidência | offline/avaliação multimercado | prompt, timeout, missing evidence e MNQ/MES/MCL |
| `docs/evidence/SHADOW-SMOKE-HERMES-FAILED-REAUDIT-20260911/audit-report.md` | `D89627CCB8054C89A6100943FE22A9D574DB109FACC28119A18ABCDD250E8877` | `2026-09-11T14:43:53Z` | `2026-09-11T14:43:53Z` | relatório/evidência | shadow smoke falho | provider_error:hermes_failed e limites da conclusão |
| `docs/evidence/SHADOW-SMOKE-R2-FINAL-REAUDIT-20260911/audit-report.md` | `FE2436C2F31C030CE6C63B153652D97CB7A25A37603C784750BEA7EB48D91878` | `2026-09-11T15:15:09Z` | `2026-09-11T15:15:09Z` | relatório/evidência | shadow smoke r2 | causa raiz do provider e regressões não comprovadas |
| `docs/evidence/SKILL-WIRING-PROMOTION-REAUDIT-20260911/audit-report.md` | `2C5AB5A0511B322FBF5D2980497936AAD0333CB8D6D415E7121FE5AEF9AC6741` | `2026-09-11T13:48:04Z` | `2026-09-11T13:48:04Z` | relatório/evidência | shadow/reauditoria | wiring, especialização e ausência de MES/MCL live |

## Limitações e exclusões

- Os relatórios não provam execução live MES/MCL; essa capacidade permanece não verificada.
- `overnight` permanece bloqueado.
- Shadow e avaliação permanecem separados da production lane.
- Nenhum relatório deve ser interpretado como autorização de produção, sizing por consenso ou promoção automática.
- Não fazem parte deste pacote bancos, WAL/SHM, locks, caches, tokens, credenciais, `.env`, `auth.json`, `parallel_slots`, runtime ou logs não revisados.
- A cópia `untracked` no worktree de origem e a cópia deste pacote têm o mesmo hash; somente uma cópia será preservada após revisão humana.

## Segurança

Os nove relatórios foram verificados contra padrões de tokens, chaves, bearer tokens,
senhas e credenciais conhecidas; nenhum padrão suspeito foi encontrado. Esta
verificação não autoriza a inclusão de outros artefatos do diretório de evidências.
