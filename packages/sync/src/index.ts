// Two kinds of module. The pages of the app import the reads (queries, records, state, problems)
// and the types: none of them loads Dexie at run time, so a page that searches customers stays
// small. The code that opens the database and pulls (database, apply, engine, live, device)
// brings Dexie, and the app loads it once, lazily, after sign-in. `sideEffects: false` in
// package.json lets the bundler leave out the modules a chunk does not use.
export { applyPage } from './apply.js';
export {
  type CustomerRecord,
  databaseName,
  deleteLocalDatabase,
  type ProductRecord,
  type PullState,
  type Stored,
  SyncDatabase,
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
export { STORAGE_FAILED } from './problems.js';
export {
  allRows,
  customerPage,
  customerSummaryOf,
  findCustomers,
  findProducts,
  type LocalCustomerFilter,
  type LocalCustomerSort,
  type LocalPage,
  type LocalProductFilter,
  type LocalProductSort,
  PICKER_LIMIT,
  productPage,
  productSummaryOf,
} from './queries.js';
export { customerRecord, productRecord, searchText } from './records.js';
export { NO_PULL, readPullState } from './state.js';
