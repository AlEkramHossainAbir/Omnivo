import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'omnivo:isPublic';

// AuthGuard global — ডিফল্টে প্রতিটা রুট লগইন চায়; শুধু এই decorator দিলে খোলা
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
