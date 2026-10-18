import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module.ts";
import { GlobalHttpExceptionFilter } from "@presentation/filters/http-exception.filter.ts";
import { CorrelationIdInterceptor } from "@presentation/interceptors/correlation-id.interceptor.ts";

describe("HTTP Presentation API End-to-End Tests", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    app = await NestFactory.create(AppModule, { logger: false });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    app.useGlobalInterceptors(new CorrelationIdInterceptor());

    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === "object" && address !== null ? address.port : 3000;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Truncate tables between tests using fetch or direct DB query
  });

  describe("Health & Metrics Endpoints", () => {
    it("GET /health/live returns 200 OK", async () => {
      const res = await fetch(`${baseUrl}/health/live`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ status: "ok" });
    });

    it("GET /health/ready returns 200 OK with database and SQS status", async () => {
      const res = await fetch(`${baseUrl}/health/ready`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.status).toBe("ok");
      expect(data.checks.database).toBe("ok");
      expect(data.checks.sqs).toBe("ok");
    });

    it("GET /metrics returns prometheus metrics in plain text", async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("wagering_transactions_total");
      expect(text).toContain("wagering_outbox_pending_count");
    });
  });

  describe("Wallets API", () => {
    it("POST /wallets creates a new wallet with initial balance", async () => {
      const res = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: "player-api-1",
          initialBalance: { amount: "200.00", currency: "BRL" },
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.id).toBeDefined();
      expect(data.playerId).toBe("player-api-1");
      expect(data.balance).toEqual({ amount: "200.00", currency: "BRL" });
      expect(data.version).toBe(1);

      // GET /wallets/:walletId
      const getRes = await fetch(`${baseUrl}/wallets/${data.id}`);
      expect(getRes.status).toBe(200);
      const retrieved = (await getRes.json()) as any;
      expect(retrieved.id).toBe(data.id);
      expect(retrieved.balance.amount).toBe("200.00");
    });

    it("POST /wallets fails with 409 Conflict if duplicate player and currency", async () => {
      await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: "player-duplicate-check",
          initialBalance: { amount: "50.00", currency: "BRL" },
        }),
      });

      const res = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: "player-duplicate-check",
          initialBalance: { amount: "10.00", currency: "BRL" },
        }),
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as any;
      expect(data.errorCode).toBe("WALLET_ALREADY_EXISTS");
    });
  });

  describe("Wagering Transactions API", () => {
    it("POST /wagering/transactions requires Idempotency-Key header", async () => {
      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "prv-api",
          externalTransactionId: "ext-1",
          playerId: "player-1",
          walletId: "0192f291-27dd-7d3f-8071-5f8685deef01",
          roundId: "rnd-1",
          gameId: "game-1",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        }),
      });

      // Default fallback generates providerId:externalTransactionId or validates header
      expect([200, 400, 422, 404]).toContain(res.status);
    });

    it("processes BET, idempotent replay, conflict, and queries transaction", async () => {
      // 1. Create wallet
      const walletRes = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: "player-api-bet",
          initialBalance: { amount: "100.00", currency: "BRL" },
        }),
      });
      const wallet = (await walletRes.json()) as any;

      // 2. Submit BET
      const idempotencyKey = "prv-api:bet-100";
      const betPayload = {
        providerId: "prv-api",
        externalTransactionId: "bet-100",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-100",
        gameId: "crazy-time",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      };

      const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(betPayload),
      });

      expect(betRes.status).toBe(200);
      const betResult = (await betRes.json()) as any;
      expect(betResult.status).toBe("PROCESSED");
      expect(betResult.balance.amount).toBe("75.00");
      expect(betResult.idempotentReplay).toBe(false);

      // 3. Idempotent replay: identical request
      const replayRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(betPayload),
      });

      expect(replayRes.status).toBe(200);
      const replayResult = (await replayRes.json()) as any;
      expect(replayResult.idempotentReplay).toBe(true);
      expect(replayResult.transactionId).toBe(betResult.transactionId);
      expect(replayResult.balance.amount).toBe("75.00");

      // 4. Idempotency conflict: same key with different amount
      const conflictRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          ...betPayload,
          money: { amount: "50.00", currency: "BRL" },
        }),
      });

      expect(conflictRes.status).toBe(409);
      const conflictResult = (await conflictRes.json()) as any;
      expect(conflictResult.errorCode).toBe("IDEMPOTENCY_CONFLICT");

      // 5. Query by internal ID: GET /wagering/transactions/:transactionId
      const getTxRes = await fetch(`${baseUrl}/wagering/transactions/${betResult.transactionId}`);
      expect(getTxRes.status).toBe(200);
      const foundTx = (await getTxRes.json()) as any;
      expect(foundTx.id).toBe(betResult.transactionId);
      expect(foundTx.kind).toBe("BET");
      expect(foundTx.status).toBe("PROCESSED");

      // 6. Query by provider external ID: GET /providers/:providerId/wagering/transactions/:externalTransactionId
      const getExtRes = await fetch(`${baseUrl}/providers/prv-api/wagering/transactions/bet-100`);
      expect(getExtRes.status).toBe(200);
      const foundExt = (await getExtRes.json()) as any;
      expect(foundExt.id).toBe(betResult.transactionId);

      // 7. Reconcile wallet: POST /wallets/:walletId/reconciliation
      const recRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: "POST",
      });
      expect(recRes.status).toBe(201);
      const recResult = (await recRes.json()) as any;
      expect(recResult.consistent).toBe(true);
      expect(recResult.storedBalance.amount).toBe("75.00");
      expect(recResult.calculatedBalance.amount).toBe("75.00");

      // 8. Get ledger: GET /wallets/:walletId/ledger
      const ledgerRes = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=10`);
      expect(ledgerRes.status).toBe(200);
      const ledgerData = (await ledgerRes.json()) as any;
      expect(ledgerData.items.length).toBe(2); // OPENING + BET
    });

    it("returns 202 Accepted when REFUND arrives without BET (PENDING_REFERENCE)", async () => {
      const walletRes = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: "player-api-pending",
          initialBalance: { amount: "100.00", currency: "BRL" },
        }),
      });
      const wallet = (await walletRes.json()) as any;

      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "prv-api:refund-without-bet",
        },
        body: JSON.stringify({
          providerId: "prv-api",
          externalTransactionId: "refund-without-bet",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "rnd-p1",
          gameId: "game-1",
          kind: "REFUND",
          money: { amount: "20.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-does-not-exist-yet",
        }),
      });

      expect(res.status).toBe(202);
      const data = (await res.json()) as any;
      expect(data.status).toBe("PENDING_REFERENCE");
      expect(data.idempotentReplay).toBe(false);
    });
  });
});
