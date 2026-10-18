# Architecture & Technical Decisions

Documento de decisões arquiteturais, garantias de consistência e trade-offs do **Distributed Wagering Processor**.

---

## 1. Visão Geral e Princípios Arquiteturais

O sistema adota os princípios de **Domain-Driven Design (DDD)** e **Arquitetura Hexagonal (Ports & Adapters)**:

```text
[HTTP API / SQS Consumer]  (Presentation & Messaging Adapters)
            │
            ▼
   [Application Layer]     (Use Cases & DTOs)
      │            │
      │            ▼
      │     [Domain Layer] (Aggregates, Value Objects, Domain Errors)
      ▼
[Persistence / Outbox]     (MikroORM, PostgreSQL 16, AWS SQS)
```

### Regras de Isolamento
1. **Domínio Puro (`src/domain/`)**: Livre de frameworks, ORMs ou decorators. Construtores privados e factories estáticas explícitas (`create`, `from`, `rehydrate`).
2. **Portas de Aplicação (`src/application/ports/`)**: A aplicação interage com a persistência exclusivamente por meio de interfaces (`UnitOfWorkPort`, `RepositoriesPort`).
3. **Persistência Desacoplada (`src/infrastructure/persistence/`)**: Entidades de banco mapeadas via `EntitySchema` do MikroORM, isolando as tabelas e colunas das classes de domínio.

---

## 2. Precisão Monetária (`Money`)

O JavaScript utiliza números em ponto flutuante de precisão dupla (IEEE-754), o que causa desvios inaceitáveis para sistemas financeiros (ex.: `0.1 + 0.2 = 0.30000000000000004`).

### Decisões Adotadas:
* **Classe `Decimal` (`decimal.js`)**: Encapsulada dentro do Value Object imutável `Money`.
* **Escala Fixa**: Obrigatória em exatamente **2 casas decimais** (`/^\d+\.\d{2}$/`).
* **Código de Moeda ISO-4217**: Validado por expressão regular (`/^[A-Z]{3}$/`).
* **Rejeição Estrita de Entradas Inválidas**: Rejeição imediata de `NaN`, `Infinity`, notação científica, valores negativos em contratos de entrada e zero negativo (`-0.00`).
* **Persistência**: Colunas `NUMERIC(20, 2)` no PostgreSQL com checagens no banco (`balance_amount >= 0`).

---

## 3. Modelo de Concorrência e Ordenação

### Unidade de Concorrência: `walletId`
Em plataformas de cassino online, a disputa de concorrência ocorre por carteira de jogador (múltiplos giros rápidos ou apostas simultâneas).

### Decisão: Pessimistic Write Locking (`SELECT ... FOR UPDATE`)
Optou-se por **Lock Pessimista por linha** na tabela `wallets`:
* **Por que não Optimistic Locking puro?** Em cenários de "hot wallet" com múltiplas apostas simultâneas ou rajadas de provedores, o lock otimista gera alto índice de conflitos de versão, retries em cascata, aumento de latência e consumo desnecessário de CPU e conexões.
* **Por que não Lock Global?** Um lock global (ex.: Redis distribuído compartilhado) criaria um gargalo crítico em todo o sistema.
* **Garantia com Pessimistic Locking**: Ao executar `SELECT * FROM wallets WHERE id = ? FOR UPDATE`, o PostgreSQL enfileira apenas as transações que afetam aquela carteira específica. Wallets distintas processam em paralelo sem qualquer contenção ou risco de deadlock.

### Cenário Obrigatório (Seção 8):
> Saldo inicial `100.00 BRL`. Duas apostas simultâneas de `80.00 BRL`.
1. A primeira transação obtém o lock de escrita da carteira e debita `80.00`, resultando em saldo `20.00` e gerando 1 lançamento `DEBIT` no ledger.
2. A segunda transação é liberada após o commit da primeira, lê o saldo atualizado de `20.00` e rejeita a aposta com `INSUFFICIENT_FUNDS`, mantendo a integridade sem gerar débito no ledger.

---

## 4. Livro-Razão Imutável (`WalletLedgerEntry`)

A integridade financeira depende de um histórico de lançamentos contábeis auditável e à prova de violação:

* **Saldo Materializado + Histórico Auditável**: A tabela `wallets` mantém o saldo atualizado materializado para consultas rápidas; a tabela `wallet_ledger_entries` registra cada movimentação de forma contábil.
* **Append-Only no PostgreSQL via Trigger**:
  ```sql
  CREATE TRIGGER trg_wallet_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_wallet_ledger_mutation();
  ```
  Qualquer tentativa de `UPDATE` ou `DELETE` no banco dispara uma exceção imediata.
* **Check de Consistência Algébrica no Banco**:
  ```sql
  CONSTRAINT chk_ledger_arithmetic_balanced CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)
  )
  ```
* **Reconciliação**: O endpoint `POST /wallets/:walletId/reconciliation` soma todos os créditos e subtrai os débitos do ledger, comparando com o saldo da carteira ($saldo == \sum créditos - \sum débitos$).

---

## 5. Idempotência e Hash Canônico

O sistema suporta entrega *at-least-once* através de:

1. **Header `Idempotency-Key`**: Fonte da verdade da transação.
2. **`payloadHash` Canônico (SHA-256)**:
   - Serialização canônica de JSON com ordenação determinística de chaves.
   - Considera apenas campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`).
   - Ignora metadados de transporte (`X-Correlation-Id`, timestamps de rede).
3. **Replay vs. Conflito**:
   - Requisição repetida com payload idêntico retorna a resposta original com `idempotentReplay: true`.
   - Mesma chave com payload alterado lança `IdempotencyConflictError` (HTTP 409).
4. **Prevenção de Dupla Reversão**:
   Índice parcial único no PostgreSQL:
   ```sql
   CREATE UNIQUE INDEX uq_wager_tx_single_processed_reversal
     ON wager_transactions (reference_transaction_id)
     WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
   ```

---

## 6. Mensageria, Outbox e Inbox Patterns

### Atomicidade Transacional
A alteração de saldo da carteira, a transação de aposta, o lançamento no ledger, o registro no inbox e o enfileiramento na outbox ocorrem na **mesma transação ACID** via `UnitOfWorkPort.runInTransaction`.

```text
BEGIN TRANSACTION;
  1. INSERT/SELECT inbox_messages ... ON CONFLICT DO NOTHING
  2. SELECT ... FROM wallets WHERE id = ? FOR UPDATE
  3. INSERT INTO wager_transactions ...
  4. UPDATE wallets SET balance_amount = ...
  5. INSERT INTO wallet_ledger_entries ...
  6. INSERT INTO outbox_messages ...
COMMIT;
```

### Transactional Outbox Worker
* **Múltiplos Publishers Concorrentes**: O worker utiliza `SELECT * FROM outbox_messages WHERE published_at IS NULL ... FOR UPDATE SKIP LOCKED`, garantindo que múltiplos processos publiquem sem colisões ou locks desnecessários.
* **Ordenação e Deduplicação no SQS FIFO**:
  - `MessageGroupId = aggregateId` (`walletId`): ordenação FIFO estrita por carteira.
  - `MessageDeduplicationId = id` (`eventId`): deduplicação nativa na janela do SQS.

### Reconciliação de Referências Fora de Ordem (`PENDING_REFERENCE`)
Quando um `REFUND` ou `ROLLBACK` chega antes da `BET` correspondente:
1. A transação é aceita e persistida como `PENDING_REFERENCE`.
2. O `PendingReferencesWorker` avalia periodicamente as pendências vencidas com backoff exponencial.
3. Se a referência chega e é processada, a reversão é concluída. Se atingir o limite de tentativas (8 tentativas), a transação é rejeitada com `REFERENCE_NOT_FOUND_TIMEOUT`.

---

## 7. Taxonomia de Falhas e Mapeamento HTTP

| Código de Falha | HTTP Status | Descrição |
|---|---|---|
| `INSUFFICIENT_FUNDS` | 422 | Saldo insuficiente para efetuar `BET` |
| `NEGATIVE_BALANCE_ON_REVERSAL` | 422 | Saldo insuficiente para estornar crédito em `ROLLBACK` |
| `DUPLICATE_REVERSAL` | 422 | Tentativa de estornar duas vezes a mesma referência |
| `REFERENCE_CONTEXT_MISMATCH` | 422 | Divergência de rodada, moeda, jogador ou carteira na referência |
| `INVALID_REFERENCE_KIND` | 422 | `REFUND` em operação que não seja `BET` |
| `REFERENCE_NOT_PROCESSED` | 422 | Referência ainda não concluída com sucesso |
| `REFERENCE_NOT_FOUND_TIMEOUT` | 422 | Esgotado o tempo de espera pela transação referenciada |
| `IDEMPOTENCY_CONFLICT` | 409 | Mesma idempotency key utilizada com payload diferente |
| `WALLET_ALREADY_EXISTS` | 409 | Tentativa de criar carteira duplicada para o mesmo jogador e moeda |
| `WALLET_NOT_FOUND` | 404 | Carteira inexistente |
| `TRANSACTION_NOT_FOUND` | 404 | Transação inexistente |
| `INVALID_MONEY` / `CURRENCY_MISMATCH` | 400 | Formato monetário ou moeda divergente |

---

## 8. Observabilidade

* **Logs Estruturados**: Formato JSON com inclusão obrigatória de `correlationId`, `walletId`, `providerId` e `transactionId`. Payloads financeiros sensíveis são omitidos.
* **Métricas Prometheus (`/metrics`)**:
  - `wagering_transactions_total`: contador de transações por tipo, status e provedor.
  - `wagering_idempotent_replays_total`: contador de replays idempotentes detectados.
  - `wagering_transaction_duration_seconds`: histograma de latência com buckets de percentis.
  - `wagering_outbox_lag_seconds`: idade em segundos da mensagem pendente mais antiga na outbox.
  - `wagering_outbox_pending_count`: total de mensagens pendentes na outbox.
* **Health Checks**:
  - `/health/live`: probe de vivacidade do processo.
  - `/health/ready`: probe de prontidão validando ativamente a conectividade com o PostgreSQL e o LocalStack SQS.

---

## 9. Autenticação e Pontos de Extensão

Conforme definido na **Seção 2** das diretrizes:
* Endpoints de liveness e readiness são públicos.
* Mensagens recebidas do SQS são tratadas como tráfego de infraestrutura interna confiável.
* Para os endpoints HTTP públicos de provedores, a arquitetura está preparada para integração com Identity Provider externo (Zitadel ou Keycloak via OIDC), através de ponto de extensão em `AuthGuard` ou `ProviderIdentityPort`.

---

## 10. Limitações e Melhorias Futuras

1. **Partição por Sharding de Wallets**: Para volumes em escala de milhões de jogadores simultâneos, a base de dados pode ser particionada por hash de `wallet_id`.
2. **Double-Entry Bookkeeping Completo**: Introdução opcional de contas patrimoniais do cassino (plataforma vs. jogador) em estrutura contábil formal de partidas dobradas.
3. **Distribuição Multi-Região**: Replicação de filas SQS e banco de dados distribuído para failover geográfico.
