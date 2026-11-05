import type { ReactNode } from 'react';
import {
  type Control,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
  useController,
} from 'react-hook-form';

import { describedBy, Field } from './field.js';

export type FormFieldControlProps<
  TValues extends FieldValues,
  TName extends FieldPath<TValues>,
> = ControllerRenderProps<TValues, TName> & {
  id: string;
  invalid: boolean;
  'aria-describedby': string | undefined;
};

interface FormFieldProps<
  TValues extends FieldValues,
  TName extends FieldPath<TValues>,
  TTransformed,
> {
  // TTransformed: zodResolver-এর output টাইপ (trim/transform-এর পরে) input থেকে আলাদা হতে পারে
  control: Control<TValues, unknown, TTransformed>;
  // FieldPath<TValues>: শুধু ফর্মে আসলেই আছে এমন নাম — 'emial' লিখলে compile error
  name: TName;
  label: string;
  optional?: boolean | undefined;
  hint?: string | undefined;
  children: (control: FormFieldControlProps<TValues, TName>) => ReactNode;
}

// নিজস্ব control (MoneyInput, DatePicker) react-hook-form-এর সাথে জোড়া: মান, error আর
// label-এর id এক জায়গায়। সাধারণ টেক্সট ইনপুটে এটা লাগে না — TextField-এ register() যথেষ্ট
export function FormField<
  TValues extends FieldValues,
  TName extends FieldPath<TValues>,
  TTransformed = TValues,
>({
  control,
  name,
  label,
  optional,
  hint,
  children,
}: FormFieldProps<TValues, TName, TTransformed>) {
  const { field, fieldState } = useController({ control, name });
  const error = fieldState.error?.message;
  // ফর্মের ভেতরে name অনন্য; একই পেজে দুটো ফর্মে একই name থাকলে পরে useId() যোগ করতে হবে
  const id = name;
  return (
    <Field id={id} label={label} optional={optional} hint={hint} error={error}>
      {children({
        ...field,
        id,
        invalid: error !== undefined,
        'aria-describedby': describedBy(id, error, hint),
      })}
    </Field>
  );
}
