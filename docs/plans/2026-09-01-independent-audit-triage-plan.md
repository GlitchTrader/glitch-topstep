# Plano de triagem e implementação — auditoria independente de 2026-09-01

**Fontes:** auditoria do gateway `b15434f6-738e-4b98-b78e-9fe43f7f6715` e auditoria do perfil Hermes `1af49622-10ac-4fa8-80e1-310974d51f34`.

**Objetivo:** separar defeitos reais, riscos condicionais, itens já resolvidos e sugestões de manutenção; entregar ao programador uma ordem segura de investigação, correção, testes e promoção.

**Regra de nomenclatura:** os rótulos C1–C4 dos relatórios de 01/09 não substituem os C1–C4 do plano de 25/08. Neste plano, os itens recebem IDs `IA-260901-*`.

**Stop line:** não promover operação autônoma armed enquanto `IA-260901-GW-01` estiver aberto, enquanto o loss-floor não tiver contrato/testes suficientes, ou enquanto a evidência de operação contínua e rollback não estiver atualizada. Não relaxar daily-capture entry lock, breakeven automático, TS-DATA-01 ou TS-MULTI-04.

## 1. Resultado da triagem

### Confirmados no checkout atual — prioridade imediata

| ID | Achado | Decisão |
|---|---|---|
| `IA-260901-GW-01` | EXIT parcial multi-tranche sem `target_intent_id` pode deixar brackets sobredimensionados | Corrigir antes de armed; rejeitar o caso ambíguo e exigir atribuição explícita. |
| `IA-260901-GW-02` | Nota de `daily_economics` contradiz o bloqueio real de novas entradas | Corrigir código e documentação como contrato de verdade; manter o bloqueio TS-AUTH-02. |
| `IA-260901-GW-03` | `GLITCH_HARD_LOSS_FLOOR_USD` aceita configuração sem contrato de sinal/magnitude suficientemente explícito | Definir invariantes de configuração, falhar rápido e adicionar testes; não inventar sizing. |
| `IA-260901-GW-04` | `/health` não autenticado expõe estado operacional detalhado | Separar liveness mínimo público de diagnóstico autenticado, ou autenticar tudo; preservar o consumidor legítimo do profile. |
| `IA-260901-GW-05` | `validateScaleIn` considera ordens não protetoras da conta inteira | Filtrar por conta e contrato; adicionar prova multi-instrumento sem liberar exposição simultânea. |
| `IA-260901-GW-06` | `evidence_outbox` mantém linhas aplicadas indefinidamente | Implementar retenção/compactação segura após confirmação aplicada; nunca remover pendentes. |

### Confirmados, mas não bloqueantes isoladamente

| ID | Achado | Decisão |
|---|---|---|
| `IA-260901-GW-07` | `/health` faz integrity check e agregações completas a cada chamada | Otimizar após benchmark; não remover sinais de integridade sem substituto observável. |
| `IA-260901-GW-08` | Migrações têm governança desigual entre stores SQLite | Unificar em etapa própria, com backup/replay e teste de banco existente. |
| `IA-260901-GW-09` | Falha de uma linha pode abortar lote de recuperação | Isolar falhas por item, mantendo estado terminal e evidência de cada falha. |
| `IA-260901-GW-10` | Falta de retry/backoff específico para `SQLITE_BUSY` | Projetar retry limitado somente para transações locais seguras; nunca aplicar retry cego a mutações ProjectX. |
| `IA-260901-GW-11` | Segunda validação de sessão após login pode transformar login válido em estado degradado | Confirmar o contrato do endpoint; remover a chamada redundante ou classificar a falha como não fatal, com teste de regressão. |
| `IA-260901-GW-12` | Camada ports/composição está incompleta | Decidir completar ou remover o scaffold; não fazer refatoração ampla junto dos fixes de risco. |

### Desatualizados, já cobertos ou mal classificados

