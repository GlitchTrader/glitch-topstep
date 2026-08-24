# Auditoria Consolidada — Glitch Topstep + Hermes Profile

**Data:** 2026-08-24  
**Escopo:** `GlitchTrader/glitch-topstep` e `GlitchTrader/glitch-topstep-hermes-profile`  
**Gateway auditado:** `197cbe1`  
**Perfil auditado:** `51126c1`  
**Comparação NT:** Glitch NT `d2b8e9e`; Hermes NT `ca785c2`

## Sumário executivo

Os dois repositórios possuem uma base arquitetural sólida: contratos pareados, validação de intents, proteção de novas exposições, reconciliação ProjectX, filas limitadas, recovery explícito e boa cobertura de testes.

Apesar disso, ainda existem riscos incompatíveis com promoção imediata para produção `armed`, principalmente em:

1. consistência entre SQLite e JSONL;
2. recuperação e ownership por locks baseados em arquivos/PID;
3. encerramento de processos Hermes após timeout;
4. retenção e pruning de artefatos necessários à recuperação;
5. crescimento de memória e custo O(N) no learning;
6. ausência de limite explícito para respostas recebidas do ProjectX.

O ledger atual confirma que os itens REAUDIT P0/P1 e a promoção `armed` continuam pendentes. Nenhum código foi alterado durante esta auditoria.

## Evidência de validação

- Gateway: `npm run check` concluído com **444 testes aprovados**.
- Perfil Hermes: `python -m unittest discover -s tests` concluído com **294 testes aprovados e 1 ignorado**.
- A validação foi executada sobre os checkouts locais indicados acima.
- Os diretórios de trabalho não rastreados existentes foram preservados.

## Achados críticos

### C1 — Dual-write SQLite/JSONL pode duplicar registros

O perfil grava a decisão no SQLite e depois exporta para JSONL. Em `ProfileStateStore.export_pending_jsonl()`, o arquivo é escrito antes da remoção da fila SQLite. Uma queda do processo entre essas operações deixa o registro no JSONL e ainda pendente no SQLite; a recuperação pode exportá-lo novamente.

Arquivos relevantes:

- `glitch-topstep-hermes-profile/scripts/state_store.py:110`
- `glitch-topstep-hermes-profile/scripts/state_store.py:124`
- `glitch-topstep-hermes-profile/scripts/common.py:392`

Também existe risco de perda silenciosa no cursor incremental: o código avança o offset pelo bloco inteiro lido. Se a última linha estiver parcialmente escrita, ela pode ser ignorada e o cursor avançar além dela.

**Solução recomendada:** SQLite deve ser a autoridade operacional. O JSONL deve ser uma projeção idempotente, com sequência monotônica, checksum e verificação de existência antes de exportar. O cursor deve avançar apenas até a última linha completa.

### C2 — Locks possuem janela TOCTOU e identidade insuficiente

O lock do perfil verifica o proprietário, depois remove o arquivo em uma operação separada. Outro processo pode adquirir o lock entre a verificação e o `unlink()`, permitindo que o processo antigo remova o lock do novo dono.

O lock de runtime do gateway verifica apenas se o PID está vivo. Não valida identidade de inicialização do processo, permitindo risco de reutilização de PID.

Arquivos relevantes:

- `glitch-topstep-hermes-profile/scripts/model_owner_lock.py:151`
- `glitch-topstep/src/service/runtime-lock.ts:18`
- `glitch-topstep/src/service/runtime-lock.ts:42`

**Solução recomendada:** usar lock exclusivo nativo do sistema operacional ou lease SQLite com compare-and-delete atômico. O proprietário deve conter PID, identidade de início do processo, invocation ID, geração e timestamp de aquisição.

### C3 — Timeout Hermes pode liberar ownership antes de encerrar toda a execução

O perfil usa `subprocess.run(..., timeout=...)`. Após timeout, o lock é liberado, mas não há supervisor centralizado que encerre e confirme o término de toda a árvore de processos.

Arquivo relevante:

- `glitch-topstep-hermes-profile/scripts/run-topstep-cycle.py:347`

