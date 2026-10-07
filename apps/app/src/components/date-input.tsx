// The product form's date picker as a chunk of its own (step 15a), like cost-input.tsx in step 14.
// DatePicker brings the popover (about 23 KB gz with its focus and scroll helpers); the form needs
// it only for a custom field of type date, and with it inside, the form's chunk went over its
// 100 KB budget once the VAT rate came in. A module of its own is what makes the bundler split it off.
export { DatePicker } from '@omnivo/ui';
