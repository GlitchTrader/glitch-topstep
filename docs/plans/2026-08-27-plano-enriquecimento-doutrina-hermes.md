# Plano de implementação — enriquecimento da doutrina adaptativa do Hermes

## Objetivo

Enriquecer a capacidade de leitura contextual do Hermes sem transformar padrões, volatilidade, order flow ou comparação entre instrumentos em regras determinísticas de entrada, veto ou tamanho de posição.

A implementação deve preservar:

- autonomia de Hermes para formar teses;
- reavaliação independente a cada ciclo;
- `NOTHING` como decisão válida;
- ausência de gates baseados em confiança, indicador ou padrão;
- gateway como autoridade exclusiva de execução, risco e proteção;
- exposição simultânea entre instrumentos desabilitada;
- contrato `glitch.intent.v3` sem alteração nesta etapa.

## Escopo

As mudanças serão feitas principalmente no repositório `glitch-topstep-hermes-profile`.

Arquivos prioritários:

- `SOUL.md`
- `skills/topstep-market-scan/SKILL.md`
- `skills/topstep-build-intent/SKILL.md`
- `skills/orderflow-liquidity/SKILL.md`
- `skills/topstep-self-learning/SKILL.md`
- `skills/topstep-learning-loop/SKILL.md`

Não alterar o gateway para implementar estratégia. Nenhuma regra de seleção, sizing ou proteção deve ser codificada em `glitch-topstep`.

## Ajustes obrigatórios após revisão técnica

Esta não será uma alteração única das seis capacidades cognitivas. O plano será executado em incrementos pequenos, com comparação contra o baseline após cada incremento.

Restrições adicionais:

- estabelecer e medir um orçamento de prompt antes da primeira mudança;
- não aceitar crescimento relevante de `SOUL.md` e skills apenas por adicionar exemplos;
- preferir substituir instruções redundantes por instruções mais precisas;
- manter arquétipos em uma seção compacta ou skill específica, em vez de espalhá-los por todas as skills;
- separar avaliação por proxy de avaliação baseada em outcomes canônicos ricos;
- não promover overlays com base apenas em OHLC ou em `decision_regret` aproximado;
- tratar regime como evidência possivelmente errada, nunca como autoridade sobre o alvo;
- executar uma ou duas mudanças por vez e parar se houver regressão de proteção, EV ou `NOTHING`.

O perfil já possui outcomes canônicos e métricas de regret, mas a cronologia rica e authoritative de fills, MFE/MAE, alterações de proteção e first-touch ainda é uma dependência para conclusões fortes de aprendizado. Portanto, a Fase 7 começa em modo avaliativo limitado; promoção de doutrina exige evidência de qualidade compatível.

## Ordem de implementação

### Fase 0 — Preparação e baseline

Prioridade: P0/P1 — obrigatória antes das alterações cognitivas.

1. Registrar o trabalho no ledger do repositório de perfil.
2. Congelar a versão atual de `SOUL.md` e das skills relevantes.
3. Executar a suíte atual do perfil.
4. Separar os testes de seleção, comparação multi-instrumento, construção de intent, self-learning, order flow e regressão de `NOTHING`.
5. Criar casos cognitivos congelados de tendência, rotação, transição, rompimento aceito, rompimento falho, stop-run, reversão, dados ausentes, divergência MNQ/MES e volatilidade baixa/alta.

Expectativa: nenhuma mudança de comportamento será aceita sem comparação contra o baseline anterior.

### Fase 1 — Vocabulário de arquétipos

Prioridade: P1 — alto benefício e baixo risco.

Adicionar à doutrina um vocabulário descritivo, incluindo opening drive, VWAP reclaim, absorção em extremo, stop-run seguido de reversão, range extension com aceitação, failed breakout, failed failure, pullback reclaim, continuação na borda do range e exaustão em extremo.

Regras:

- arquétipo é hipótese descritiva, nunca gatilho;
- nenhum arquétipo autoriza entrada sozinho;
- ausência do nome do arquétipo não impede uma entrada;
- o sistema deve poder contradizer o arquétipo;
- o padrão deve ser descrito com localização, invalidação, espaço e horizonte;
- não criar pontuação fixa por padrão.