**Risco:** uma execução Hermes órfã pode continuar consumindo CPU, memória ou emitir saída depois que outra execução já adquiriu o ownership.

**Solução recomendada:** criar um `ProcessSupervisor` único para ciclo direto, learning e reparos, com encerramento da árvore, confirmação via `wait()`, limite de stdout/stderr e status persistente.

### C4 — Múltiplas fontes de estado dificultam recuperação determinística

Decisões, receipts, outcomes, frames, outbox, delivery-wire e episódios vivem em diferentes arquivos JSON/JSONL, enquanto o SQLite indexa apenas parte do estado.

Isso cria estados intermediários em que componentes distintos podem observar versões diferentes após crash, rotação ou escrita parcial.

**Solução recomendada:** adotar uma autoridade única transacional para estado operacional. JSONL deve ser exportação/reconstrução, não o banco de trabalho primário.

## Avisos de manutenção e robustez

### W1 — Leituras completas de JSONL causam crescimento O(N)

`read_jsonl()` carrega arquivos inteiros em memória. O padrão é usado em decisões, outcomes, episódios, clusters, reconciliação e learning.

Arquivo relevante:

- `glitch-topstep-hermes-profile/scripts/common.py:354`

Com histórico prolongado, isso aumenta latência, memória e tempo de pausa do learning.

**Solução:** usar consultas SQLite, cursores incrementais, `tail_jsonl()` apenas para janelas recentes e índices por ID/sequência.

### W2 — Reescritas completas podem apagar ou reordenar mudanças

Funções como `upsert_unique()` e `reconcile_corrected_episodes()` carregam o JSONL completo, alteram a lista e reescrevem o arquivo inteiro.

**Solução:** persistir correções como revisões append-only no SQLite e materializar JSONL por exportação atômica. Se a reescrita permanecer, usar arquivo temporário, `fsync`, `replace` e controle de versão.

### W3 — `run-topstep-learning.py` e `parity.py` concentram responsabilidades demais

O learning runner mistura ingestão, reconciliação, prompts, chamadas Hermes, episódios, overlays, planejamento, persistência e tratamento de falhas.

**Solução:** separar `DecisionJournal`, `DeliveryOutbox`, `OutcomeProjection`, `LearningEvidence`, `HermesInvoker` e `OverlayGovernance`.

### W4 — Busca de frame por `packet_id` é linear

`frame_for_packet_id()` percorre arquivos de frame para localizar um pacote.

Arquivo relevante:

- `glitch-topstep-hermes-profile/scripts/workflows/intent_outbox.py:33`

**Solução:** indexar `packet_id` e caminho em SQLite ou usar o próprio ID no nome do arquivo.

### W5 — Pruning não preserva todas as referências de recovery

O Topstep já possui retenção de 72 horas em `prune_state_retention.py`, mas o pruning pode remover frames antigos sem verificar se ainda são referenciados por `outbox`, `receipts` ou `delivery-wire`.

O Glitch NT corrigiu esse problema no commit `d2b8e9e` preservando pacotes referenciados.

**Solução:** coletar IDs referenciados antes do pruning e nunca remover esses artefatos, mesmo que estejam fora da janela temporal.

### W6 — Pruning JSONL não é totalmente atômico

`prune_jsonl_by_age()` reescreve o arquivo diretamente com `write_text()`.

**Solução:** gravar em arquivo temporário no mesmo diretório, fazer flush/fsync e substituir atomicamente.

### W7 — Respostas ProjectX não possuem limite explícito de tamanho

O cliente usa `response.text()` diretamente:

- `glitch-topstep/src/projectx/client.ts:295`

Uma resposta anormalmente grande pode consumir memória excessiva.

**Solução:** implementar leitura limitada por bytes, cancelamento do stream quando o limite for excedido e limites por quantidade de itens.

### W8 — Retentativas ProjectX estão concentradas em HTTP 429

Leituras poderiam ter retry com backoff e jitter para timeout, reset de conexão e erros transitórios. Mutações não devem ser repetidas cegamente quando o resultado é ambíguo.

**Solução:** política separada por classe:

- leitura idempotente: retry limitado;
- autenticação: revalidação controlada;
- mutação ambígua: reconciliação, nunca retry cego;
- rejeição determinística: sem retry.