| Achado do relatório | Veredito |
|---|---|
| Fórmula do loss-floor `express_funded_eod` | Não reproduzido no checkout atual. `src/risk/mll.ts` converte o floor para o mesmo referencial absoluto de `conservativeEquity`, e `tests/mll.test.ts` cobre o caso. Manter regressões e não reabrir sem novo contraexemplo. |
| Fila de identidade sem durabilidade/replay | Já há outbox SQLite, staging antes da fila, drenagem no bootstrap e retenção no shutdown conforme o ledger. Não reabrir o item original; investigar apenas gaps novos de boundedness/compactação. |
| `/health` sem alertas com hysteresis | O ledger registra implementação de `HealthAlertTracker` em 31/08. Verificar apenas se o relatório externo auditou commit anterior; não duplicar trabalho. |
| Ausência geral de rate limiting no gateway local | Defesa em profundidade de baixa prioridade para o modelo loopback/operador único; não colocar antes dos itens de proteção e verdade do contrato. |
| Construtor com muitos parâmetros, lockfile, logs e documentação menor | Backlog de manutenção, sem relação com promoção armed; agrupar depois da estabilização. |

### Achados do profile que exigem confirmação no repositório companion

O relatório do Hermes foi feito sobre o commit `a35e5b5`, não sobre este checkout. O programador deve primeiro confirmar cada referência no `glitch-topstep-hermes-profile` atual. Se confirmado, tratar assim:

1. `IA-260901-HP-01` — toolset padrão permissivo: tornar o default memory-only/sem ferramentas e passar toolsets explicitamente apenas nos invocadores autorizados; adicionar teste que fixe os argumentos CLI.
2. `IA-260901-HP-02` — patcher que edita o runtime Hermes: preferir correção upstream; até lá, tornar opt-in, verificar hash/versão esperada, manter backup recuperável e registrar claramente o raio de alcance.
3. `IA-260901-HP-03` — IDs vindos do gateway usados em caminhos: criar helper único de componente seguro ou usar digest; testar `../`, separadores Windows, nomes reservados, Unicode inesperado, vazio e tamanho excessivo em todos os pontos de escrita.
4. `IA-260901-HP-04` — validação de geometria em `MOVE_STOP`/`MOVE_TP` e faixa de entrada: adicionar defesa no profile, sem tratá-la como autoridade; o gateway continua sendo a validação final.
5. `IA-260901-HP-05` — corrida/preempção do `model_owner.lock`: reproduzir com barreira, PID reutilizado, saída durante grace period e concorrência wake/cron; preservar evidência de learning antes de preemptar.
6. `IA-260901-HP-06` — episódios retratados/não atribuíveis na promoção: excluir evidência inválida por padrão e registrar lacunas como unresolved.
7. `IA-260901-HP-07` — `guidance` sem estágio/evidência/rollback: colocar atrás do mesmo ciclo de governança do overlay ou torná-lo explicitamente advisory; nenhuma alteração cognitiva silenciosa por ciclo.
8. `IA-260901-HP-08` — rollback autoavaliado pelo modelo e frozen-cognition não conectado: usar regras determinísticas externas ao modelo, corpus congelado, holdout/shadow, canário e rollback predefinido.
9. `IA-260901-HP-09` — skills instaladas, pareamento v9 e runbooks: reconciliar manifesto/`SOUL.md`, remover referências vivas a v9 e separar histórico de procedimento atual.

## 2. Ordem de execução

### Fase 0 — contenção e confirmação

- Confirmar que o runtime em uso é shadow ou armed; se houver capital real, tratar `IA-260901-GW-01` como incidente de prioridade máxima.
- Preservar as alterações não relacionadas já presentes em `docs/evidence/PRAC-SOAK-2026-08-31/`; não limpar ou sobrescrever evidência do operador.
- Fixar os SHAs auditados e o SHA atual em cada ticket; o auditor externo leu versões diferentes do checkout atual.
- Criar uma tabela de mapeamento no ledger sem fechar itens existentes apenas por análise estática.