Critério de aceite: Hermes consegue descrever o arquétipo, explicar a evidência contrária e ainda escolher `ENTER_LONG`, `ENTER_SHORT` ou `NOTHING` sem depender do nome do padrão.

Limite de prompt: o vocabulário deve ser compacto, sem uma lista extensa de exemplos repetidos. O programador deve medir tokens/caracteres do prompt antes e depois; qualquer crescimento acima de 10% exige justificar qual texto redundante foi removido ou compactado.

Risco: a taxonomia pode fazer o modelo procurar padrões conhecidos mesmo quando a evidência é fraca.

Mitigação: exigir evidência contrária e proibir equivalentes a “padrão detectado, portanto entrada”.

### Fase 2 — Falha dupla e raciocínio de segunda ordem

Prioridade: P1.

Adicionar a noção de `failed failure`: uma continuação falha, surge uma reversão, a reversão também falha, e isso pode fortalecer a tese original quando estrutura, localização e espaço permanecem coerentes.

Regras:

- não inverter automaticamente a posição;
- não tratar a segunda falha como confirmação obrigatória;
- reavaliar localização, invalidação e objetivo;
- registrar se a segunda falha realmente mudou a qualidade da tese.

Critério de aceite: o sistema distingue entre falha dupla que reforça a tese, ruído sem valor direcional e nova estrutura que invalida ambas.

Risco: qualquer oscilação pode ser interpretada como “falha da falha”.

Mitigação: exigir mudança estrutural ou comportamental observável, não apenas dois candles opostos.

### Fase 3 — Stop sensível à volatilidade

Prioridade: P1 — importante para qualidade de execução, sem fórmula fixa.

Adicionar à doutrina:

> O stop deve ficar além da estrutura que invalida a tese e conter o ruído normal esperado do timeframe de entrada, usando ATR ou volatilidade realizada como referência auxiliar.

Regras:

- ATR é descrição de volatilidade, não distância automática;
- estrutura continua definindo a invalidação;
- não usar `stop = estrutura + X * ATR` como regra universal;
- não afastar o stop para fabricar expectativa positiva;
- o stop deve ser compatível com o horizonte de cinco a dez barras;
- a ausência de ATR não bloqueia automaticamente a decisão;
- o gateway mantém a validação final de risco e geometria.

Critérios de aceite:

- em baixa volatilidade, não criar stops artificialmente largos;
- em alta volatilidade, não usar stop estreito apenas para melhorar o reward/risk aparente;
- explicar o stop usando estrutura e ruído esperado;
- manter a decisão possível quando a volatilidade estiver incompleta.

Benefício esperado: menos stops prematuros e melhor coerência entre risco, horizonte e regime.

Risco: ATR virar um novo indicador-gatilho ou produzir stops excessivamente largos.

Mitigação: proibir multiplicadores fixos como regra normativa e exigir justificativa estrutural independente.

### Fase 4 — Alvo dependente do regime

Prioridade: P1 — alto benefício.

Formalizar que o regime influencia a seleção do objetivo, não apenas a disposição de participar.

Orientação:

- TREND: extensão estrutural, swing seguinte ou measured move;
- CHOP/rotação: borda oposta, retorno à referência ou objetivo mais curto;
- TRANSITION: objetivo condicional e menor confiança estrutural;
- quiet/volatile: adaptar espaço, velocidade e probabilidade de alcance.

Regras:

- regime não determina o alvo automaticamente;
- o objetivo deve continuar compatível com espaço real;
- não aceitar um alvo apenas porque é “típico” daquele regime;
- registrar a alternativa caso o regime mude;
- separar tese direcional de qualidade do trade.

Critério de aceite: cada entrada explica por que o alvo é coerente com regime, localização, horizonte, estrutura, risco e espaço restante.

Risco: criar uma tabela implícita “regime X sempre usa alvo Y”.

Mitigação: tratar as relações como hipóteses contextuais e exigir alternativa contrária.

