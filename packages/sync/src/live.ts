import { liveQuery } from 'dexie';

// Runs a read and runs it again whenever a write (a pull, in this tab or another) changes what it
// read: Dexie's liveQuery. The app's hook (useLocalQuery) gets this function from the code that
// opened the database, so its pages never import Dexie themselves.
export type Watch = <T>(
  query: () => Promise<T>,
  next: (value: T) => void,
  fail: (error: unknown) => void,
) => () => void;

export const watch: Watch = (query, next, fail) => {
  const subscription = liveQuery(query).subscribe({ next, error: fail });
  return () => {
    subscription.unsubscribe();
  };
};
