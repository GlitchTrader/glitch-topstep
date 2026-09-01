# Plano de implementação — Banda cognitiva advisory no Intent v3

**Data:** 2026-08-28  
**Escopo:** gateway e Hermes profile  
**Objetivo:** reduzir rejeições causadas exclusivamente por drift fora da banda cognitiva, preservando a geometria executável e todas as barreiras de risco.

## 1. Decisão de arquitetura

entry_price_min/max continua obrigatório no Intent v3 e continua sendo preservado para auditoria, EV, aprendizado e diagnóstico de drift. Porém, deixa de ser um gate direto de entrega.

A entrada MARKET continua condicionada a:

- identidade de conta, instrumento, contrato, packet e scope;
- intent dentro do lease/expiry;
- quote válido conforme o comportamento atual;
- stop e target presentes, alinhados e protegidos;
- geometria válida contra a referência resolvida para execução;
- capacidade, hard-loss floor e demais validações de risco;
- daily-capture lock e outras proteções gateway-owned.

Não alterar quantidade, sizing, daily capture, breakeven automático, proteção, exposição simultânea ou autoridade do gateway.

Não alterar o wire schema de glitch.intent.v3 e não fazer bump do contrato pareado, salvo se novos campos forem adicionados ao wire.

## 2. Decisões fechadas

### A — Banda conter o preço decisório

Não adicionar enforcement runtime de min <= decision_reference <= max nesta PR.

A cognição continua instruída a produzir uma banda que contenha o preço decisório, mas a entrega será decidida pela geometria atual. Enforcement adicional da banda na cognição fica fora deste escopo.

### B — Bid/ask ausente

Preservar o fallback atual para decision_reference_price quando bid/ask não estiver disponível. Cobrir esse comportamento com teste e telemetria explícita de fallback.

Não transformar a ausência de BBO em nova rejeição nesta PR.

### C — Distância fora da banda

Registrar distância em pontos, não em ticks. entry_delivery.py não recebe tick_size atualmente. Ticks ficam para uma mudança posterior.

### D — Shadow/Sim

Shadow/Sim significa observabilidade pós-deploy, sem dois caminhos de decisão e sem feature flag paralela que mantenha o gate antigo.

## 3. Repositórios

Gateway:

C:\Users\arifr\Projects\glitch-topstep

Profile:

C:\Users\arifr\Projects\glitch-topstep-hermes-profile

O gateway permanece responsável por risco, geometria executável e rejeições. O profile permanece responsável por revalidação de entrega, outbox, descarte e telemetria local.

## 4. Profile — revalidação de entrega

Arquivo:

C:\Users\arifr\Projects\glitch-topstep-hermes-profile\scripts\entry_delivery.py

Atualizar evaluate_entry_revalidation() para:

1. manter validação de banda, stop e target;
2. calcular range_valid pela referência decisória;
3. calcular geometry_valid pela referência decisória;
4. calcular geometry_valid_executable pela referência executável;
5. permitir entrega quando geometry_valid_executable for verdadeiro, mesmo com range_valid=false;
6. rejeitar quando a geometria executável for inválida.

Preservar no resultado decision_reference_price, executable_reference_price, entry_price_min/max, range_valid, geometry_valid, geometry_valid_executable e delivery_allowed.

Manter o vocabulário do schema local glitch.topstep.entry_revalidation.v1:

- status=accepted quando a entrega for permitida;
- status=superseded quando a geometria live impedir a entrega;
- reason=cognitive_band_breach_allowed quando a entrega for permitida fora da banda;
- reason=entry_geometry_invalid_at_latest_price quando a geometria live falhar.

Não trocar o status para rejected nesta PR.

Registrar, quando possível, cognitive_band_breach, cognitive_band_breach_direction, cognitive_band_distance_points e reference_source.

Classificar o drift:

- LONG abaixo da banda: favorável;
- LONG acima da banda: potencialmente adverso;
- SHORT acima da banda: favorável;
- SHORT abaixo da banda: potencialmente adverso.

