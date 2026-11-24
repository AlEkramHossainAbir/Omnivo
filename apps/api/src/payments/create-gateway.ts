import type { PaymentsConfig } from '../config.js';
import { FakeGateway } from './fake-gateway.js';
import type { PaymentGateway } from './gateway.js';
import { SslcommerzGateway } from './sslcommerz-gateway.js';

// Step 27d: the one gateway of this process, by PAYMENT_GATEWAY (config.ts). Its own file, so the
// two classes can import gateway.ts's types and helpers without a circle. The API's InfraModule
// and the WorkerModule both provide it as PAYMENT_GATEWAY; a test puts its own in its place
export function createGateway(config: PaymentsConfig): PaymentGateway {
  return config.gateway === 'fake' ? new FakeGateway() : new SslcommerzGateway();
}
