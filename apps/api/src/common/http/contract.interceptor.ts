import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';

import { routeOf } from './endpoint.js';

// handler যা ফেরত দেয় তা বাইরে যাওয়ার আগে চুক্তির response schema দিয়ে parse:
// ১) চুক্তিতে নেই এমন ফিল্ড (ভুল করে যোগ হওয়া password hash, অন্য টেন্যান্টের id) কেটে বাদ পড়ে —
//    z.object() অচেনা key রাখে না;
// ২) চুক্তির সাথে না মিললে ক্লায়েন্টের কাছে ভাঙা ডেটা না গিয়ে 500 + লগে ঠিক কোন ফিল্ড
@Injectable()
export class ContractInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const route = routeOf(context);
    if (!route || route.status === 204) return next.handle();

    return next.handle().pipe(
      map((value: unknown) => {
        const result = route.response.safeParse(value);
        if (!result.success) {
          throw new Error(
            `${route.method} ${route.path} returned a body that breaks its contract:\n${z.prettifyError(result.error)}`,
          );
        }
        return result.data;
      }),
    );
  }
}