Ambos os lados podem ser permitidos se a geometria executável continuar válida, mas devem ser distinguidos na auditoria.

Atualizar assert_entry_delivery_allowed() para lançar entry_geometry_invalid_at_latest_price quando a entrega não for permitida. Manter entry_range_superseded apenas para replay e compatibilidade histórica.

Manter prepare_intent_for_delivery() removendo entry_revalidation antes do POST. A telemetria deve ser emitida em events.jsonl, não depender do payload enviado ao gateway.

## 5. Gateway — remoção do gate de faixa

Arquivo:

C:\Users\arifr\Projects\glitch-topstep\src\risk\risk-engine.ts

Remover somente o bloqueio que rejeita Intent v3 quando a referência decisória está fora de entryPriceMin/max.

Manter campos de faixa obrigatórios, rejeição de faixa ausente ou invertida, expiry, identidade, scope, contract checks, daily capture, quote freshness, capacidade e hard-loss floor.

## 6. Gateway — geometria executável explícita

Depois de resolveExecutableReferencePrice(), validar:

- LONG: stopLoss < referencePrice < takeProfit;
- SHORT: takeProfit < referencePrice < stopLoss.

Quando falhar, lançar entry_geometry_invalid_at_latest_price, incluindo no detalhe a referência, stop e target. A checagem deve ocorrer antes de calculateBracketTicks().

Preservar calculateBracketTicks() para conversão conservadora em ticks e cálculo do risco protegido real.

Não alterar o fallback atual de resolveExecutableReferencePrice() nesta PR.

## 7. Outbox e descarte

Arquivos:

- C:\Users\arifr\Projects\glitch-topstep-hermes-profile\scripts\parity.py;
- C:\Users\arifr\Projects\glitch-topstep-hermes-profile\scripts\workflows\intent_outbox.py.

Adicionar entry_geometry_invalid_at_latest_price a ENTRY_GEOMETRY_ERRORS e SUPERSESSION_DELIVERY_ERRORS.

Manter entry_range_superseded somente para eventos e receipts históricos.

Regras:

- fora da banda + geometria válida: não descartar outbox;
- geometria live inválida: descartar com entry_geometry_invalid_at_latest_price;
- packet expirado, packet superseded ou scope inválido: usar o receipt gate atual;
- nunca descartar quando houver ambiguidade de entrega.

Atualizar a docstring de discard_unexecutable_entry_outbox() para não dizer que a faixa congelada é exigida.

O evento de descarte permanece intent_discarded_geometry_invalid, com reason explícito.

## 8. Fixtures

Revisar:

C:\Users\arifr\Projects\glitch-topstep-hermes-profile\tests\fixtures\projectx\live\r1_04_kill_matrix_proof.json

O fixture atual fresh_packet_outside_range, com ask=21050.25 e take_profit_1=21040, tem geometria LONG inválida. Deve continuar rejeitado, agora com entry_geometry_invalid_at_latest_price.

Adicionar cenário separado de breach permitido:

- banda: 20990–21010;
- stop: 20970;
- target: 21040;
- ask: 21020.

Esse cenário está fora da banda, mas mantém geometria LONG válida.

Como o kill matrix é evidência live gravada, regravar a prova com o comportamento novo ou marcar explicitamente o caso antigo como histórico e adicionar uma prova pós-mudança.

## 9. Testes do profile

Atualizar tests/test_entry_delivery.py e tests/test_paired_contracts.py.

Cobrir:

1. LONG fora da banda, mas entre stop e target: permitido;
2. SHORT fora da banda, mas entre target e stop: permitido;
3. LONG acima do target: erro entry_geometry_invalid_at_latest_price;
4. SHORT abaixo do target: erro entry_geometry_invalid_at_latest_price;
5. preço exatamente sobre stop ou target: rejeitado;
6. bid/ask ausente: fallback atual documentado;
7. referência fallback identificada na telemetria;
8. banda ausente, invertida ou inválida: rejeitada;
9. entry_range_superseded não emitido para breach permitido;
10. separação entre breach cognitivo, geometria inválida e packet/intent superseded.

