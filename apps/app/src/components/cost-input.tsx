// The adjustment form's cost box as a chunk of its own (step 14). MoneyInput brings decimal.js
// (about 13 KB gz); the form needs it only on "Stock in" lines, and with it inside, the form's
// chunk went over its 100 KB budget. A module of its own is what makes the bundler split it off.
export { MoneyInput } from '@omnivo/ui';
