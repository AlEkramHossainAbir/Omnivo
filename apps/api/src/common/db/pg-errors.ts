// drizzle Postgres error-কে DrizzleQueryError-এ মুড়ে দেয়; আসল কোড থাকে .cause-এ
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint_name' in current &&
      current.constraint_name === constraint
    ) {
      return true;
    }
  }
  return false;
}