### Fase 1 — gateway: proteção e contrato verdadeiro

#### 1.1 EXIT parcial multi-tranche (`IA-260901-GW-01`)

Implementação:

- No caminho de EXIT, identificar quando há mais de uma tranche atribuível e a saída é parcial.
- Rejeitar antes de qualquer mutação quando faltar `target_intent_id`, com código estável `target_intent_id_required` ou novo código documentado.
- Manter EXIT total separado: ele não deve ser convertido acidentalmente em uma redução parcial ambígua.
- Para saída atribuída, validar quantidade restante da tranche, cancelar somente a proteção da tranche encerrada e preservar a proteção do survivor antes da ordem de redução.
- Confirmar que nenhuma ordem manual/estrangeira ou tranche de outro contrato seja tocada.

Testes obrigatórios:

- duas tranches + EXIT parcial por quantidade sem alvo → rejeição sem chamadas ProjectX;
- duas tranches + EXIT parcial por fração sem alvo → rejeição;
- duas tranches + EXIT parcial com alvo → saga de proteção/redução correta;
- EXIT total multi-tranche → comportamento atual explicitamente coberto;
- alvo inexistente, alvo já flat, quantidade acima do restante e falha no cancelamento;
- kill points da protected-reduction saga e replay/reconciliação.

Riscos/cuidados: não corrigir simplesmente chamando `cancelTrancheProtectionOrders` para qualquer EXIT sem alvo; isso pode cancelar proteção de uma tranche sobrevivente ou agir sobre a posição errada. Não alterar o bloqueio de daily capture nem o breakeven automático.

#### 1.2 Nota de daily capture (`IA-260901-GW-02`)

- Substituir a nota falsa por uma declaração que diga que o gateway aplica um bloqueio congelado de nova exposição quando o daily-capture lock está ativo.
- Alinhar `src/policy/daily-economics.ts`, `src/hermes/packet-builder.ts`, `docs/AUTHORITY.md`, `docs/GATEWAY-SPEC.md` e `.env.example`.
- Testar simultaneamente `execution.daily_capture_locked`, `supported_actions` sem ENTER e a nota correspondente.
- Não remover o lock para fazer o texto passar.

#### 1.3 Loss floor e configuração (`IA-260901-GW-03`)

- Documentar o referencial (floor absoluto versus equity absoluta), sinal esperado, faixa suportada e comportamento de valores ausentes.
- Para `operator_provided_floor`, falhar na inicialização em valor não finito e em valores fora da política definida; não aceitar um “floor” que silenciosamente aumente headroom.
- Adicionar testes de zero, negativo, magnitude extrema, valor ausente e cada loss model.
- Manter os testes atuais de `express_funded_eod` como proteção contra regressão; não alterar a fórmula sem um exemplo documentado de política Topstep que a exija.

#### 1.4 `/health` (`IA-260901-GW-04`)

- Inventariar consumidores: profile, console, scripts, preflight e operadores.
- Preferência: deixar público apenas um liveness mínimo, sem IDs, estado de execução, métricas detalhadas ou informação de ProjectX; exigir token para o diagnóstico completo.
- Testar loopback, host não-loopback, token ausente/incorreto, console e chamadas do profile.
- Atualizar README, GATEWAY-SPEC e runbook; não transmitir credenciais nem detalhes sensíveis em logs.

### Fase 2 — gateway: multi-instrumento, retenção e recuperação

