import { Alert02Icon, LinkBackwardIcon } from '@hugeicons/core-free-icons';
import { type ErrorCode, VERIFY_EMAIL_PATH } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, EmptyState, Logo, toast } from '@omnivo/ui';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { LanguageSwitch } from '../components/language-switch';
import { ApiRequestError } from '../lib/api';
import { verifyEmail } from '../lib/session';

// The same frame as the invitation's page: the logo, one centered card, the language switch
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg px-4 py-8 sm:px-16">
      <Logo />
      <div className="grid flex-1 place-items-center py-10">
        <Card className="w-full max-w-105">{children}</Card>
      </div>
      <div className="flex justify-end">
        <LanguageSwitch />
      </div>
    </div>
  );
}

// checking = the request is out; failed = the server (or the network) said no, with its code
type State = { kind: 'checking' } | { kind: 'failed'; code: ErrorCode };

// The email's link: /verify-email#<token>. The token sits after the #, so the browser never sends
// it to a server (contracts: verifyEmailLink). No login needed, and no redirect for someone who is
// signed in: the link starts its own session in that one's place, like an invitation.
export function VerifyEmailPage() {
  const { t, errorText } = useLocale();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  // Kept from the first render: the address loses the token right after (below), and Retry needs it
  const [token] = useState(hash);
  const [state, setState] = useState<State>(
    token.length === 0
      ? { kind: 'failed', code: 'verification_link_invalid' }
      : { kind: 'checking' },
  );

  const confirm = useCallback(async () => {
    setState({ kind: 'checking' });
    try {
      await verifyEmail(token);
      toast(t('auth.verifyEmail.done'));
      // replace: Back must not come here again; the link works once. "/" sends a new owner on to
      // the setup wizard (router.tsx), like the sign-up used to
      await navigate({ to: '/', replace: true });
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : 'unknown_error';
      // The address is confirmed, but the sign-in it waited for has ended (signed out, or a month
      // went by). The password is enough now
      if (code === 'session_ended') {
        toast(t('auth.verifyEmail.done'));
        await navigate({ to: '/login', replace: true });
        return;
      }
      setState({ kind: 'failed', code });
    }
  }, [navigate, t, token]);

  // Once per page, also under React's StrictMode, which runs an effect twice in development: a
  // second request would find the link used and show "no longer works" over the first one's success
  const started = useRef(false);
  useEffect(() => {
    if (started.current || token.length === 0) return;
    started.current = true;
    // The token out of the address, so a copied address or the browser's history never holds it
    window.history.replaceState(window.history.state, '', VERIFY_EMAIL_PATH);
    void confirm();
  }, [confirm, token]);

  if (state.kind === 'checking') {
    return (
      <Frame>
        <p role="status" className="p-8 text-center text-body-sm text-ink-3">
          {t('auth.verifyEmail.checking')}
        </p>
      </Frame>
    );
  }

  // A used, ended or unknown link: signing in with the password sends a new one
  if (state.code === 'verification_link_invalid') {
    return (
      <Frame>
        <EmptyState
          icon={LinkBackwardIcon}
          tone="crit"
          title={t('auth.verifyEmail.invalidTitle')}
          description={t('auth.verifyEmail.invalidBody')}
          action={
            <Link
              to="/login"
              className="font-medium text-brand underline-offset-[3px] hover:underline"
            >
              {t('auth.verifyEmail.toSignIn')}
            </Link>
          }
        />
      </Frame>
    );
  }

  // Anything else (no connection, the server failing): the link may still be good, so Retry
  return (
    <Frame>
      <EmptyState
        icon={Alert02Icon}
        tone="crit"
        title={t('auth.verifyEmail.failedTitle')}
        description={errorText(state.code)}
        action={
          <Button variant="secondary" onClick={() => void confirm()}>
            {t('auth.verifyEmail.retry')}
          </Button>
        }
      />
    </Frame>
  );
}