Dependência adicional: o classificador atual de regime é heurístico e usa limiares gerais. Antes de dar influência adicional ao regime, avaliar sua estabilidade por instrumento e por volatilidade. Se a classificação for inconsistente, o regime deve ser marcado como incerto e perder influência sobre o alvo, sem bloquear a decisão.

Não é necessário transformar a Fase 4 em um projeto de ML. É suficiente adicionar validação offline, comparar o regime declarado com a trajetória observada e testar uma normalização por volatilidade apenas se os dados demonstrarem viés sistemático entre MNQ, MES e MCL/MCLE.

### Fase 5 — Order flow como desempate

Prioridade: P1, depois das fases anteriores.

O order flow poderá desempatar duas teses estruturalmente semelhantes, somente como evidência contextual.

Condições:

- localização semelhante;
- invalidação comparável;
- espaço e alvo comparáveis;
- qualidade de dados equivalente;
- nenhuma tese claramente superior por estrutura;
- order flow disponível e temporalmente válido.

Regras:

- não transformar delta em sinal;
- não criar bônus numérico;
- não usar ausência de order flow como veto;
- não usar DOM inconsistente como direção contrária;
- registrar por que o order flow desempata e quais hipóteses alternativas permanecem.

Critério de aceite: com teses estruturalmente diferentes, order flow não altera automaticamente a decisão; só influencia quando a comparação estiver essencialmente empatada.

Risco: “desempate” virar peso permanente para order flow.

Mitigação: manter justificativa textual, sem score, ranking fixo ou veto.

### Fase 6 — Divergência entre instrumentos em modo shadow

Prioridade: P1, condicionada à estabilidade de dados.

Não usar divergência intermercado imediatamente para autorizar, rejeitar ou ranquear trades.

Primeira implementação:

1. Descrever divergências entre MNQ, MES e MCL/MCLE quando houver dados comparáveis.
2. Manter a divergência como contexto da comparação.
3. Não atribuir bônus ou penalidade automática.
4. Não preencher ausência de confirmação como divergência.
5. Avaliar posteriormente em corpus congelado e shadow.

Pré-condição: fase D de alinhamento de dados autorizada e com evidência suficiente de sincronização e qualidade.

Não alterar ainda ranking quantitativo, contrato de comparação, admissão do gateway ou exposição simultânea.

Critério de aceite: a divergência aparece como hipótese contextual e pode ser descartada por Hermes; sozinha, não produz `NOTHING` nem seleciona instrumento.

Risco: defasagem temporal ou microestrutura diferente ser interpretada como divergência direcional.

Mitigação: exigir alinhamento temporal, qualidade equivalente e explicação alternativa.

### Fase 7 — Aprendizado e avaliação

Prioridade: P1/P2.

Para cada episódio, registrar arquétipo, evidência favorável e contrária, regime, volatilidade, stop, alvo, uso de order flow, eventual divergência, resultado, impacto da nova instrução e se ela foi útil, neutra ou prejudicial.

Regras de promoção:

- um episódio isolado não cria doutrina;
- exigir pelo menos dois grupos comparáveis em duas sessões;
- revisar contradições;
- separar tese de falha de execução;
- manter propostas em `proposed` ou `shadow` antes da ativação;
- toda promoção deve ter métrica e rollback.

Método de avaliação:

- testes determinísticos verificam formato, presença de campos, invariantes e ausência de gates proibidos;
- revisão humana do corpus verifica qualidade contextual e preservação da autonomia;
- um LLM-juiz pode ser usado como segunda opinião, nunca como único critério;
- cada julgamento deve usar uma rubrica versionada, com exemplos positivos, negativos e casos ambíguos;
- divergência entre revisão humana e LLM-juiz deve ser preservada para análise.

Níveis de evidência:

- `proxy`: OHLC, frames e `decision_regret`; serve para detectar regressões óbvias, não para promover doutrina;
- `canonical_thin`: outcome canônico sem cronologia completa; serve para execução e resultado básico;
- `canonical_rich`: fills, MFE/MAE, timestamps, geometria ativa, alterações e qualidade de evidência; necessário para conclusões fortes sobre stop, alvo e gestão.

