# Relatório de Auditoria — Glitch Topstep + Hermes Profile

**Data:** 2026-08-25  
**Escopo:** gateway TypeScript `glitch-topstep` e profile Python `glitch-topstep-hermes-profile`  
**Alterações de código:** nenhuma

## Validação executada

- Gateway: `npm run check` — 456 testes aprovados.
- Profile: suíte Python — 304 testes aprovados, 1 ignorado.
- Contrato pareado, prompt `glitch-topstep-v15` e gateway `0.2.2` compatíveis.

## Crítico

### C1 — Retry automático de mutações ProjectX

Em `src/projectx/client.ts`, qualquer HTTP `429` é repetido automaticamente, inclusive `placeOrder`, `modifyOrder`, `cancelOrder` e `closePosition`.

Isso contradiz a política de mutação ambígua: se o primeiro request for aceito, mas a resposta for perdida ou retornar `429`, o retry pode duplicar uma ordem ou repetir uma alteração de proteção.

**Correção:** separar retry de leituras idempotentes de mutações. Mutações devem ser marcadas como ambíguas e reconciliadas por `customTag`/`providerOrderId`, nunca reenviadas cegamente.

### C2 — Fila de evidências pode crescer indefinidamente

Em `src/projectx/evidence-write-queue.ts`, eventos ficam no array físico `entries`. Durante falha persistente do SQLite, batches são restaurados, eventos coalescidos permanecem no array como `superseded` e `compact()` só ocorre após gravação bem-sucedida.

**Impacto:** crescimento de memória, degradação do event loop e eventual encerramento do gateway.

**Correção:** usar estrutura fisicamente limitada, compactar eventos superseded também após falhas e manter limite separado para profundidade lógica e memória real.

### C3 — Exportação SQLite → JSONL não é reparada no bootstrap

Em `scripts/state_store.py`, `append_decision()` grava SQLite e adiciona uma fila de exportação. Porém, `bootstrap_decisions()` apenas sincroniza JSONL para SQLite; não drena `jsonl_export_queue`.

Uma queda entre o commit SQLite e a exportação deixa a decisão ausente de `decisions.jsonl`. Componentes do learning que leem JSONL não a enxergam até uma nova decisão ser gravada.

**Correção:** o bootstrap deve executar `export_pending_jsonl()` antes de iniciar ciclo ou learning.

### C4 — Preempção Hermes não encerra a árvore de processos

Em `scripts/model_owner_lock.py`, a preempção usa apenas `os.kill(pid, SIGTERM)`. O supervisor de árvore de `scripts/process_supervisor.py` é aplicado ao timeout normal, mas não à preempção.

No Windows, o worker Python pode morrer enquanto o subprocesso Hermes permanece ativo. O lock é considerado stale, outro worker assume ownership e duas execuções Hermes podem ocorrer simultaneamente.

**Correção:** preempção deve usar o mesmo supervisor de árvore, aguardar a confirmação de término de pai e descendentes e só então remover o lock.

## Avisos

### W1 — Leitura completa de journals continua O(N)

Apesar do índice SQLite, diversos caminhos usam `read_jsonl()` sobre decisões, outcomes e episódios completos. Isso aumenta memória e latência conforme o histórico cresce.

**Correção:** consultas SQLite por sequência/data e `tail_jsonl()` somente para janelas recentes.

### W2 — `issued_packets` não possui retenção

Cada snapshot emitido pelo endpoint `/packet` pode criar uma nova linha em `issued_packets`. Não há pruning de packets expirados.

**Impacto:** crescimento permanente do SQLite e custo crescente de backup/recovery.

**Correção:** remover packets expirados não referenciados por intents, receipts ou recovery.

### W3 — Monólitos concentram responsabilidades

Os principais pontos são `src/service.ts`, `src/execution/coordinator.ts` e `scripts/run-topstep-cycle.py`. Eles misturam composição, lifecycle, risco, execução, proteção, outbox, delivery e persistência.

**Correção:** separar admission, mutation execution, protection, reconciliation, receipts, delivery e learning em módulos menores.

### W4 — Guards auxiliares dos launchers são inconsistentes

O launcher de learning usa timestamp de arquivo, enquanto o wake monitor usa PID sem identidade de inicialização. O lock principal já possui identidade mais forte, mas os launchers não usam a mesma autoridade.

**Correção:** centralizar toda admissão no `model-owner.lock` e validar PID junto com identidade de processo.

### W5 — Algumas falhas operacionais são pouco observáveis

Pruning, `fsync` de diretório e algumas rotinas de exportação capturam falhas sem gerar diagnóstico operacional suficientemente forte.

**Correção:** registrar métricas de falha, backlog, arquivos preservados e última tentativa.

### W6 — Documentação possui referências antigas

Existem referências a `direct-cycle.lock` e a `glitch.intent.v2` em documentação histórica ou operacional.

**Correção:** separar explicitamente histórico de procedimento atual e atualizar os documentos ativos para `model-owner.lock` e `glitch.intent.v3`.

## Sugestões de melhoria

1. Tornar SQLite a autoridade operacional única do profile; JSONL deve ser projeção.
2. Criar um supervisor único para ciclo direto, learning, repair e wake monitor.
3. Adicionar retenção explícita para packets, frames, receipts e journals, preservando referências de recovery.
4. Adicionar fault injection para `429` após aceitação, falha SQLite, crash durante exportação, preempção Windows e disco cheio.
5. Publicar métricas de heap, tamanho dos journals, profundidade física da fila, idade do backlog e processos Hermes ativos.
6. Manter a promoção `armed` bloqueada enquanto itens P0 do ledger permanecerem abertos.

## Exemplos de refatoração

### Retry separado para leituras e mutações

```ts
private async post(
  path: string,
  body: unknown,
  options: { authenticated: boolean; retryable: boolean },
): Promise<unknown> {
  const attempts = options.retryable ? this.rateLimitRetryMs.length : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await this.postOnce(path, body, options.authenticated);
    } catch (error) {
      if (!options.retryable || !shouldRetryRead(error, attempt, attempts)) {
        throw error;
      }
      await delay(this.rateLimitRetryMs[attempt] ?? 30_000);
    }
  }
  throw new Error("unreachable");
}
```

Leituras podem usar retry limitado; mutações devem usar `retryable: false` e seguir para reconciliação.

### Drenagem da fila de exportação no bootstrap

```python
def bootstrap_decisions(self, jsonl_path: Path) -> None:
    self.sync_decisions_from_jsonl(jsonl_path)
    self.export_pending_jsonl(jsonl_path)
```

Isso garante que decisões já confirmadas no SQLite sejam projetadas novamente após crash.

### Preempção com encerramento da árvore

```python
def _request_owner_stand_down(...):
    pid = int(owner.get("pid") or 0)
    terminate_pid_tree(pid, grace_seconds=PREEMPT_GRACE_SECONDS)
    return not process_tree_is_alive(pid)
```

O lock só deve ser removido depois da confirmação de término de todos os descendentes.

### Retenção de packets expirados

```ts
public pruneExpiredPackets(nowUtc: string): number {
  const result = this.database.prepare(`
    DELETE FROM issued_packets
    WHERE expires_utc < ? AND invalidated_utc IS NOT NULL
  `).run(nowUtc);
  return Number(result.changes ?? 0);
}
```

O pruning deve preservar packets referenciados por intents, receipts ou recovery.

## Veredito

A base possui bons mecanismos de idempotência, reconciliação, proteção e contratos pareados. Entretanto, ainda não deve ser considerada plenamente pronta para produção autônoma `armed` antes da correção de C1–C4.