### W9 — Shutdown HTTP pode aguardar indefinidamente

`LocalGatewayServer.stop()` usa `server.close()` sem deadline para requests presos.

Arquivo relevante:

- `glitch-topstep/src/server/local-gateway.ts:92`

**Solução:** registrar conexões ativas, aplicar timeout de request e destruir conexões que excederem o prazo de shutdown.

### W10 — Logs de exceção precisam de sanitização central

Os logs registram mensagens completas de exceções. Não foi identificada exposição direta de credenciais, mas respostas ProjectX, URLs, headers ou payloads podem conter informação operacional sensível.

**Solução:** sanitizar tokens, authorization headers, chaves, URLs sensíveis e payloads antes do log.

## Comparação com Glitch NT

### Commit Glitch NT `d2b8e9e`

O commit implementa:

- 180 frames retidos;
- pruning de pacotes não referenciados após 72 horas;
- tentativa de pruning no máximo uma vez por hora;
- preservação de pacotes mencionados em `outbox` e `receipts`;
- filesystem fora da thread principal do NinjaTrader.

### O que incorporar no Topstep

1. Preservação de referências durante pruning.
2. Cadência limitada e observável de pruning.
3. Retenção temporal configurável com mínimo seguro.
4. Métricas de removidos, preservados, falhos e backlog.
5. Execução de pruning fora do caminho crítico.

### O que melhorar em relação ao NT

O NT usa blocos `catch {}` silenciosos no pruning. No Topstep, falhas devem gerar evento operacional e métrica, sem interromper o trading, mas também sem desaparecer.

## Comparação com Hermes NT

### Commit Hermes NT `ca785c2`

O commit adiciona `fit_debrief_evidence()`:

- mantém o lote mais antigo primeiro;
- reduz o lote até caber no budget de prompt;
- reserva espaço para reparo de saída inválida;
- falha explicitamente se um único outcome não couber.

### Estado no Topstep

Essa lógica já está incorporada no perfil Topstep:

- `glitch-topstep-hermes-profile/scripts/run-topstep-learning.py:80`
- `glitch-topstep-hermes-profile/scripts/run-topstep-learning.py:630`
- `glitch-topstep-hermes-profile/scripts/run-topstep-learning.py:1133`

O Topstep usa `MAX_PROMPT_CHARS`, reserva para reparo e reduz o batch de debrief. Não é necessário copiar esse commit.

### O que ainda aprender do padrão NT

- budgets específicos por loop;
- métricas de evidência removida;
- limites por quantidade e tamanho de registros;
- separação entre batch reduzido e falha total;
- armazenamento incremental para não montar o histórico inteiro em memória.

## Limites HTTP

### Limite do corpo recebido pelo gateway local

O gateway Topstep limita o corpo recebido a 65.536 bytes:

- `glitch-topstep/src/server/local-gateway.ts:19`
- `glitch-topstep/src/server/local-gateway.ts:320`

O Glitch NT utiliza o mesmo limite de 65.536 bytes em `GlitchAiIntentServer`.

**Recomendação:** não remover o limite.

Ele protege contra payloads acidentalmente gigantes, abuso local e consumo excessivo de memória. O campo `decision_audit` não possui limite individual, portanto o limite total já funciona como proteção de envelope.

Se for necessário aumentar o valor, fazê-lo de forma configurável, por exemplo 256 KB, mantendo:

1. validação antecipada de `Content-Length`;
2. limite durante leitura chunked;
3. limites específicos por campo;
4. limite menor para comandos operacionais;
5. métrica e erro explícito `payload_too_large`.

### Limite da resposta recebida do ProjectX

Esse é um problema diferente. O cliente ProjectX não possui limite explícito ao usar `response.text()`.

**Recomendação:** adicionar limite de resposta, por exemplo 4 MB, com leitura via stream e cancelamento ao exceder o limite. Não remover limite nessa camada.

## Exemplos de refatoração

### Exportação idempotente SQLite/JSONL

