import { createHash } from "node:crypto";
import type { MoneyProps } from "./money";

export interface WagerPayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const entries = sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`);

  return `{${entries.join(",")}}`;
}

export function computeCanonicalHash(payload: unknown): string {
  const canonical = canonicalizeJson(payload);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function computeWagerPayloadHash(input: WagerPayloadHashInput): string {
  const businessFields: Record<string, unknown> = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: input.money.amount,
      currency: input.money.currency,
    },
  };
  if (input.referenceExternalTransactionId !== undefined) {
    businessFields.referenceExternalTransactionId = input.referenceExternalTransactionId;
  }
  return computeCanonicalHash(businessFields);
}
