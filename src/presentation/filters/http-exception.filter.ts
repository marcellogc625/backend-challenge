import { TransactionNotFoundError, WalletAlreadyExistsError, WalletNotFoundError } from "@application/errors/application-errors.ts";
import {
  CurrencyMismatchError,
  DomainError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidTransactionRuleError,
  InvalidTransactionStateError,
} from "@domain/shared/domain-errors.ts";
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = "INTERNAL_SERVER_ERROR";
    let message = "An unexpected internal error occurred";
    let details: unknown = undefined;

    if (exception instanceof IdempotencyConflictError) {
      status = HttpStatus.CONFLICT;
      errorCode = "IDEMPOTENCY_CONFLICT";
      message = exception.message;
    } else if (exception instanceof WalletAlreadyExistsError) {
      status = HttpStatus.CONFLICT;
      errorCode = exception.code;
      message = exception.message;
    } else if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      status = HttpStatus.NOT_FOUND;
      errorCode = exception.code;
      message = exception.message;
    } else if (exception instanceof InvalidMoneyError || exception instanceof CurrencyMismatchError || exception instanceof InvalidTransactionRuleError) {
      status = HttpStatus.BAD_REQUEST;
      errorCode = (exception as DomainError).code;
      message = exception.message;
    } else if (exception instanceof InvalidTransactionStateError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      errorCode = exception.code;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === "object" && res !== null) {
        const body = res as Record<string, unknown>;
        errorCode = String(body.error ?? "HTTP_ERROR");
        message = Array.isArray(body.message) ? body.message.join("; ") : String(body.message ?? exception.message);
        details = body.message;
      } else {
        message = String(res);
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    response.status(status).json({
      statusCode: status,
      errorCode,
      message,
      ...(details !== undefined ? { details } : {}),
      timestamp: new Date().toISOString(),
    });
  }
}
