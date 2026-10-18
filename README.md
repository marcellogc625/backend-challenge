# Distributed Wagering Processor 🦧

Serviço financeiro distribuído de alta consistência para processamento de transações de apostas de múltiplos provedores de jogos de iGaming. Construído com **Bun**, **TypeScript**, **NestJS**, **MikroORM**, **PostgreSQL 16** e **AWS SQS FIFO** (via LocalStack).

---

## 🚀 Requisitos e Setup Rápido

### Pré-requisitos
* [Bun](https://bun.sh) (v1.x+)
* [Docker](https://www.docker.com/) e Docker Compose

### 1. Inicializar Infraestrutura Local
Inicie o PostgreSQL 16 e o LocalStack (com as filas SQS FIFO criadas automaticamente):

```bash
docker compose up -d
```

### 2. Configurar Variáveis de Ambiente
Copie o arquivo de exemplo para `.env`:

```bash
cp .env.example .env
```

### 3. Instalar Dependências e Executar Migrations
```bash
bun install
bun run migration:up
```

### 4. Executar o Servidor em Desenvolvimento
```bash
bun run dev
```
A API estará disponível em `http://localhost:3000`.

---

## 🧪 Suíte de Testes

O projeto conta com testes unitários, testes de integração reais (Postgres e LocalStack SQS), testes de concorrência com disputa de saldo e teste de carga:

```bash
# Executa todos os testes (unidade + integração + concorrência)
bun test

# Testes unitários (Money, Wallet, WagerTransaction, Messaging)
bun run test:unit

# Testes de integração (PostgreSQL constraints, use cases, SQS FIFO)
bun run test:integration

# Testes de concorrência real (50 requisições simultâneas, hot wallet, skip locked)
bun run test:concurrency

# Teste de carga com métricas de throughput e percentis p50/p95/p99
bun run test:load

# Checagem estrita de tipos TypeScript
bun run typecheck
```

---

## 📖 Endpoints da API HTTP

### 1. Carteiras
* `POST /wallets`: Cria uma nova carteira. Se `initialBalance > 0`, registra transação interna `OPENING` e lançamento contábil `CREDIT`.
* `GET /wallets/:walletId`: Consulta dados e saldo materializado da carteira.
* `GET /wallets/:walletId/ledger?limit=50&cursor=...`: Consulta paginada e estável dos lançamentos do livro-razão.
* `POST /wallets/:walletId/reconciliation`: Reconciliação em tempo real entre o saldo materializado e a soma aritmética de débitos e créditos do ledger.

### 2. Apostas e Transações
* `POST /wagering/transactions`: Submete transação financeira (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`).
  * Header obrigatório: `Idempotency-Key` (ex: `provider-a:tx-100`).
  * `200 OK`: Transação processada com sucesso (`PROCESSED`).
  * `202 Accepted`: Referência ainda não encontrada (`PENDING_REFERENCE`).
  * `422 Unprocessable Entity`: Rejeição por regra de negócio (ex: `INSUFFICIENT_FUNDS`, `NEGATIVE_BALANCE_ON_REVERSAL`, `DUPLICATE_REVERSAL`).
  * `409 Conflict`: Mesma chave de idempotência reenviada com payload diferente (`IDEMPOTENCY_CONFLICT`).
* `GET /wagering/transactions/:transactionId`: Consulta transação por UUID interno.
* `GET /providers/:providerId/wagering/transactions/:externalTransactionId`: Consulta transação por identificador do provedor.

### 3. Observabilidade e Health Checks
* `GET /health/live`: Liveness probe (processo vivo).
* `GET /health/ready`: Readiness probe (conectividade ativa com PostgreSQL e LocalStack SQS).
* `GET /metrics`: Métricas no formato Prometheus (`wagering_transactions_total`, `wagering_transaction_duration_seconds`, `wagering_outbox_lag_seconds`, etc.).

---

## 📂 Estrutura do Projeto

```text
src/
├── domain/                    # Núcleo DDD puro e isolado
│   ├── shared/                # Money (Decimal.js), Hash Canônico SHA-256, DomainErrors
│   ├── wallet/                # Wallet Aggregate Root e WalletLedgerEntry (imutável)
│   ├── wagering/              # WagerTransaction (State machine: BET, WIN, LOSS, REFUND, ROLLBACK)
│   └── messaging/             # Envelope IntegrationEvent, InboxMessage, OutboxMessage
├── application/               # Casos de uso e portas desacopladas
│   ├── ports/                 # RepositoriesPort e UnitOfWorkPort
│   ├── dto/                   # DTOs de entrada e saída
│   └── use-cases/             # OpenWallet, ProcessWagerTransaction, Reconcile, etc.
├── infrastructure/            # Implementações de banco e mensageria
│   ├── persistence/           # MikroORM (Postgres), Migrations SQL, Triggers imutáveis
│   └── messaging/             # AWS SQS FIFO Consumer, Outbox Publisher e Pending Ref Worker
└── presentation/              # Camada HTTP NestJS
    ├── controllers/           # Wallet, Wagering, Health e Metrics
    ├── filters/               # GlobalHttpExceptionFilter
    └── interceptors/          # CorrelationIdInterceptor
```

Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para detalhes profundos sobre as decisões arquiteturais, modelo de concorrência e garantias de integridade.
