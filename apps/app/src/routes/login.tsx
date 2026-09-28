import {
  Building03Icon,
  DeliveryTruck01Icon,
  FactoryIcon,
  LockPasswordIcon,
  Mail01Icon,
  Medicine02Icon,
  TShirtIcon,
  ViewIcon,
  ViewOffIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { loginInputSchema } from '@omnivo/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useState } from 'react';

import { AuthPreview } from '../components/auth-preview';
import { Button } from '../components/button';
import { FormAlert } from '../components/form-alert';
import { Logo } from '../components/logo';
import { TextField } from '../components/text-field';
import { type FieldErrors, fromApiError, validate } from '../lib/field-errors';
import { login } from '../lib/session';

const INDUSTRIES = [
  { icon: TShirtIcon, label: 'Garments & textiles' },
  { icon: Medicine02Icon, label: 'Pharmaceuticals' },
  { icon: DeliveryTruck01Icon, label: 'Distribution' },
  { icon: FactoryIcon, label: 'Manufacturing' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ workspace: '', email: '', password: '', keepSignedIn: true });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validate(loginInputSchema, form);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      await login(result.data);
      await navigate({ to: '/' });
    } catch (error) {
      const { fields, form: message } = fromApiError(error);
      setErrors(fields);
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-dvh bg-surface min-[1040px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section className="flex flex-col px-4 py-8 sm:px-16">
        <Logo />
        <div className="grid flex-1 place-items-center py-10">
          <div className="w-full max-w-[380px]">
            <h1 className="text-[28px] leading-[1.2]">Sign in</h1>
            <p className="mt-2 text-ink-2">Welcome back. Enter your details to continue.</p>

            <form
              noValidate
              onSubmit={(event) => void onSubmit(event)}
              className="mt-8 grid gap-[18px]"
            >
              {formError && <FormAlert message={formError} />}
              <TextField
                id="workspace"
                label="Workspace"
                icon={Building03Icon}
                suffix=".omnivo.app"
                autoComplete="organization"
                spellCheck={false}
                placeholder="rahman-garments"
                value={form.workspace}
                onChange={(e) => {
                  setForm({ ...form, workspace: e.target.value });
                }}
                error={errors.workspace}
              />
              <TextField
                id="email"
                label="Email"
                icon={Mail01Icon}
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                value={form.email}
                onChange={(e) => {
                  setForm({ ...form, email: e.target.value });
                }}
                error={errors.email}
              />
              <TextField
                id="password"
                label="Password"
                icon={LockPasswordIcon}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={form.password}
                onChange={(e) => {
                  setForm({ ...form, password: e.target.value });
                }}
                error={errors.password}
                trailing={
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => {
                      setShowPassword(!showPassword);
                    }}
                    className="-mr-1.5 grid place-items-center rounded-md p-1.5 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink"
                  >
                    <HugeiconsIcon
                      icon={showPassword ? ViewOffIcon : ViewIcon}
                      size={17}
                      strokeWidth={1.5}
                    />
                  </button>
                }
              />
              <label htmlFor="keep" className="flex items-start gap-2.5 text-body-sm text-ink-2">
                <input
                  id="keep"
                  type="checkbox"
                  checked={form.keepSignedIn}
                  onChange={(e) => {
                    setForm({ ...form, keepSignedIn: e.target.checked });
                  }}
                  className="mt-px size-[17px] shrink-0 rounded-[5px] accent-brand"
                />
                Keep me signed in on this device
              </label>
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            <p className="mt-7 text-center text-body-sm text-ink-2">
              New to Omnivo?{' '}
              <Link
                to="/sign-up"
                className="font-medium text-brand underline-offset-[3px] hover:underline"
              >
                Create a workspace
              </Link>
            </p>
          </div>
        </div>
        <p className="text-[12.5px] text-ink-3">© 2026 Omnivo Technologies</p>
      </section>

      <aside
        aria-label="What Omnivo does"
        className="relative m-3 ml-0 hidden flex-col justify-center gap-10 overflow-hidden rounded-panel border border-brand-line bg-brand-soft px-[clamp(24px,5vw,72px)] py-14 min-[1040px]:flex"
      >
        <div aria-hidden="true" className="auth-grid pointer-events-none absolute inset-0" />
        {/* গ্রিড absolute, তাই লেখাকেও relative না দিলে লাইন লেখার উপরে আঁকা হতো */}
        <div className="relative max-w-lg">
          <h2 className="text-display tracking-[-0.03em]">
            Production, stock and accounts. One system.
          </h2>
          <p className="mt-3 max-w-md text-[15px] text-ink-2">
            From buyer orders to payroll, every department works from the same numbers, even when
            the internet is down.
          </p>
          <ul className="mt-[18px] flex flex-wrap gap-2">
            {INDUSTRIES.map((industry) => (
              <li
                key={industry.label}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-2.5 pl-2 text-[12.5px] font-medium text-ink-2"
              >
                <HugeiconsIcon
                  icon={industry.icon}
                  size={14}
                  strokeWidth={1.5}
                  className="text-brand"
                />
                {industry.label}
              </li>
            ))}
          </ul>
        </div>
        <AuthPreview />
      </aside>
    </div>
  );
}