## 10. Testes do gateway

Atualizar tests/risk-engine.test.ts.

Adicionar:

1. Intent v3 fora da banda, geometria válida: sucesso;
2. LONG acima da banda e abaixo do target: sucesso;
3. LONG acima do target: entry_geometry_invalid_at_latest_price;
4. SHORT abaixo da banda e acima do target: sucesso;
5. SHORT abaixo do target: entry_geometry_invalid_at_latest_price;
6. faixa ausente: entry_price_range_missing;
7. faixa invertida: entry_price_range_invalid;
8. fallback existente quando BBO não está disponível;
9. paridade profile/gateway com o mesmo intent e quote.

Confirmar regressão zero em daily capture, automatic breakeven, freshness, expiry, identidade, scope, capacidade, hard-loss floor, tick alignment, protected MARKET entry e single-exposure admission.

## 11. Telemetria

Como entry_revalidation não vai no wire, registrar em events.jsonl:

- referências decisória e executável;
- limites da banda;
- range_valid;
- geometry_valid;
- geometry_valid_executable;
- breach, direção e distância em pontos;
- fonte da referência;
- delivery_allowed;
- código de rejeição.

Métricas do soak:

- rejeições entry_range_superseded;
- entradas permitidas fora da banda;
- rejeições por geometria live;
- distância média fora da banda;
- drift favorável versus adverso;
- MFE/MAE e stop/target das entradas fora da banda.

MFE/MAE é métrica de soak, não bloqueio da PR.

## 12. Documentação

Atualizar:

- docs/OPERATIONS.md no profile;
- docs/specs/GTHP-033.md;
- comentários em scripts/run-topstep-cycle.py;
- docs/ledger/ledger.json nos dois repositórios quando o trabalho for concluído.

Texto a preservar:

> entry_price_min/max representa a zona cognitiva de EV da decisão. A entrega MARKET é autorizada somente quando a geometria stop/target permanece válida contra a referência atual de execução e todas as validações independentes do gateway passam.

## 13. Ordem de execução

1. Implementar e testar entry_delivery.py.
2. Atualizar erros, outbox e docstrings do profile.
3. Remover o gate de faixa do gateway.
4. Adicionar rejeição explícita de geometria live.
5. Atualizar fixtures e testes pareados.
6. Adicionar telemetria em events.jsonl.
7. Atualizar documentação.
8. Executar checks completos.
9. Rodar PRAC não armado e soak.
10. Revisar métricas antes de promoção.

## 14. Checks obrigatórios

Gateway:

npm run check

Profile:

python -m unittest discover -s tests

Executar também:

- tests/paired-compatibility.test.ts;
- tests/test_paired_contracts.py.

Se scripts do profile forem alterados, regenerar SHA256SUMS.

## 15. Rollout e aceite

Primeiro executar testes locais, depois PRAC não armado e soak.

Antes de promoção, confirmar:

- nenhuma entrada sem geometria válida;
- nenhuma entrada com quote inválido;
- nenhuma regressão de hard-loss-floor;
- nenhuma regressão de daily capture ou breakeven;
- nenhuma duplicação;
- redução mensurável de entry_range_superseded;
- paridade profile/gateway;
- telemetria suficiente para comparar entradas dentro e fora da banda.

A promoção armada permanece bloqueada até a revisão operacional do soak.

## 16. Fora do escopo

- aumentar GLITCH_PACKET_LEASE_MS;
- reduzir latência do Hermes;
- remover a banda do Intent v3;
- impor largura mínima da banda;
- sizing baseado em distância fora da banda;
- gates de confiança da LLM;
- wake triggers;
- exposição simultânea;
- alterações em daily capture ou automatic breakeven;
- alteração da autoridade do gateway;
- transformar ausência de BBO em nova rejeição.
