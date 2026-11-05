// drizzle Postgres error-কে DrizzleQueryError-এ মুড়ে দেয়; আসল কোড থাকে .cause-এ
function hasPgError(error: unknown, code: string, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === code &&
      'constraint_name' in current &&
      current.constraint_name === constraint
    ) {
      return true;
    }
  }
  return false;
}

// 23505 = unique_violation
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return hasPgError(error, '23505', constraint);
}

// 23514 = check_violation: a CHECK constraint, or a trigger that raises with ERRCODE
// 'check_violation' and a CONSTRAINT name (the stock ledger's triggers, migration 0022)
export function isCheckViolation(error: unknown, constraint: string): boolean {
  return hasPgError(error, '23514', constraint);
}

// 23503 = foreign_key_violation: যে রো-কে আরেকটা রো এখনো রেফার করছে সেটা মোছার চেষ্টা (বা উল্টোটা)
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return hasPgError(error, '23503', constraint);
}
