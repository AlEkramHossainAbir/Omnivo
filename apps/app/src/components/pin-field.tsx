import { LockKeyholeIcon } from '@hugeicons/core-free-icons';
import { TextField, type TextFieldProps } from '@omnivo/ui';

import { pinDigits } from '../lib/pin';

// Step 19b: a PIN box (decision 7): the input's look, masked, with the phone's number pad. What is
// typed goes through pinDigits, so a Bangla keyboard works and the value is always ASCII digits.
// Controlled (react-hook-form's Controller): register() would keep what was typed, not the digits.
export function PinField({
  value,
  onChange,
  ...field
}: Omit<TextFieldProps, 'value' | 'onChange' | 'type'> & {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <TextField
      icon={LockKeyholeIcon}
      type="password"
      inputMode="numeric"
      // A password manager must not offer to save the device PIN as the site's password
      autoComplete="off"
      {...field}
      value={value}
      onChange={(event) => {
        onChange(pinDigits(event.target.value));
      }}
    />
  );
}
