// Nest DI token — এগুলোর পেছনের টাইপ (Db, Auth, WithTenant…) interface/type, class না,
// তাই emitDecoratorMetadata টাইপ দেখে inject করতে পারে না; @Inject(TOKEN) লাগে
export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
export const WITH_TENANT = Symbol('WITH_TENANT');
export const WITH_USER = Symbol('WITH_USER');
export const REDIS = Symbol('REDIS');
export const AUTH = Symbol('AUTH');
// Only the storage part of the config: the worker has it too, without the API's auth secrets
export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');

// The worker's second database pool, as omnivo_worker: only the outbox relay and its cleanup use it
export const RELAY_DB = Symbol('RELAY_DB');

// Step 27d: the payment part of the config (the API's and the worker's), and the gateway made from
// it (payments/gateway.ts)
export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