```python
def export_pending_jsonl(self, jsonl_path: Path) -> int:
    rows = self.db.execute(
        """
        SELECT sequence, payload_json
        FROM jsonl_export_queue
        WHERE target = ?
        ORDER BY sequence
        """,
        (str(jsonl_path),),
    ).fetchall()

    exported = 0
    for row in rows:
        sequence = int(row["sequence"])

        if jsonl_contains_sequence(jsonl_path, sequence):
            with self.db:
                self.db.execute(
                    "DELETE FROM jsonl_export_queue WHERE sequence = ?",
                    (sequence,),
                )
            continue

        append_jsonl(jsonl_path, json.loads(row["payload_json"]))
        with self.db:
            self.db.execute(
                "DELETE FROM jsonl_export_queue WHERE sequence = ?",
                (sequence,),
            )
        exported += 1

    return exported
```

O identificador de sequência precisa fazer parte do registro exportado para que a operação seja idempotente.

### Lock com identidade completa

```python
def same_owner(lock: dict, pid: int) -> bool:
    return (
        lock.get("pid") == pid
        and lock.get("process_start_utc") == process_start_utc(pid)
    )

def remove_stale_lock(path: Path, expected: dict) -> bool:
    current = read_model_owner(path)
    if current != expected:
        return False

    stale_path = path.with_suffix(".stale")
    try:
        path.replace(stale_path)
    except FileNotFoundError:
        return False

    stale_path.unlink(missing_ok=True)
    return True
```

Para produção, é preferível um lock nativo ou lease SQLite em vez de depender de `unlink()`.

### Supervisor Hermes com encerramento de árvore

```python
process = subprocess.Popen(
    command,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
    text=True,
)

try:
    stdout, stderr = process.communicate(input=prompt, timeout=timeout_seconds)
except subprocess.TimeoutExpired:
    terminate_process_tree(process)
    process.wait(timeout=10)
    raise RuntimeError("hermes_timeout")
```

O ownership só deve ser liberado depois da confirmação de término.

### Limite de resposta ProjectX

```ts
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const reader = response.body?.getReader();

if (!reader) {
  throw new ProjectXApiError("empty_response", "ProjectX response has no body");
}

const chunks: Uint8Array[] = [];
let total = 0;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  total += value.byteLength;
  if (total > MAX_RESPONSE_BYTES) {
    await reader.cancel();
    throw new ProjectXApiError("response_too_large", "ProjectX response exceeded limit");
  }

  chunks.push(value);
}

const text = Buffer.concat(chunks).toString("utf8");
```

## Plano de ação recomendado

### P0 — antes de qualquer promoção armed

1. Corrigir dual-write e cursor parcial SQLite/JSONL.
2. Implementar lock atômico com identidade de processo.
3. Centralizar supervisor e encerramento de processos Hermes.
4. Executar fault-injection em crash durante exportação, lock e delivery.
5. Provar recuperação sem duplicidade, perda de decisão ou ambiguidade de intent.

### P1 — antes de soak prolongado

1. Indexar frames e remover buscas lineares.
2. Migrar learning para leitura incremental/SQLite.
3. Fazer pruning referencial e atomicamente seguro.
4. Adicionar limite de resposta ProjectX.
5. Criar métricas de heap, disco, backlog, pruning e latência.
6. Adicionar timeout de shutdown HTTP.

### P2 — melhoria arquitetural

1. Decompor `run-topstep-learning.py` e `parity.py`.
2. Centralizar política de retry e classificação de erros.
3. Centralizar sanitização de logs.
4. Publicar SLOs acionáveis para filas, recovery, streams e persistência.

## Veredito final

O projeto está em nível avançado de engenharia, mas ainda não deve ser considerado plenamente íntegro para operação financeira autônoma sem fechar os riscos C1–C4.

Do Glitch NT, a incorporação mais importante é pruning com preservação de referências. Do Hermes NT, o padrão de budget de prompt já foi incorporado corretamente; o próximo ganho é aplicar a mesma disciplina de boundedness ao armazenamento e ao learning histórico.

O limite de 64 KB do corpo recebido pelo gateway deve permanecer. O ponto que precisa de endurecimento é a resposta recebida do ProjectX, que atualmente não possui limite explícito.
