# ProjectX Gateway API (TopstepX) — referência verificada

**Levantado em:** 31 de julho de 2026
**Base URL REST (TopstepX):** `https://api.topstepx.com`
**Hubs SignalR (TopstepX):** `https://rtc.topstepx.com/hubs/user` e `.../hubs/market`

## Níveis de confiança usados neste documento

| Marca | Significado |
|-------|-------------|
| **[DOC]** | Está na documentação oficial `gateway.docs.projectx.com` |
| **[LIVE]** | Observado em payloads reais gravados por este projeto (`data/projectx-evidence.sqlite`, conta 26060225, MNQU26, 30–31 jul 2026) |
| **[COM]** | Fonte de comunidade / SDK terceiro (menor autoridade) |
| **[NÃO CONFIRMADO]** | Não encontrei fonte — **não presuma** |

> Aviso importante: a doc oficial tem **duas versões vivas** com conteúdo divergente:
> `/docs/...` (atual, `api.topstepx.com`) e `/docs/intro/...` (legado, `gateway-api-demo.s2f.projectx.com`).
> A versão legado documenta `linkedOrderId` e **não** documenta brackets; a atual documenta brackets e **não** documenta `linkedOrderId`. Ver §1.

---

## 1. Colocação de ordens — `POST /api/Order/place`

### Campos aceitos **[DOC]**

Fonte: <https://gateway.docs.projectx.com/docs/api-reference/order/order-place>

| Campo | Tipo | Obrig. | Nullable | Observação |
|-------|------|--------|----------|------------|
| `accountId` | integer | sim | não | |
| `contractId` | string | sim | não | ex.: `CON.F.US.MNQ.U26` |
| `type` | integer | sim | não | `1`=Limit, `2`=Market, `4`=Stop, `5`=TrailingStop, `6`=JoinBid, `7`=JoinAsk |
| `side` | integer | sim | não | `0`=Bid (compra), `1`=Ask (venda) |
| `size` | integer | sim | não | |
| `limitPrice` | decimal | não | sim | preço **absoluto** |
| `stopPrice` | decimal | não | sim | preço **absoluto** |
| `trailPrice` | decimal | não | sim | ver §1.3 |
| `customTag` | string | não | sim | **"Must be unique across the account"** |
| `stopLossBracket` | object | não | sim | `{ ticks: integer, type: integer }` |
| `takeProfitBracket` | object | não | sim | `{ ticks: integer, type: integer }` |

Resposta: `{ "orderId": 9056, "success": true, "errorCode": 0, "errorMessage": null }`

