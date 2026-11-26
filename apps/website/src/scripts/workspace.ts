// The rules of a workspace address ({slug}.omnivo.app), the same as newWorkspaceSlugSchema in
// packages/contracts/src/auth.ts. They are copied, not imported: importing @omnivo/contracts
// would put zod (about 50 KB) on the landing page for one regex. If the rules change there,
// change them here too. The API checks the address again on sign-up, so a stale copy can only
// let a bad address through to the sign-up page's own error, never create one.
const FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'blog',
  'docs',
  'help',
  'mail',
  'omnivo',
  'shop',
  'status',
  'www',
]);

export type WorkspaceCheck = { ok: true; slug: string } | { ok: false; message: string };

export function checkWorkspace(raw: string): WorkspaceCheck {
  const slug = raw.trim().toLowerCase();
  if (slug.length < 3)
    return { ok: false, message: 'Use at least 3 letters or digits, like rahman-traders.' };
  if (slug.length > 32) return { ok: false, message: 'Use 32 characters or fewer.' };
  if (!FORMAT.test(slug)) {
    return {
      ok: false,
      message: 'Use only letters, digits and single hyphens between them, like rahman-traders.',
    };
  }
  if (RESERVED.has(slug))
    return { ok: false, message: 'This address is kept for Omnivo. Pick another one.' };
  return { ok: true, slug };
}
