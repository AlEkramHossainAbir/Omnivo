// Two kinds of module. The pages of the app import the reads (queries, records, state, problems),
// the outbox's saves (outbox, overlay, prices; step 18b), the key's code (crypto, keys; step 19b)
// and the types: none of them loads Dexie at run time, so a page that searches customers or a
// form that saves offline stays small. The code that opens the database and syncs (database,
// copy, apply, push, engine, live, device) brings Dexie, and the app loads it once, lazily, after
// sign-in. `sideEffects: false` in package.json lets the bundler leave out the modules a chunk
// does not use.
export { applyPage, type SealedChanges, sealChanges, writeSealed } from './apply.js';
export { LocalCopy, Mirror } from './copy.js';
export { type Box, isPin, PIN_ITERATIONS, PIN_LENGTH } from './crypto.js';
export {
  databaseName,
  deleteLocalDatabase,
  type MirroredTable,
  type NoticeRow,
  type OutboxBody,
  type OutboxEntry,
  type OutboxRow,
  type OutboxStatus,
  type PriceListItemRow,
  type ProductRow,
  type PullState,
  type SealedRow,
  type StockRow,
  SyncDatabase,
  type SyncNoticeRecord,
  type SyncTableName,
  TABLE_OF,
  type TableMark,
} from './database.js';
export {
  type DeviceIdentity,
  deviceNameParts,
  deviceStorageKey,
  forgetDevice,
  type IdentityStorage,
  newDeviceId,
  readDevice,
  saveDevice,
} from './device.js';
export { type LockRunner, SyncEngine, type SyncEngineOptions, type SyncStatus } from './engine.js';
export {
  type KeyProblem,
  type KeyRecord,
  type KeyResult,
  type KeyStatus,
  forgetPin,
  keyStatus,
  markPinAsked,
  MAX_WRONG_PINS,
  openKey,
  type PinWrap,
  renewServerKey,
  setPin,
  type Unlock,
} from './keys.js';
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
export {
  type CustomerRecord,
  customerRecord,
  type ProductRecord,
  productIndex,
  productRecord,
  searchText,
} from './records.js';
export { NO_PULL, readPullState, syncedAtOf } from './state.js';
