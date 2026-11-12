// Step 26c: a phone as people read it. The orders keep the 11 digits plain ("01786120356",
// decision 11); the dialog and the order page show them as Bangladeshis write a mobile number,
// "01786 120356" (CLAUDE.md → Order confirmed dialog). Anything that is not 11 digits is shown as
// it is: a wrong space is better than a dropped digit.
export function spacedPhone(phone: string): string {
  return /^\d{11}$/.test(phone) ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone;
}
