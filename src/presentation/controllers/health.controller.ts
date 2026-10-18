import { type UnitOfWorkPort, UNIT_OF_WORK_PORT } from "@application/ports/unit-of-work.port.ts";
import { ListQueuesCommand } from "@aws-sdk/client-sqs";
import { createSqsClient, getSqsConfig } from "@infrastructure/messaging/sqs.config.ts";
import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import type { Response } from "express";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res() res: Response): Promise<void> {
    let dbOk = false;
    let sqsOk = false;

    // Checagem PostgreSQL
    try {
      const readCtx = this.uow.getReadContext();
      (await (readCtx.wallets as any).em?.execute("SELECT 1")) ?? Promise.resolve();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    // Checagem LocalStack SQS
    try {
      const client = createSqsClient(getSqsConfig());
      await client.send(new ListQueuesCommand({ MaxResults: 1 }));
      client.destroy();
      sqsOk = true;
    } catch {
      sqsOk = false;
    }

    const isReady = dbOk && sqsOk;
    res.status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: isReady ? "ok" : "degraded",
      checks: {
        database: dbOk ? "ok" : "unreachable",
        sqs: sqsOk ? "ok" : "unreachable",
      },
      timestamp: new Date().toISOString(),
    });
  }
}
