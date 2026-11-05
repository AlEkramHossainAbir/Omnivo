import { PartyPicker, type PartyPickerProps } from './party-picker';

export type CustomerPickerProps = PartyPickerProps;

// The customer box of the sales forms and the sales lists' filter (steps 15a–15d). Step 17a moved
// the box itself to party-picker.tsx, which serves the suppliers too; this name stays, so none of
// those screens changes.
export function CustomerPicker(props: CustomerPickerProps) {
  return <PartyPicker role="customer" {...props} />;
}
