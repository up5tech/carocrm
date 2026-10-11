import { AppError, InternalServerError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import type { ExecutionContext } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

@Catch()
export class GlobalExceptionFilter {
  catch(exception: unknown, host: ExecutionContext): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();

    let error: AppError;
    if (exception instanceof AppError) {
      error = exception;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const mapped =
        status === 401 ? 'AUTHENTICATION_REQUIRED' :
        status === 403 ? 'AUTHORIZATION_DENIED' :
        status === 404 ? 'RECORD_NOT_FOUND' :
        status === 409 ? 'DUPLICATE_RECORD' :
        status === 422 ? 'VALIDATION_FAILED' : 'BAD_REQUEST';
      error = new AppError(mapped, exception.message, undefined, status);
    } else if (exception instanceof Error && 'validation' in exception) {
      error = new AppError('VALIDATION_FAILED', 'Validation failed.', { details: String(exception) }, 422);
    } else {
      error = new InternalServerError(exception instanceof Error ? exception.message : 'Internal server error.');
    }

    const body: ErrorBody = {
      error: {
        code: error.code,
        message: error.message,
      },
    };
    if (error.details !== undefined) body.error.details = error.details;

    if (error.statusCode >= 500) {
      log.error({ err: exception, requestId: request.id, path: request.url }, 'unhandled error');
    } else {
      log.debug({ code: error.code, requestId: request.id, path: request.url }, 'request error');
    }

    void reply.status(error.statusCode).send(body);
  }
}
