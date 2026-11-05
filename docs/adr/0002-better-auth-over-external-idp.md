# ADR 0002: Better Auth in-app over an external IdP

- **Status:** Accepted
- **Date:** 2026-09-24
- **Context:** Choosing how Omnivo authenticates users. Omnivo is built by one part-time developer, and the first customers are small and mid-size businesses in Bangladesh.

## Decision

Omnivo authenticates users with **Better Auth** inside the API (email/password, sessions and refresh-token rotation). It does not run a separate identity provider (IdP) such as Zitadel or Keycloak.

The code is shaped so that we can move to an external IdP later without touching application modules (see "Keeping the exit open").

## Why Better Auth over Zitadel / Keycloak

| | Better Auth (in-app) | Zitadel / Keycloak (separate IdP) |
|---|---|---|
| **Standards** | We follow the protocol standards ourselves (JWT, OIDC claims, refresh rotation) | Standard as a deployment; enterprise buyers and SOC 2 audits expect it |
| **Debugging** | Everything is in our own database, tables and logs | Problems live inside another system |
| **UX control** | Our own React login page, in Bangla, with our own onboarding flow | Hosted login page, limited customization, many redirects |
| **Speed for a solo, part-time developer** | Running in a day | OIDC flows, another container to operate, and a learning cost |
| **Enterprise SAML SSO** | Not available | Available |

**In short:** an external IdP is useful mainly for enterprise SSO and compliance, and we don't need either before the first enterprise customer. Until then, it would slow development and make debugging harder.

## Keeping the exit open

These three rules make a later switch take days rather than a rewrite:

1. **A facade in `packages/auth`.** Application modules never call Better Auth's API directly. They only know `getSession()`, `getPrincipal()` and `issueTokens()`.
2. **OIDC-compatible tokens.** Access tokens are JWTs with `sub`, `iss`, `aud`, `exp`, `iat` and `jti`, plus the custom claims `tenant_id`, `membership_id` and `roles[]`. If Zitadel later issues tokens with the same shape, the API code doesn't change.
3. **Authorization never lives in the IdP.** Roles, permissions and memberships stay in Omnivo's own tables (`memberships`, `roles`, `role_permissions`, `membership_roles`). The IdP only answers "who is this person?", never "what can they do?". This is the most important rule.

## When to revisit

Move to Zitadel (or a similar IdP) when either of these happens:

- the first enterprise customer asks for SAML SSO or SCIM provisioning, or
- we start a SOC 2 or ISO 27001 audit.

We don't switch before one of these happens.

## Consequences and caveats

- We own password hashing, session storage, refresh-token rotation and reuse detection, so these need tests and a security review before launch.
- Better Auth keeps credentials in its own tables (for example `account`). In step 3, `users.password_hash` either goes away or is mapped onto Better Auth's schema, so there's only one source of truth.
- Rate limiting on login and signup, and email verification through Mailpit (dev) and a real provider (prod), are our responsibility.
