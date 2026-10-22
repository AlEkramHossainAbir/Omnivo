// Two kinds of module. The pages of the app import the reads (queries, records, state, problems),
// the outbox's saves (outbox, overlay, prices; step 18b) and the types: none of them loads Dexie
// at run time, so a page that searches customers or a form that saves offline stays small. The
// code that opens the database and syncs (database, apply, push, engine, live, device) brings
// Dexie, and the app loads it once, lazily, after sign-in. `sideEffects: false` in
// package.json lets the bundler leave out the modules a chunk does not use.
export { applyPage, writeChanges } from './apply.js';
export {
  type CustomerRecord,
  databaseName,
  deleteLocalDatabase,
  type OutboxEntry,
  type OutboxStatus,
  type ProductRecord,
  type PullState,
  type Stored,
  SyncDatabase,
  type SyncNoticeRecord,
  type SyncTableName,
  TABLE_OF,
} from './database.js';
export {
  type DeviceIdentity,
  deviceNameParts,
  type IdentityStorage,
  newDeviceId,
  readDevice,
  saveDevice,
} from './device.js';
export { type LockRunner, SyncEngine, type SyncEngineOptions, type SyncStatus } from './engine.js';
export { type Watch, watch } from './live.js';
export {
  addressChangesOf,
  type CustomerSave,
  customerChangesOf,
  dependentsOf,
  discardEntry,
  dismissNotice,
  isOpen,
  type OrderSave,
  retryEntry,
  saveCustomer,
  saveOrderDraft,
  type SaveResult,
} from './outbox.js';
export { changedCustomer, createdCustomer, projectCustomer } from './overlay.js';
export { lookUpPrices, productsOfVariants } from './prices.js';
export { STORAGE_FAILED } from './problems.js';
export {
  applyAnswers,
  NO_PUSH,
  pickBatch,
  type PushOutcome,
  releaseBatch,
  resetSending,
  takeBatch,
} from './push.js';
export {
  allRows,
  customerCommands,
  customerPage,
  customerSummaryOf,
  findCustomers,
  findProducts,
  localCustomer,
  type LocalCustomerFilter,
  type LocalCustomerPage,
  type LocalCustomerSort,
  type LocalPage,
  type LocalProductFilter,
  type LocalProductSort,
  outboxCounts,
  outboxEntries,
  outboxOf,
  PICKER_LIMIT,
  productPage,
  productSummaryOf,
  syncNotices,
} from './queries.js';
export { customerRecord, productRecord, searchText } from './records.js';
export { NO_PULL, readPullState } from './state.js';
