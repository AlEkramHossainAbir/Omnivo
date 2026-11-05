import { useEffect, useState } from 'react';

// What the person typed, a moment after they stop: one request per word, not per key. Moved here
// from routes/products.tsx in step 13: the stock pages and the item picker search the same way.
export function useDebounced(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}
