import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { type Observable } from "rxjs";

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const correlationId = (req.headers["x-correlation-id"] as string | undefined) ?? (req.headers["correlation-id"] as string | undefined) ?? randomUUID();

    req.headers["x-correlation-id"] = correlationId;
    res.setHeader("X-Correlation-Id", correlationId);

    return next.handle();
  }
}