- `IA-260901-GW-05`: filtrar ordens por `accountId` e `contractId` em `validateScaleIn`; provar que uma ordem não-protetora de outro contrato não bloqueia scale-in legítimo, mas uma ordem ambígua do contrato atual continua bloqueando. Não habilitar TS-MULTI-04.
- `IA-260901-GW-06`: adicionar política de retenção para linhas `applied`, com idade mínima, métricas de contagem/bytes e operação idempotente. Nunca podar `pending`, referências de recovery ou evidência necessária para auditoria/replay.
- `IA-260901-GW-07`: medir p50/p95/p99 de `/health` com bases pequenas e grandes; cachear ou desacoplar integrity check pesado com limite explícito, sem mascarar corrupção.
- `IA-260901-GW-08`: escolher uma autoridade de migração comum para as stores e testar upgrade de bancos existentes, restart no meio da migração e schema incompatível.
- `IA-260901-GW-09`: processar recuperação por item, registrar falha terminal daquele item e continuar os demais; testar uma linha malformada no início, meio e fim.
- `IA-260901-GW-10`: aplicar backoff somente a `SQLITE_BUSY` em transações locais; provar que não duplica ordens nem transforma falha ambígua ProjectX em retry.
- `IA-260901-GW-11`: testar login bem-sucedido + validate transitório, refresh concorrente e estado degraded; não remover a revalidação sem confirmar o contrato de expiração.

### Fase 3 — profile Hermes: autoridade, aprendizado e supply chain

Executar somente no repositório Python companion, em PRs separados do gateway. A ordem recomendada é `HP-01/03/05` (limites e concorrência), depois `HP-06/07/08` (governança de aprendizado), e por fim `HP-02/09` (distribuição, skills e documentação).

- O profile nunca recebe credenciais ProjectX e nunca faz mutação direta na ProjectX.
- Validações do profile são defesa de qualidade; a decisão final de risco, identidade, proteção, daily capture, lease e execução continua no gateway.
- Toda mudança que possa alterar prompt, guidance, overlay ou seleção deve registrar versão, evidência, decisão, estágio e rollback.
- Sem gate mínimo de confiança, quota de trades, NOTHING forçado por lag ou sizing derivado de forecast.

## 3. Verificação e gates

Para cada PR:

- gateway: `npm run check`;
- profile: `python -m unittest discover -s tests`;
- testes direcionados do item e fault matrix correspondente;
- revisão de diff contra as invariantes congeladas;
- atualização do ledger somente com evidência, PR/issue e SHA.

Após as correções:

1. Fault matrix pareada para EXIT multi-tranche, crash/recovery, SQLite indisponível, auth transitória e preempção Windows.
2. Soak de pelo menos 72h antes de confiar em operação autônoma contínua; observar heap, bytes das stores, profundidade de outbox, latência de `/health`, reconexões, recovery e divergências de alertas.
3. PRAC pós-merge com preflight, rollback ensaiado, evidência imutável e sign-off humano.
4. Atualizar `release/paired-contract.json` e a cópia do profile somente se o wire contract mudar; correções internas do profile/gateway não devem gerar bump artificial.
5. Só fechar itens depois de código, testes, fault matrix e documentação estarem coerentes. Não reabrir automaticamente itens já encerrados no ledger quando o relatório externo auditou um commit anterior.

## 4. Itens que não devem ser feitos agora

- Não reescrever o gateway inteiro, `service.ts` ou `coordinator.ts` durante os fixes de proteção.
- Não remover retry de leituras nem introduzir retry cego em mutações ProjectX.
- Não transformar lag, depth ausente ou desalinhamento em veto universal de entrada.
- Não habilitar exposição simultânea multi-instrumento.
- Não promover overlays/guidance por variável de ambiente que pule holdout, shadow ou canário.
- Não apagar histórico, patches ou evidências locais sem decisão explícita e registro de retenção.

## 5. Critério de conclusão

O pacote estará pronto para revisão do programador quando `IA-260901-GW-01` a `GW-06` tiverem comportamento testado e documentado, os itens `GW-07` a `GW-12` tiverem plano/issue próprio, e o profile tiver confirmação de versão atual para `HP-01` a `HP-09`. A auditoria externa será considerada insumo de triagem, não evidência de que qualquer correção foi aplicada ou de que o sistema está pronto para armed.
