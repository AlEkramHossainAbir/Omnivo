import { z } from 'zod';

// API যত রকম error পাঠায় (আর ক্লায়েন্ট নিজে যত বানায়) তার পুরো তালিকা। UI-র লেখা থাকে
// i18n-এর errors.*-এ — এখানে নতুন code যোগ করে en.ts-এ অনুবাদ না লিখলে typecheck fail করে
export const ERROR_CODES = [
  // সাধারণ যাচাই: schema নিজে code না দিলে Zod-এর issue থেকে আসে (contractErrorMap)
  'invalid_input',
  'required',
  'too_short',
  'too_long',
  'too_small',
  'too_large',
  'invalid_format',
  'invalid_value',
  // নির্দিষ্ট ফিল্ডের যাচাই
  'company_name_required',
  'full_name_required',
  'email_invalid',
  'email_taken',
  'password_required',
  'password_too_short',
  'password_too_long',
  'slug_too_short',
  'slug_too_long',
  'slug_format',
  'slug_reserved',
  'slug_taken',
  'bin_format',
  'timezone_invalid',
  'branch_code_format',
  'branch_code_taken',
  'branch_name_required',
  'branch_last_active',
  'prefix_format',
  'file_type_not_allowed',
  'file_too_large',
  'role_name_required',
  'role_name_taken',
  'role_required',
  'already_member',
  'already_invited',
  // auth ও অনুমতি
  'workspace_not_found',
  'invalid_credentials',
  'not_a_member',
  'sign_in_required',
  'session_ended',
  'access_revoked',
  'switch_denied',
  'permission_missing',
  'invitation_invalid',
  'cannot_grant',
  'owner_role_locked',
  'last_owner',
  'own_membership',
  'role_in_use',
  // workspace setup (onboarding)
  'setup_started',
  'setup_not_failed',
  // chart of accounts
  'account_code_format',
  'account_code_taken',
  'account_name_required',
  'account_parent_required',
  'account_parent_invalid',
  'account_parent_loop',
  'account_parent_archived',
  'account_locked',
  'account_has_children',
  'account_has_active_children',
  'account_in_use',
  // journal
  'money_format',
  'journal_date_required',
  'journal_account_required',
  'journal_line_amount',
  'journal_lines_too_few',
  'journal_unbalanced',
  'journal_account_invalid',
  'journal_branch_invalid',
  'journal_period_locked',
  'journal_not_draft',
  'journal_not_posted',
  'journal_is_reversal',
  'journal_already_reversed',
  'journal_reversal_date',
  'opening_date_required',
  'opening_account_invalid',
  'opening_account_twice',
  'period_lock_future',
  'base_currency_locked',
  'journal_is_year_close',
  // reports and year-end close
  'report_range_invalid',
  'report_compare_incomplete',
  'year_end_invalid',
  'year_not_ended',
  'year_already_closed',
  'year_not_closed',
  'year_has_drafts',
  'year_nothing_to_close',
  'year_earlier_open',
  'year_later_closed',
  'export_not_ready',
  // units, categories and custom fields (step 12)
  'factor_format',
  'unit_code_format',
  'unit_code_taken',
  'unit_name_required',
  'unit_in_use',
  'category_name_required',
  'category_name_taken',
  'category_parent_invalid',
  'category_parent_loop',
  'category_has_children',
  'category_in_use',
  'custom_field_key_format',
  'custom_field_key_taken',
  'custom_field_label_required',
  'custom_field_option_twice',
  'custom_field_options_required',
  'custom_field_unknown',
  'number_format',
  // products
  'product_code_format',
  'product_code_taken',
  'product_sku_format',
  'product_sku_taken',
  'product_sku_twice',
  'product_name_required',
  'product_unit_required',
  'product_unit_invalid',
  'product_unit_is_base',
  'product_unit_twice',
  'product_default_unit_invalid',
  'product_factor_standard',
  'product_option_name_required',
  'product_option_values_required',
  'product_option_twice',
  'product_option_value_twice',
  'product_variants_simple',
  'product_variant_values',
  'product_variant_twice',
  'product_variant_last_active',
  'product_variant_unknown',
  'product_variant_in_use',
  'product_pack_barcode_variants',
  'product_tracking_service',
  'product_expiry_needs_batch',
  'product_category_invalid',
  'product_in_use',
  'barcode_format',
  'barcode_check_digit',
  'barcode_taken',
  'barcode_twice',
  // product imports
  'import_file_type',
  'import_not_uploaded',
  'import_not_pending',
  'import_encoding',
  'import_csv_malformed',
  'import_empty',
  'import_too_many_rows',
  'import_column_missing',
  'import_column_unknown',
  'import_row_conflict',
  'import_unit_unknown',
  'import_category_invalid',
  'import_value_invalid',
  'import_options_without_code',
  // warehouses and stock (step 13)
  'warehouse_code_format',
  'warehouse_code_taken',
  'warehouse_name_required',
  'warehouse_branch_invalid',
  'warehouse_branch_locked',
  'warehouse_has_stock',
  'warehouse_has_transfers',
  'branch_has_warehouses',
  'quantity_format',
  'serial_number_format',
  'stock_date_required',
  'stock_date_future',
  'stock_warehouse_invalid',
  'stock_lines_required',
  'stock_variant_required',
  'stock_variant_invalid',
  'stock_unit_invalid',
  'stock_quantity_decimals',
  'stock_lot_required',
  'stock_expiry_required',
  'stock_batch_dates',
  'stock_batch_required',
  'stock_batch_invalid',
  'stock_batch_expiry_mismatch',
  'stock_serial_count',
  'stock_serial_twice',
  'stock_serial_in_stock',
  'stock_serial_not_here',
  'stock_insufficient',
  'stock_not_draft',
  'adjustment_reason_direction',
  'transfer_same_warehouse',
  'transfer_not_in_transit',
  'transfer_lines_mismatch',
  'transfer_receive_too_many',
  'transfer_receive_date',
  'transfer_serial_not_sent',
  'reorder_level_required',
  'product_base_unit_locked',
  'product_tracking_locked',
  'product_type_locked',
  // stock values and the books (step 14)
  'stock_cost_required',
  'stock_account_missing',
  'stock_account_invalid',
  'stock_account_inventory',
  'journal_account_stock',
  'journal_is_stock',
  'revaluation_no_stock',
  'revaluation_variant_twice',
  'account_used_by_stock',
  // HTTP ও সার্ভার
  'invalid_cursor',
  'version_conflict',
  'upload_incomplete',
  'attachment_not_ready',
  'malformed_request',
  'not_found',
  'request_failed',
  'internal_error',
  // শুধু ক্লায়েন্ট বানায়, সার্ভার কখনো পাঠায় না
  'network_error',
  'unexpected_response',
  'unknown_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

// schema-র ভেতরে মেসেজের জায়গায় code: .min(3, errorCode('slug_too_short'))।
// সাধারণ string লিখলে বানান ভুল ধরা পড়ত না — এই ফাংশন শুধু ErrorCode নেয়
export function errorCode(code: ErrorCode): ErrorCode {
  return code;
}

// schema যেখানে নিজে code দেয়নি (যেমন .max(120)), সেখানে Zod-এর issue দেখে সাধারণ code।
// Zod-এর ক্রম: schema-র নিজের মেসেজ > parse-এর সময় দেওয়া এই map > Zod-এর ইংরেজি মেসেজ
export const contractErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'required' : 'invalid_value';
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array' ? 'too_short' : 'too_small';
    case 'too_big':
      return issue.origin === 'string' || issue.origin === 'array' ? 'too_long' : 'too_large';
    case 'invalid_format':
      return 'invalid_format';
    default:
      return 'invalid_value';
  }
};

// RFC 9457 "Problem Details" — HTTP API-র error-এর প্রচলিত আকার (Content-Type:
// application/problem+json)। title/status/detail RFC-র নিজের ফিল্ড; code, params, fieldErrors,
// requestId আমাদের extension। type নেই = RFC অনুযায়ী "about:blank" (title = HTTP status-এর নাম)
export const problemSchema = z.object({
  title: z.string(),
  status: z.number().int(),
  // ইংরেজি, ডেভেলপার আর লগের জন্য — UI এটা দেখায় না, code অনুবাদ করে দেখায়
  detail: z.string(),
  // z.string(), enum না: নতুন সার্ভার নতুন code পাঠালে পুরনো ক্লায়েন্ট (অফলাইন PWA-র ক্যাশ)
  // parse-এ ভেঙে পড়বে না; isErrorCode() দিয়ে চেনা code-এ নামানো হয়
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  // ফিল্ডের পাথ (react-hook-form-এর মতো: "items.0.qty") → সেই ফিল্ডের error code
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  requestId: z.string().optional(),
});

export type Problem = z.infer<typeof problemSchema>;
