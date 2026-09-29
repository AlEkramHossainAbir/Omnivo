import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { toProblem } from './problem.js';

// @Catch() খালি = সব কিছু ধরে: AppError, Nest-এর HttpException, আর অপ্রত্যাশিত bug।
// প্রতিটা error response একই আকারে (RFC 9457), তাই ক্লায়েন্টের একটাই parser
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const body = toProblem(error, request.id);

    // 4xx = ক্লায়েন্টের ভুল, স্বাভাবিক; 5xx = আমাদের bug — পুরো stack লগে, requestId দিয়ে খোঁজা যায়
    if (body.status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} failed [${body.requestId ?? '-'}]`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    void reply.status(body.status).type('application/problem+json').send(body);
  }
}
