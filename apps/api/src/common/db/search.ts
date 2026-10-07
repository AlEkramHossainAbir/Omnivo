// A LIKE pattern for "contains", lower case. LIKE's own wildcards in what the person typed are
// meant literally: "10%" finds "10% off", and "_" is an underscore, not "any one character".
// Used by every searched list (products and stock in steps 12–13, customers and price lists in
// step 15a); the column it is compared with must be lower() too, which is what the trigram
// indexes are built on.
export function containsPattern(search: string): string {
  return `%${search.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