Note que `type` na doc atual **omite `3` = StopLimit**, mas o enum `OrderType` publicado na página de realtime inclui `StopLimit = 3` **[DOC]** (<https://gateway.docs.projectx.com/docs/realtime/>). Enum completo:

```cs
public enum OrderType { Unknown=0, Limit=1, Market=2, StopLimit=3, Stop=4, TrailingStop=5, JoinBid=6, JoinAsk=7 }
```

### 1.1 Formato dos brackets: **TICKS, distância relativa** — não preço absoluto **[DOC]** + **[LIVE]**

`stopLossBracket.ticks` / `takeProfitBracket.ticks` são **número de ticks de distância** do preço de entrada. O `type` interno usa o mesmo enum `OrderType` (na prática: `4`=Stop para o SL, `1`=Limit para o TP).

Exemplo oficial **[DOC]**:

```json
{
  "accountId": 465, "contractId": "CON.F.US.DA6.M25",
  "type": 2, "side": 1, "size": 1,
  "stopLossBracket": { "ticks": 10, "type": 4 },
  "takeProfitBracket": { "ticks": 20, "type": 1 }
}
```

**Confirmação por payload real [LIVE]:** para uma entrada SHORT em MNQ (tick 0,25) o gateway ecoou nos filhos `trailDistance: 101` / `trailPrice: 25.25` no SL e `trailDistance: -99` / `trailPrice: -24.75` no TP. Ou seja `trailDistance` é a **distância em ticks** e `trailPrice` a mesma distância em **unidades de preço** (101 × 0,25 = 25,25). Isso prova que o gateway armazena o bracket como distância relativa, não como preço.

**Sinal dos ticks:** o projeto envia ticks **assinados** relativos ao lado da entrada (`src/execution/brackets.ts:44-52` — long: stop negativo/target positivo; short: stop positivo/target negativo) e os valores voltam com exatamente esses sinais no stream. **[NÃO CONFIRMADO]:** se enviar ticks **sem sinal** (sempre positivos) funciona igual, é rejeitado, ou coloca a perna no lado errado. A doc só diz "Number of ticks", sem falar de sinal. Não mude essa convenção sem teste em PRAC.

### 1.2 `customTag`

- **[DOC]** Opcional, string, **precisa ser único na conta**.
- **[LIVE]** É retornado em: stream `GatewayUserOrder`, `POST /api/Order/searchOpen`, `POST /api/Order/search`. Retenção confirmada em todas as três superfícies.
- **[LIVE]** Não aparece no payload de `GatewayUserTrade` — a ligação trade→ordem é só via `orderId`.

### 1.3 `trailPrice`

- **[DOC]** "The trail price for the order, if applicable" — aceito em `place` e em `modify`. Aplica-se a `type: 5` (TrailingStop).
- **[NÃO CONFIRMADO]:** se `trailPrice` é distância ou preço absoluto no **request**. A doc não diz. **[LIVE]** no *response*/stream ele carrega distância (ver §1.1), o que sugere distância, mas isso é o eco de um bracket, não um trailing stop enviado por mim. O projeto nunca enviou `type: 5` em produção.

### 1.4 `linkedOrderId`

- **[DOC legado]** `linkedOrderId: integer (Optional, nullable) — The linked order id`, presente em <https://gateway.docs.projectx.com/docs/intro/api-reference/order/order-place>.
- **[DOC atual]** **ausente** da tabela de parâmetros de `/api/Order/place`.
- **[COM]** o SDK Python `project-x-py` expõe `place_order(..., linked_order_id=None)` descrito como "ID of a linked order for OCO relationships" (<https://project-x-py.readthedocs.io/en/latest/api/trading.html>).
- **[LIVE]** o campo **existe na resposta** — chega no stream de ordens (ver §2).
- **[NÃO CONFIRMADO]:** se `linkedOrderId` no *request* ainda é honrado pelo TopstepX hoje, e qual a semântica exata (OCO manual entre duas ordens minhas?). Nunca foi exercitado por este projeto.

---

## 2. Brackets / OCO — comportamento real **[LIVE]**

Esta é a parte onde a doc oficial é **silente** e onde os payloads gravados dão a resposta. Todos os fatos abaixo vêm do stream `GatewayUserOrder` real.

### 2.1 As ordens filhas são criadas IMEDIATAMENTE, não após o fill

Timeline real de uma entrada MARKET SHORT com bracket (`data/projectx-evidence.sqlite`, seq 10593995–10594003, 2026-07-31T02:23:34Z):

| seq | t (recebido) | orderId | customTag | type | side | status | limitPrice | stopPrice |
|-----|--------------|---------|-----------|------|------|--------|-----------|-----------|
| 10593995 | 02:23:34.589 | 3345169272 | `glt-4f7c…-SL` | 4 | 0 | **8** | – | – |
| 10593996 | 02:23:34.589 | 3345169271 | `glt-4f7c…` (entrada) | 2 | 1 | **6** | – | – |
| 10593997 | 02:23:34.589 | 3345169273 | `glt-4f7c…-TP` | 1 | 0 | **8** | – | – |
| 10593998 | 02:23:34.597 | 3345169271 | entrada | 2 | 1 | **2** (Filled) | – | – |
| 10594002 | 02:23:34.615 | 3345169273 | `…-TP` | 1 | 0 | **1** (Open) | **28393** | – |
| 10594003 | 02:23:34.616 | 3345169272 | `…-SL` | 4 | 0 | **1** (Open) | – | **28443** |

Leitura:

1. Os três `orderId` são alocados no **mesmo instante** (`creationTimestamp` idêntico nos três) e chegam no mesmo lote do stream — **antes** do fill.
2. Os filhos nascem com **`status: 8`** (suspenso — ver §4) e **sem preço** (`limitPrice`/`stopPrice` ausentes).
3. Só **depois** do fill da entrada (`status: 2`) os filhos viram `status: 1` (Open) e **ganham preço absoluto**, calculado a partir dos ticks + preço de fill.

Isso confirma, com payload, a descrição do "Auto-OCO Bracket" da Tradesyncer **[COM]**: "Brackets are created as suspended orders and become working orders once the entry fills" (<https://help.tradesyncer.com/en/articles/11746420-projectx-bracket-orders-explained-position-brackets-vs-auto-oco-brackets>).

### 2.2 Os filhos herdam o `customTag` do pai com sufixo `-SL` / `-TP` **[LIVE]**

O cliente envia **uma** ordem, com `customTag = glt-<intentId>`. Voltam **três** ordens: a entrada com a tag exata, e os filhos com `<tag do pai>-SL` e `<tag do pai>-TP`. Verificado em dezenas de famílias distintas no banco de evidências, incluindo com um prefixo diferente (`glitch-topstep:manual-short-test-…-SL`), o que descarta ser uma convenção do cliente.

Consequência prática: se o seu `customTag` passar de ~60 caracteres, o sufixo pode truncar o identificador. O projeto já protege isso (`src/ownership/protection.ts:29-32` limita a base a 60 chars).

### 2.3 `parentOrderId` e `linkedOrderId` nos filhos **[LIVE]**

Campos presentes no payload de stream, **ausentes de toda a documentação oficial**:

| Campo | Na entrada | No filho SL | No filho TP |
|-------|-----------|-------------|-------------|
| `parentOrderId` | ausente | = orderId da entrada | = orderId da entrada |
| `linkedOrderId` | ausente | **ausente** | = orderId do **irmão (SL)** |
| `trailDistance` | ausente | ticks assinados | ticks assinados |
| `trailPrice` | ausente | distância em preço | distância em preço |

Contagem sobre 900 eventos de ordem recentes: `parentOrderId` presente em **100%** dos eventos de filhos (type 1 e type 4 com sufixo) e ausente em **100%** dos eventos de entrada (type 2). `linkedOrderId` só no TP.

### 2.4 Como identificar os filhos de forma confiável

Em ordem de robustez:

1. **`parentOrderId` == orderId da entrada** — é a relação explícita do provider. É o sinal mais forte, mas **só existe no stream SignalR** (ver §5.3 e Divergências).
2. **`customTag` == `<tag da entrada>-SL` / `-TP`** — funciona em stream **e** em REST (`searchOpen` e `search`), é o que o projeto usa hoje (`src/ownership/protection.ts:46-62`), e depende de você ter enviado um `customTag` na entrada.
3. `type` + `side` oposto + `size` — heurística; **não use como prova de propriedade**.

O `linkedOrderId` do TP é útil para achar o irmão SL, mas é unidirecional (o SL não aponta para o TP).

---

## 3. Auto-OCO da conta vs brackets explícitos

### 3.1 São dois modos mutuamente exclusivos **[COM]** + **[LIVE, indireto]**

O TopstepX tem duas features de bracket **na conta** (<https://help.tradesyncer.com/en/articles/11746420-…>) **[COM]**:

| | Position Brackets (antigo) | Auto-OCO Brackets (novo) |
|---|---|---|
| Vinculado a | posição agregada | ordem de entrada individual |
| Unidade | apenas **dólares** | ticks **ou** dólares |
| Quando cria | após o fill da posição | como ordens **suspensas** junto da entrada |
| Quantidade | um TP e um SL por posição | um par por entrada |
| Ajuste | acompanha a posição automaticamente | fixo por entrada |

**Interação com brackets enviados na API:** se **Position Brackets** estiver ativo na conta, `stopLossBracket`/`takeProfitBracket` no `place` são **rejeitados**. O erro observado por este projeto é literalmente `Brackets cannot be used with Position Brackets` (registrado em `docs/PARITY.md:119`). Portanto: **para usar brackets via API é obrigatório ter Auto-OCO Brackets habilitado na conta e Position Brackets desabilitado.**

### 3.2 As ordens criadas pelo Auto-OCO têm `customTag`?

- **Quando você envia `stopLossBracket`/`takeProfitBracket` com um `customTag` na entrada: SIM** — herdam com sufixo `-SL`/`-TP` (§2.2) **[LIVE]**.
- **Quando você envia os brackets sem `customTag` na entrada:** **[NÃO CONFIRMADO]**. Não há evidência gravada (o projeto sempre envia tag). O comportamento provável é `customTag: null` nos filhos, mas não confirmei.
- **Quando a proteção é criada pelo Position Brackets (feature de posição, sem ordem de entrada da API):** **[NÃO CONFIRMADO]**. Não há evidência. Nesse cenário a identificação por `customTag` **não funciona** e você depende de `parentOrderId` (que pode não existir, já que não há ordem-pai) ou de reconciliação por contrato/lado/tipo. Este é um risco real e não resolvido.

---

## 4. Status de ordem — o enum documentado está INCOMPLETO

### Enum oficial **[DOC]** (<https://gateway.docs.projectx.com/docs/realtime/>)

```cs
public enum OrderStatus { None=0, Open=1, Filled=2, Cancelled=3, Expired=4, Rejected=5, Pending=6 }
```

### O que aparece de verdade **[LIVE]**

Contagem sobre todos os eventos de ordem gravados:

| status | Significado | Onde aparece | Tipos observados |
|--------|-------------|--------------|------------------|
| `1` Open | ordem trabalhando no book | stream + `searchOpen` + `search` | 1, 4 |
| `2` Filled | preenchida | stream + `search` | 1, 2, 4 |
| `3` Cancelled | cancelada (inclui a perna OCO perdedora) | stream + `search` | 1, 4 |
| `5` Rejected | rejeitada | stream + `search` | 2 (entradas) |
| `6` Pending | entrada aceita, ainda não executada | **só stream** | 2 |
| **`8`** | **suspenso — bracket filho aguardando fill da entrada** | **só stream** | 1, 4 |

**`status: 8` não existe na documentação oficial.** Observado 79 vezes em filhos SL e 79 em filhos TP, sempre no intervalo entre criação e fill da entrada. Nunca observado em ordens de entrada.

Não observei `0` (None) nem `4` (Expired) neste dataset — o que não significa que não ocorram.

### Os terminais `[2,3,4,5]` do código estão corretos?

**Sim, com uma ressalva.** `2` (Filled), `3` (Cancelled), `4` (Expired), `5` (Rejected) são de fato estados finais. Consistente com o SDK Python **[COM]** que expõe `is_filled` / `is_cancelled` / `is_rejected` para os mesmos valores.

**Working / ativos:** `1` (Open), `6` (Pending) e `8` (suspenso). O código trata os três como working por exclusão (`src/ownership/working-orders.ts:4-8`, `src/state/venue-state.ts:180`), o que dá o resultado certo — mas por acidente, não por conhecimento explícito do `8`. Ressalva: `0` (None) também cai em "working" por exclusão, e é um valor sem semântica definida. **[NÃO CONFIRMADO]** se `0` pode aparecer e se seria terminal.

---

## 5. Busca de ordens

### 5.1 `POST /api/Order/search` **[DOC]**

Fonte: <https://gateway.docs.projectx.com/docs/api-reference/order/order-search>

| Campo | Tipo | Obrig. |
|-------|------|--------|
| `accountId` | integer | sim |
| `startTimestamp` | datetime | **sim** |
| `endTimestamp` | datetime | não (nullable) |

Retorna **histórico** no intervalo: todas as ordens, incluindo `status: 2` (Filled), `3` (Cancelled), `5` (Rejected). **[LIVE]** confirmado: statuses 1, 2, 3 e 5 retornados. Campos: `id, accountId, contractId, symbolId, creationTimestamp, updateTimestamp, status, type, side, size, limitPrice, stopPrice, fillVolume, filledPrice, customTag`.

**[NÃO CONFIRMADO]:** existe janela máxima de tempo (`startTimestamp` muito antigo é rejeitado ou truncado?) e existe paginação/limite de resultados. A doc não menciona nenhum dos dois. Trate como desconhecido e consulte em janelas curtas.

Cuidado com a doc legado: um exemplo do `/docs/intro/` mostra `updateTimestamp: null` **[DOC legado]**, enquanto o exemplo atual mostra sempre preenchido. O parser deste projeto exige `updateTimestamp` string (`src/projectx/schemas.ts:152`) — se o valor voltar `null` em alguma superfície, o parse **falha**.

### 5.2 `POST /api/Order/searchOpen` **[DOC]**

Fonte: <https://gateway.docs.projectx.com/docs/api-reference/order/order-search-open>

Único parâmetro: `accountId`. Sem janela de tempo.

**Não retorna canceladas nem preenchidas** **[LIVE]** — só `status: 1` (Open) foi observado em 321 snapshots.

### 5.3 A diferença crítica que a doc não conta **[LIVE]**

**`searchOpen` NÃO retorna os brackets suspensos (`status: 8`).** Zero ocorrências de status 8 em `searchOpen`; zero também em `search`. Consequência operacional grave:

> Entre o `place` da entrada e o fill dela, seus SL/TP **existem** (têm `orderId`, `parentOrderId`, distância em ticks) mas são **invisíveis** para qualquer consulta REST. A única superfície onde eles aparecem nessa janela é o stream `GatewayUserOrder`.

Se você reiniciar o processo nessa janela, ou perder o stream, você não tem como descobrir por REST que a proteção já foi alocada — e pode concluir erradamente que a posição está desprotegida (ou duplicar brackets).

---

## 6. Posições

### 6.1 `POST /api/Position/searchOpen` **[DOC]**

Fonte: <https://gateway.docs.projectx.com/docs/api-reference/positions/search-open-positions>. Parâmetro: `accountId`.

```json
{ "positions": [ { "id": 6124, "accountId": 536, "contractId": "CON.F.US.GMET.J25",
  "creationTimestamp": "2025-04-21T19:52:32.175721+00:00",
  "type": 1, "size": 2, "averagePrice": 1575.75 } ],
  "success": true, "errorCode": 0, "errorMessage": null }
```

### 6.2 Uma linha por contrato, agregada **[LIVE]**

Máximo de linhas observado em qualquer `positions_snapshot`: **1**. Scale-in não cria segunda linha — a linha existente muda `size` e recalcula `averagePrice` (observado: `size: 2, averagePrice: 28446.375`, média ponderada de duas entradas). Portanto **não existe conceito de posição por tranche no provider**; se você precisa de tranches, isso é 100% contabilidade do cliente.

### 6.3 Direção / sinal **[DOC]** + **[LIVE]**

```cs
public enum PositionType { Undefined=0, Long=1, Short=2 }
```

`size` é **sempre magnitude positiva** — a direção vem exclusivamente de `type`. Nunca existe size negativo. **[LIVE]** confirmado em 202 eventos (combinações observadas: type 1 com size 1/2/5, type 2 com size 1/2/3).

**Fechamento de posição no stream** aparece como envelope `action: 2` com `type: 0, size: 0` **[LIVE]** — ou seja, uma posição zerada é reportada como `Undefined`/zero, não removida silenciosamente.

O payload do stream também traz `contractDisplayName` (ex.: `"MNQU26"`), campo **não documentado** **[LIVE]**.

### 6.4 Fechamento total e parcial **[DOC]**

| Endpoint | Parâmetros |
|----------|-----------|
| `POST /api/Position/closeContract` | `accountId`, `contractId` |
| `POST /api/Position/partialCloseContract` | `accountId`, `contractId`, `size` (todos obrigatórios) |

`partialCloseContract` **existe e está documentado** (<https://gateway.docs.projectx.com/docs/api-reference/positions/close-positions-partial>). Resposta é só o envelope `{success, errorCode, errorMessage}` — **não devolve orderId**, então você não consegue atribuir o fill resultante a essa chamada por identidade de ordem; só por `GatewayUserTrade` subsequente.

**[LIVE 2026-08-19/20 PRAC]:** Gateway uses `placeOrder` (type market) for partial EXIT rather than `partialCloseContract`, so the exit is attributable by `orderId` / `customTag`. Observed Auto OCO / bracket behavior on multi-tranche MNQ:

| Observation | SHORT | LONG |
|-------------|-------|------|
| Venue accepted partial EXIT | yes (`3425731259`) | yes (`3425904761`) |
| Survivor SL/TP after EXIT | present; MOVE_STOP OK | present; MOVE_STOP + MOVE_TP OK |
| Exited-tranche brackets | still in open_orders snapshot with survivor | cancelled / absent |
| Native atomic close+OCO rescale | **not** observed | **not** observed |

Gateway therefore keeps a durable `ProtectedReductionSaga` and stop-first rearm rather than assuming provider rescale. Fixtures: `tests/fixtures/projectx/live/partial_exit_protection_transition.json` and `partial_exit_protection_transition_long.json`.

**[NÃO CONFIRMADO historically]:** whether `partialCloseContract` itself rescales brackets — this project does not rely on that endpoint for attributable exits.

---

## 7. User Hub / SignalR

### 7.1 Conexão **[DOC]**

Fonte: <https://gateway.docs.projectx.com/docs/realtime/>

```
https://rtc.topstepx.com/hubs/user?access_token=<JWT>
```

Opções recomendadas na doc: `skipNegotiation: true`, `transport: WebSockets`, `accessTokenFactory`, `timeout: 10000`, `withAutomaticReconnect()`.

### 7.2 Métodos de subscrição **[DOC]**

| Hub | Subscribe | Unsubscribe |
|-----|-----------|-------------|
| user | `SubscribeAccounts()`, `SubscribeOrders(accountId)`, `SubscribePositions(accountId)`, `SubscribeTrades(accountId)` | `Unsubscribe*` equivalentes |
| market | `SubscribeContractQuotes(contractId)`, `SubscribeContractTrades(contractId)`, `SubscribeContractMarketDepth(contractId)` | `Unsubscribe*` equivalentes |

### 7.3 Eventos e payloads

| Evento | Assinatura | Payload documentado |
|--------|-----------|---------------------|
| `GatewayUserAccount` | `(data)` | `id, name, balance, canTrade, isVisible, simulated` |
| `GatewayUserOrder` | `(data)` | `id, accountId, contractId, symbolId, creationTimestamp, updateTimestamp, status, type, side, size, limitPrice, stopPrice, fillVolume, filledPrice, customTag` |
| `GatewayUserPosition` | `(data)` | `id, accountId, contractId, creationTimestamp, type, size, averagePrice` |
| `GatewayUserTrade` | `(data)` | `id, accountId, contractId, creationTimestamp, price, profitAndLoss, fees, side, size, voided, orderId` |
| `GatewayQuote` | `(contractId, data)` | `symbol, symbolName, lastPrice, bestBid, bestAsk, change, changePercent, open, high, low, volume, lastUpdated, timestamp` |
| `GatewayDepth` | `(contractId, data)` | `timestamp, type (DomType), price, volume, currentVolume` |
| `GatewayTrade` | `(contractId, data)` | `symbolId, price, timestamp, type (TradeLogType), volume` |

`profitAndLoss: null` indica **half-turn trade** (perna de abertura) **[DOC]**.

### 7.4 Envelope real: os payloads vêm embrulhados **[LIVE]**

A doc mostra o handler recebendo o objeto direto (`(data) => …`). **Na prática o TopstepX envia um envelope `{ action, data }`:**

```json
{"action":1,"data":{"id":3345169271,"accountId":26060225,...}}
```

Valores de `action` observados: `1` e `2` em `GatewayUserOrder` e `GatewayUserPosition`; `0` em `GatewayUserTrade`. Em posições, `action: 2` acompanhou sempre `type: 0, size: 0` (fechamento) e `action: 1` os updates/aberturas. **[NÃO CONFIRMADO]:** a semântica formal dos códigos de `action` (presumo insert/update vs delete, mas não há documentação). Este projeto desembrulha o envelope de forma defensiva (`src/projectx/schemas.ts:25-36`) e **ignora** o `action` — o que é seguro para ordens (o `status` já carrega a informação) mas descarta um sinal em posições.

### 7.5 Campos reais **além** dos documentados em `GatewayUserOrder` **[LIVE]**

`parentOrderId`, `linkedOrderId`, `trailPrice`, `trailDistance` (ver §2.3). Todos ausentes da doc.

Em `GatewayUserTrade` há também `commissions` (separado de `fees`) **[LIVE]** — não documentado.

### 7.6 Garantias de entrega: **não há replay nem backfill**

Isto é o ponto mais crítico da sua lista e a resposta é ruim.

- **[DOC]** A documentação **não menciona** replay, sequence number, cursor, "since", ou qualquer mecanismo de recuperação de eventos. O único trecho relevante é o exemplo que faz `onreconnected(() => subscribe())` — ou seja, a orientação oficial é **apenas re-subscrever**.
- Não existe nenhum campo de sequência nos payloads que permitisse detectar buraco **[LIVE]** — confirmado: nenhum dos payloads gravados tem sequence/offset do provider.
- Ao reconectar, o SignalR gera **novo connectionId** e o servidor trata como nova conexão; as subscrições anteriores não sobrevivem — daí a necessidade de re-subscrever.
- **[COM]** A recomendação consistente da comunidade e dos SDKs é: ao reconectar, **reconciliar por REST** (`Account/search`, `Order/searchOpen`, `Position/searchOpen`, `Order/search` / `Trade/search` para a janela do gap).

**Conclusão: eventos perdidos durante a desconexão são perdidos definitivamente.** O stream é um feed incremental "a partir de agora", sem histórico. A única recuperação é snapshot REST + busca por janela de tempo.

Isso tem duas consequências duras, dado o §5.3:

1. Um fill ocorrido durante o gap é recuperável por `Order/search` / `Trade/search` (a janela de tempo cobre).
2. Um **bracket suspenso (`status: 8`) criado durante o gap é irrecuperável por REST** — ele não aparece em `searchOpen` nem em `search`. Você só o verá quando a entrada preencher e ele virar `status: 1`. Nesse intervalo o estado de proteção é genuinamente incognoscível via REST.

**[LIVE]** o projeto sofreu 17 `user_reconnecting` no dataset, com mensagem `"Server returned an error on close: Connection closed with an error."` e gaps de até ~2 minutos (01:42:38 → 01:44:42). Reconexões espontâneas do TopstepX não são raras — trate como rotina, não exceção.

---

## 8. Modificação e cancelamento

### 8.1 `POST /api/Order/modify` **[DOC]**

Fonte: <https://gateway.docs.projectx.com/docs/api-reference/order/order-modify>

| Campo | Tipo | Obrig. | Nullable |
|-------|------|--------|----------|
| `accountId` | integer | sim | não |
| `orderId` | integer | sim | não |
| `size` | integer | não | sim |
| `limitPrice` | decimal | não | sim |
| `stopPrice` | decimal | não | sim |
| `trailPrice` | decimal | não | sim |

Preços aqui são **absolutos** (o exemplo oficial usa `"stopPrice": 1604`), diferente dos brackets do `place` que são em ticks. Resposta é só `{success, errorCode, errorMessage}` — **sem orderId, sem estado**. Você não sabe se a modificação foi aplicada até ver o `GatewayUserOrder` ou reconsultar.

### 8.2 `POST /api/Order/cancel` **[DOC]**

Parâmetros: `accountId`, `orderId`. Resposta: `{success, errorCode, errorMessage}`.

### 8.3 O que acontece ao modificar uma perna do OCO

- **[LIVE, parcial]** Modificar uma perna funciona e o irmão permanece: o projeto tem aceitação ao vivo de `MOVE_STOP` e `MOVE_TP` em 30/07/2026 com "venue stop moved" e "sibling leg and position quantity unchanged on success" (`docs/PARITY.md:43-44`, `docs/PARITY.md:104`). Ou seja, mover o SL **não** cancela nem redimensiona o TP.
- **[LIVE]** Quando uma perna **preenche**, a outra é cancelada pelo provider com `status: 3` (Cancelled) — comportamento OCO clássico. Observado em ambas as direções: TP fill (`status: 2`) → SL `status: 3`, e SL fill → TP `status: 3`.
- **[NÃO CONFIRMADO]:** modificar `size` de uma perna. Se você reduzir o `size` do SL, o TP acompanha? Fica dessincronizado? Não há evidência nem documentação. **Não faça isso sem teste.**
- **[NÃO CONFIRMADO]:** se é possível modificar uma perna enquanto ela está **suspensa** (`status: 8`, antes do fill da entrada). Sequer há preço definido nesse estado, então o comportamento é imprevisível.
- **[NÃO CONFIRMADO]:** se cancelar manualmente uma perna cancela a outra, ou deixa a posição com proteção unilateral. Isso importa muito para segurança e não está resolvido.

---

## 9. Rate limits e "velocity"

### 9.1 Rate limits oficiais **[DOC]**

Fonte: <https://gateway.docs.projectx.com/docs/getting-started/rate-limits/>

| Endpoint | Limite |
|----------|--------|
| `POST /api/History/retrieveBars` | **50 requests / 30 segundos** |
| Todos os outros endpoints | **200 requests / 60 segundos** |

Exceder retorna **HTTP 429 Too Many Requests**. A doc não publica header de `Retry-After` nem janela deslizante vs fixa — **[NÃO CONFIRMADO]** qual dos dois é. O cliente deste projeto faz backoff `[0, 5s, 15s, 30s]` em 429 (`src/projectx/client.ts:84`), o que é compatível com qualquer dos dois modelos.

**[COM]** SDKs terceiros (`topstep-client-py`, `topstepx` npm) publicam exatamente os mesmos números, e o npm adiciona **máximo de 20.000 barras por request** em `retrieveBars` — número **não** presente na doc oficial, trate como **[COM]**.

### 9.2 "Velocity" — não é um controle da API

Não encontrei nenhuma feature chamada "velocity control" na API ProjectX/TopstepX. O termo aparece em dois contextos diferentes, ambos **não** sendo rate limit de API:

1. **CME Velocity Logic** **[DOC Topstep]** (<https://help.topstep.com/en/articles/13545889-cme-velocity-logic>): mecanismo da **bolsa**, não do broker. Quando o preço se move rápido demais para a liquidez disponível, a CME pausa o contrato por **2–10 segundos**. Durante o evento, **ordens agressivas que causaram o evento são canceladas** e novas submissões podem ser rejeitadas. Não é volatilidade nem notícia — é colapso de liquidez. A Topstep declara explicitamente que é mecanismo da CME e que não faz exceções. **Stops não são protegidos** e podem sofrer slippage severo.
2. **Prohibited Conduct da Topstep** **[DOC Topstep]** (<https://help.topstep.com/en/articles/10305426-prohibited-trading-strategies-at-topstep>): proíbe "unfair technology — using software, AI, ultra-high speed systems, or mass data entry". Isso é regra de programa (risco de encerramento de conta), não um throttle técnico. O texto caracteriza abuso como "centenas ou milhares de trades por dia, com duração média medida em segundos".

**[NÃO CONFIRMADO]:** se o TopstepX tem um limiter de ordens por segundo separado do rate limit HTTP (ex.: rejeitar a 6ª ordem em 1s com um errorCode específico). Não achei documentação nem evidência. Os `status: 5` (Rejected) gravados neste projeto (41 eventos, todos em entradas MARKET) **não trazem motivo no stream** — o payload de rejeição tem só `status: 5, fillVolume: 0`, sem `errorMessage`. O motivo só vem no corpo da resposta REST do `place`, que este projeto não persiste na evidência.

### 9.3 Catálogo de causas de rejeição que consegui confirmar

| Causa | Fonte |
|-------|-------|
| `Brackets cannot be used with Position Brackets` | **[LIVE]** `docs/PARITY.md:119` |
| HTTP 429 por rate limit | **[DOC]** |
| HTTP 401 por token inválido/expirado (token vale 24h) | **[DOC]** |
| Cancelamento pela CME durante Velocity Logic | **[DOC Topstep]** |
| Stop no lado errado do mercado | **[COM]** (padrão de futuros, não específico do ProjectX) |
| `customTag` duplicado na conta | **[DOC]** implícito ("must be unique"); **[NÃO CONFIRMADO]** qual erro exato retorna |

---

## Divergências código vs API

Ordenadas por risco.

### D1. `parseOrder` descarta `parentOrderId` e `linkedOrderId` — RISCO ALTO

`src/projectx/schemas.ts:143-169` normaliza a ordem para um subconjunto fixo de campos. `parentOrderId`, `linkedOrderId`, `trailPrice` e `trailDistance` **chegam no stream** e são **jogados fora** antes de virar evidência normalizada.

Consequência: o sistema prova propriedade de bracket **só** por convenção de `customTag` (`src/ownership/protection.ts:46-62`), quando o provider entrega a relação **explícita** (`parentOrderId`) no mesmo payload. `docs/TOPSTEP-NATIVE.md:49` afirma que a propriedade usa "explicit `trade.orderId` and `customTag` evidence" — mas a evidência mais explícita disponível está sendo descartada. O `raw_payload_json` preserva os campos, então o dado histórico não foi perdido; só não está sendo usado.

### D2. `status: 8` não é conhecido pelo código — RISCO ALTO

`src/ownership/working-orders.ts:4` e `src/state/venue-state.ts:180` definem terminal como `[2,3,4,5]` e tratam todo o resto como working. Isso dá o **resultado certo** para o `8`, mas por exclusão. Nenhum lugar no código distingue **"bracket suspenso, sem preço, aguardando fill da entrada"** de **"bracket ativo no book com preço"**.

Isso importa porque `resolveProtectiveLeg` (`src/ownership/protection.ts:55`) lê `order.stopPrice`/`order.limitPrice` para o preço da perna, e no estado `8` **esses campos são nulos**. Uma perna suspensa pode ser contada como `proven` com `price: null`. Vale um teste explícito.

### D3. O código assume que `searchOpen` vê os brackets — RISCO ALTO

Toda a reconciliação de proteção passa por `open_orders_snapshot` (`src/ownership/projectx-order-ownership.ts:326-332`). Como `searchOpen` **não retorna `status: 8`** (§5.3), existe uma janela real — entre `place` e fill — em que a reconciliação REST reporta proteção ausente **mesmo estando alocada**. Com entradas MARKET essa janela é de ~8ms (medido: `.589` → `.597`), então na prática quase nunca morde. Com entradas LIMIT ou STOP ela pode durar minutos ou horas. O código só envia `type: 2` (MARKET) hoje (validado em `projectx-order-ownership.ts:181`), o que **acidentalmente** evita o problema. Qualquer migração para entradas passivas expõe isso imediatamente.

### D4. A convenção de sinal dos ticks do bracket não tem base documental — RISCO MÉDIO

`src/execution/brackets.ts:44-52` inverte o sinal dos ticks por lado. Isso **casa** com o que o provider ecoa (§1.1), mas a doc só diz "Number of ticks" e não define sinal. Está funcionando; só não está confirmado que seja *necessário*. Vale registrar como comportamento observado, não como contrato.

### D5. `updateTimestamp` é exigido como string — RISCO MÉDIO

`src/projectx/schemas.ts:152` usa `requiredString(input, "updateTimestamp")`. A doc legado mostra um exemplo de `/api/Order/search` com `"updateTimestamp": null` **[DOC legado]**. Se alguma superfície devolver `null`, o parse lança e o evento é rejeitado como payload fault. Nunca ocorreu no dataset (todos preenchidos), mas é um modo de falha barato de eliminar.

### D6. O envelope `action` do stream é descartado — RISCO BAIXO

`unwrapUserStreamPayload` (`src/projectx/schemas.ts:25-36`) desembrulha `{action, data}` e ignora o `action`. Para ordens é inofensivo (`status` basta). Para posições, `action: 2` + `type: 0, size: 0` é o sinal explícito de fechamento; hoje isso é inferido de `size: 0`. Funciona, mas descarta confirmação redundante de um evento crítico.

### D7. `commissions` e `contractDisplayName` não são capturados — RISCO BAIXO

`GatewayUserTrade` traz `commissions` separado de `fees` **[LIVE]**; `parseTrade` só lê `fees` (`src/projectx/schemas.ts:179-180`). Se o P&L líquido for calculado a partir de `fees` apenas, subestima o custo. `contractDisplayName` em posições é cosmético.

---

## Resumo do que ficou NÃO CONFIRMADO

Itens em que não se deve presumir nada:

1. Se `ticks` de bracket **sem sinal** funciona (§1.1).
2. Se `trailPrice` no *request* é distância ou preço absoluto (§1.3).
3. Se `linkedOrderId` no *request* de `place` ainda é honrado no TopstepX e com que semântica (§1.4).
4. `customTag` dos filhos quando a entrada **não** tem `customTag` (§3.2).
5. Identificação de proteção criada por **Position Brackets** (sem ordem-pai da API) — `customTag` não serve (§3.2).
6. Se `status: 0` (None) ocorre e se é terminal (§4).
7. Janela máxima de tempo e paginação em `/api/Order/search` (§5.1).
8. Se `parentOrderId`/`linkedOrderId` aparecem nas respostas **REST** (o recorder deste projeto grava `raw_payload_json: null` para REST, então a evidência local não responde) — §2.3.
9. Comportamento dos brackets em **partial close**: rescale, cancel ou órfão (§6.4).
10. Semântica formal dos códigos de `action` no envelope do stream (§7.4).
11. Modificar `size` de uma perna do OCO (§8.3).
12. Modificar uma perna **suspensa** (`status: 8`) (§8.3).
13. Se cancelar uma perna cancela a irmã (§8.3).
14. Rate limit: janela fixa ou deslizante; existência de `Retry-After` (§9.1).
15. Existência de limiter de ordens/segundo separado do 429 HTTP (§9.2).
16. Erro exato retornado por `customTag` duplicado (§9.3).

Os itens **5, 9, 12 e 13** são os que mais mereciam um teste dirigido em conta PRAC, porque afetam segurança de proteção.

---

## Fontes

**Documentação oficial (atual, `api.topstepx.com`)**
- Place: <https://gateway.docs.projectx.com/docs/api-reference/order/order-place>
- Modify: <https://gateway.docs.projectx.com/docs/api-reference/order/order-modify>
- Cancel: <https://gateway.docs.projectx.com/docs/api-reference/order/order-cancel>
- Search: <https://gateway.docs.projectx.com/docs/api-reference/order/order-search>
- SearchOpen: <https://gateway.docs.projectx.com/docs/api-reference/order/order-search-open>
- Positions searchOpen: <https://gateway.docs.projectx.com/docs/api-reference/positions/search-open-positions>
- Close / partial close: <https://gateway.docs.projectx.com/docs/api-reference/positions/close-positions> · <https://gateway.docs.projectx.com/docs/api-reference/positions/close-positions-partial>
- Realtime + enums: <https://gateway.docs.projectx.com/docs/realtime/>
- Rate limits: <https://gateway.docs.projectx.com/docs/getting-started/rate-limits/>
- Trade search: <https://gateway.docs.projectx.com/docs/api-reference/trade/trade-search>

**Documentação oficial legado (`gateway-api-demo.s2f.projectx.com`)**
- Place com `linkedOrderId`: <https://gateway.docs.projectx.com/docs/intro/api-reference/order/order-place>

**Topstep (regras de programa / bolsa)**
- CME Velocity Logic: <https://help.topstep.com/en/articles/13545889-cme-velocity-logic>
- Prohibited Trading Strategies: <https://help.topstep.com/en/articles/10305426-prohibited-trading-strategies-at-topstep>

**Comunidade / SDKs**
- Position Brackets vs Auto-OCO: <https://help.tradesyncer.com/en/articles/11746420-projectx-bracket-orders-explained-position-brackets-vs-auto-oco-brackets>
- `project-x-py` (Python SDK): <https://project-x-py.readthedocs.io/en/latest/api/trading.html>
- `topstep-client-py`: <https://pypi.org/project/topstep-client-py/>
- `topstepx` (npm): <https://npmx.dev/package/topstepx>

**Evidência ao vivo deste projeto**
- `data/projectx-evidence.sqlite`, tabela `provider_events` — conta 26060225, `CON.F.US.MNQ.U26`, 30–31 jul 2026. Sequências citadas: 6003136–6003144, 6032060–6032068, 6102012–6102020, 10143907–10143908, 10593995–10594003, 10618057–10618060, 10620066–10620067.
- `docs/PARITY.md:43-44,104,110,119`
- `src/projectx/schemas.ts`, `src/projectx/client.ts`, `src/projectx/realtime.ts`, `src/execution/brackets.ts`, `src/ownership/protection.ts`, `src/ownership/working-orders.ts`, `src/state/venue-state.ts`