Enquanto `canonical_rich` não estiver disponível para a pergunta avaliada, o resultado deve ser classificado como inconclusivo ou shadow.

Métricas:

- stop prematuro;
- alvo alcançado antes do stop;
- estabilidade por regime;
- regressão da taxa de `NOTHING`;
- aumento de entradas sem deterioração da proteção;
- qualidade da previsão, não apenas PnL.

### Fase 8 — Sizing adaptativo: adiar

Prioridade: P2/P3 — fora da primeira implementação.

Não usar `POSITIVE_ROBUST` ou `POSITIVE_THIN` para aumentar quantidade nesta etapa. Essas categorias são qualitativas e ainda não representam probabilidade calibrada.

Enquanto isso:

- `POSITIVE_ROBUST` pode justificar não reduzir a oportunidade ao mínimo por medo;
- nunca é motivo suficiente para aumentar posição;
- quantidade continua subordinada à geometria, capacidade e risco permitido.

Reconsiderar apenas após cronologia confiável, forecasts calibrados, evidência por regime e instrumento, governança de overlays, simulação de risco e aprovação explícita do operador.

## Regras de independência

Nenhuma alteração pode:

- criar entrada automática por reconhecimento de padrão;
- obrigar concordância entre timeframes;
- transformar ATR em stop fixo;
- transformar regime em alvo fixo;
- tornar order flow obrigatório;
- usar divergência como veto;
- aumentar tamanho por confiança subjetiva;
- substituir reavaliação atual por memória ou plano anterior;
- bloquear entradas por dados imperfeitos ainda utilizáveis;
- alterar proteção automática, daily capture ou autoridade do gateway;
- permitir exposição simultânea entre instrumentos.

A sequência permanece: observar, descrever, formar hipóteses long/short/flat, comparar invalidação/espaço/expectativa, selecionar ação, construir intent, deixar o gateway validar e aprender com o resultado.

## Entregáveis

1. Atualização de `SOUL.md`.
2. Atualização das skills de market scan, build intent, order flow e self-learning.
3. Corpus cognitivo congelado para regressão.
4. Testes de comportamento sem alteração do contrato de execução.
5. Registro no ledger do perfil.
6. Relatório comparando baseline e nova doutrina.
7. Overlays somente em modo `shadow` até haver evidência suficiente.
8. Relatório de orçamento de prompt e regressão cognitiva por incremento.
9. Rubrica versionada para revisão humana/LLM-juiz.
10. Matriz de qualidade de outcome usada em cada conclusão.

## Expectativas

Benefícios esperados:

- linguagem contextual mais rica;
- melhor distinção entre continuação, reversão e falha de reversão;
- stops mais coerentes com ruído;
- alvos mais adequados ao regime;
- uso mais útil do order flow;
- futura comparação intermercado mais informada;
- aprendizado mais explicável e auditável.

Não se deve esperar aumento garantido de PnL, maior frequência de trades, eliminação de perdas ou justificativa para aumentar exposição.

## Gate entre fases

Após cada fase, o trabalho só avança se:

- não houver regressão nas invariantes de proteção, contrato ou autoridade;
- o prompt permanecer dentro do orçamento aprovado;
- a qualidade média do corpus não cair além da margem definida na Fase 0;
- o aumento de `NOTHING` ou de entradas não indicar um novo gate disfarçado;
- o efeito da alteração puder ser atribuído separadamente das fases anteriores.

Se um gate falhar, manter a fase em `shadow`, compactar ou reverter a instrução e registrar a contradição no ledger.

## Critério final de sucesso

Hermes deve produzir análises mais ricas e específicas mantendo sua independência fundamental:

> padrões enriquecem a descrição; volatilidade melhora a geometria; regime orienta a avaliação do objetivo; order flow desempata apenas em casos próximos; divergência inicialmente informa; e nenhuma dessas fontes decide sozinha a ação, o risco ou o tamanho.
