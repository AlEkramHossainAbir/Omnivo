import type { ShippingConfig } from '../config.js';
import type { CourierAdapters } from './courier.js';
import { FakeCourier } from './fake-courier.js';
import { SteadfastAdapter } from './steadfast-adapter.js';

// Step 28a: the adapters of this process, by COURIER_MODE (config.ts). Its own file, like 27d's
// create-gateway.ts, so the classes can import courier.ts without a circle. The API's InfraModule
// and the WorkerModule both provide it as COURIERS; a test puts its own in its place
export function createCouriers(config: ShippingConfig): CourierAdapters {
  if (config.mode === 'fake') return { steadfast: new FakeCourier() };
  return { steadfast: new SteadfastAdapter() };
}
