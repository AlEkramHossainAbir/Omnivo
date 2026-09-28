// Nest DI token — এগুলোর পেছনের টাইপ (Db, Auth, WithTenant…) interface/type, class না,
// তাই emitDecoratorMetadata টাইপ দেখে inject করতে পারে না; @Inject(TOKEN) লাগে
export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
export const WITH_TENANT = Symbol('WITH_TENANT');
export const WITH_USER = Symbol('WITH_USER');
export const REDIS = Symbol('REDIS');
export const AUTH = Symbol('AUTH');