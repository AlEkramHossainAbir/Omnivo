import {
  buildPath,
  problemSchema,
  routes,
  type LoginInput,
  type RouteDef,
  type RouteRequest,
  type RouteResult,
  type SignUpInput,
  VERIFY_EMAIL_PATH,
} from '@omnivo/contracts';
import { z } from 'zod';

// Step 26h: the seed's way to the API. Every call names a route of the contracts, so the path,
// the method, what is sent and what comes back are the same types the ERP's screens use: a field
// renamed in a contract breaks the seed's type check, not the seed's run on someone's machine.

// A refusal, with the API's own error code ("slug_taken"), so the seed can tell "this demo shop is
// there already" from a real problem
export class SeedApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SeedApiError';
  }
}

// The loose shape the one implementation takes; call()'s signature below is the strict one, from
// the route, like apps/app/src/lib/api.ts
interface RequestParts {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

// No second argument for a route that takes nothing (GET /setup), a required one for a route
// with a body or path params. `& RequestParts` lets TypeScript see that the strict input fits the
// implementation's loose one, without a cast
type CallArgs<R extends RouteDef> =
  Partial<RouteRequest<R>> extends RouteRequest<R>
    ? [input?: RouteRequest<R> & RequestParts]
    : [input: RouteRequest<R> & RequestParts];

// Mailpit's HTTP API, outside data, so read with a schema (no cast). Mailpit lists newest first
const mailboxSchema = z.object({
  messages: z.array(z.object({ ID: z.string(), To: z.array(z.object({ Address: z.string() })) })),
});
const messageSchema = z.object({ Text: z.string() });
// The link's token: after "/verify-email#", base64url (contracts: verifyEmailLink)
const LINK_TOKEN = new RegExp(`${VERIFY_EMAIL_PATH}#([A-Za-z0-9_-]+)`);
// The worker sends the link a moment after the sign-up answered
const LINK_WAIT_MS = 30_000;

// The email check: sign-up answers with no session, and the email's link starts one. The dev
// stack's every email lands in Mailpit (pnpm db:up), so the seed reads its own link there, as the
// owner would read their inbox, and still uses nothing but HTTP
async function linkTokenFor(mailUrl: string, email: string): Promise<string> {
  const deadline = Date.now() + LINK_WAIT_MS;
  for (;;) {
    let mailbox: z.infer<typeof mailboxSchema> | null = null;
    try {
      mailbox = mailboxSchema.parse(await (await fetch(`${mailUrl}/api/v1/messages`)).json());
    } catch {
      // No Mailpit on that address (yet): the same wait as no email yet
    }
    const found = mailbox?.messages.find((message) =>
      message.To.some((to) => to.Address === email),
    );
    if (found) {
      const message = messageSchema.parse(
        await (await fetch(`${mailUrl}/api/v1/message/${found.ID}`)).json(),
      );
      const token = LINK_TOKEN.exec(message.Text)?.[1];
      if (token) return token;
    }
    if (Date.now() > deadline) {
      throw new SeedApiError(
        0,
        'verification_link_invalid',
        `No email link for ${email} in Mailpit at ${mailUrl}. Is the worker running (pnpm dev), and Mailpit (pnpm db:up)?`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export class SeedApi {
  private accessToken: string | null = null;
  // Kept so a token that runs out (15 minutes, apps/api/src/config.ts) is replaced by signing in
  // again. A slow machine with the worker busy can take longer than that to make every photo
  private login: LoginInput | null = null;

  constructor(
    private readonly baseUrl: string,
    // Where the dev stack's Mailpit answers, for the sign-up's email link
    private readonly mailUrl: string,
  ) {}

  // Sign-up, then the email's link, so the seed starts signed in as the owner
  async signUp(input: SignUpInput): Promise<void> {
    const { email } = await this.call(routes.auth.signUp, { body: input });
    const token = await linkTokenFor(this.mailUrl, email);
    const session = await this.call(routes.auth.verifyEmail, { body: { token } });
    this.accessToken = session.accessToken;
    this.login = {
      workspace: input.workspaceSlug,
      email: input.email,
      password: input.password,
      keepSignedIn: false,
    };
  }

  call<R extends RouteDef>(route: R, ...args: CallArgs<R>): Promise<RouteResult<R>>;
  async call(route: RouteDef, input: RequestParts = {}): Promise<unknown> {
    let response = await this.send(route, input);
    // A 401 with a token = the token ran out. Signing in again once is enough; a second 401 is a
    // real refusal and goes to the caller like any other
    if (response.status === 401 && this.accessToken !== null && this.login !== null) {
      const session = await this.call(routes.auth.login, { body: this.login });
      this.accessToken = session.accessToken;
      response = await this.send(route, input);
    }
    return this.read(route, response);
  }

  // The file straight to storage, with the signed headers exactly as the API gave them (the
  // signature covers them). Not our API: no token, and the answer has no body to read
  // Uint8Array<ArrayBuffer>, what readFile gives: fetch takes no view of a SharedArrayBuffer
  async put(
    url: string,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const response = await fetch(url, { method: 'PUT', headers, body });
    if (!response.ok) {
      throw new SeedApiError(
        response.status,
        'upload_incomplete',
        `PUT to storage ${String(response.status)}`,
      );
    }
  }

  private async send(route: RouteDef, input: RequestParts): Promise<Response> {
    const url = new URL(`${this.baseUrl}${buildPath(route.path, input.params)}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers();
    if (this.accessToken !== null) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (input.body !== undefined) headers.set('content-type', 'application/json');
    try {
      return await fetch(url, {
        method: route.method,
        headers,
        body: input.body === undefined ? null : JSON.stringify(input.body),
      });
    } catch {
      // fetch throws only when no answer came: the API is not running, or on another port
      throw new SeedApiError(
        0,
        'network_error',
        `${route.method} ${route.path}: no answer from ${this.baseUrl}`,
      );
    }
  }

  // The answer parsed with the route's own schema, so the seed gets the same types the screens
  // get, and an API that breaks its contract stops the seed at that call, with its name
  private async read(route: RouteDef, response: Response): Promise<unknown> {
    const body: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => null);
    if (!response.ok) {
      const problem = problemSchema.safeParse(body);
      if (!problem.success) {
        throw new SeedApiError(
          response.status,
          'unknown_error',
          `${route.method} ${route.path} ${String(response.status)}`,
        );
      }
      const fields = Object.entries(problem.data.fieldErrors ?? {})
        .map(([field, codes]) => `${field}: ${codes.join(', ')}`)
        .join('; ');
      throw new SeedApiError(
        response.status,
        problem.data.code,
        `${route.method} ${route.path} ${String(response.status)} ${problem.data.code}${fields === '' ? '' : ` (${fields})`}`,
      );
    }
    const parsed = route.response.safeParse(body);
    if (!parsed.success) {
      throw new SeedApiError(
        response.status,
        'unexpected_response',
        `${route.method} ${route.path} broke its contract`,
      );
    }
    return parsed.data;
  }
}
