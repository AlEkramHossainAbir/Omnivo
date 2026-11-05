import { UserIcon } from '@hugeicons/core-free-icons';
import { Input } from '@omnivo/ui';
import { lazy, Suspense } from 'react';

import type { CustomerPickerProps } from './customer-picker';

// Step 16: the customer filter of the eight sales lists (quotations to refunds), with the picker
// loaded after the page. The picker brings ui's Combobox, its Radix popover and their helpers
// (about 25 KB). The lists had grown to the edge of their 100 KB budget, and step 16 took four of
// them over; without the picker they are about 75 KB. The forms already load the same picker this
// way (receipt-form.tsx). Until it arrives, a disabled box of the same size holds its place, so the
// row does not jump.
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));

export function CustomerFilter(props: CustomerPickerProps) {
  return (
    <Suspense
      fallback={
        <Input
          id={props.id}
          icon={UserIcon}
          disabled
          aria-label={props['aria-label']}
          placeholder={props.allLabel}
        />
      }
    >
      <CustomerPicker {...props} />
    </Suspense>
  );
}
