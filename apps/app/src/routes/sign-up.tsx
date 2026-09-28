import {
  Building03Icon,
  Globe02Icon,
  LockPasswordIcon,
  Mail01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { signUpInputSchema } from '@omnivo/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { type SubmitEvent, useState } from 'react';

import { Button } from '../components/button';
import { FormAlert } from '../components/form-alert';
import { Logo } from '../components/logo';
import { TextField } from '../components/text-field';
import { type FieldErrors, fromApiError, validate } from '../lib/field-errors';
import { signUp } from '../lib/session';

// "Rahman Garments Ltd." → "rahman-garments" (Workspace Setup mockup-এর নিয়ম)
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|pvt|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function SignUpPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    companyName: '',
    workspaceSlug: '',
    fullName: '',
    email: '',
    password: '',
  });
  // ইউজার নিজে slug-এ হাত দিলে কোম্পানির নাম থেকে আর অটো-বসানো হবে না
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validate(signUpInputSchema, form);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      await signUp(result.data);
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
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-4 py-5 sm:px-10">
        <Logo />
        <p className="text-body-sm text-ink-2">
          Already have a workspace?{' '}
          <Link
            to="/login"
            className="font-medium text-brand underline-offset-[3px] hover:underline"
          >
            Sign in
          </Link>
        </p>
      </header>

      <main className="mx-auto max-w-[640px] px-4 pt-10 pb-16">
        <div className="rounded-card border border-line bg-surface px-[18px] py-[22px] shadow-md sm:p-8">
          <h1 className="text-h2">Create your workspace</h1>
          <p className="mt-1.5 text-ink-2">
            You&apos;ll be the workspace owner. You can invite your accountants, managers and store
            staff after setup.
          </p>

          <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-7 grid gap-5">
            {formError && <FormAlert message={formError} />}
            <TextField
              id="companyName"
              label="Company name"
              icon={Building03Icon}
              autoComplete="organization"
              placeholder="Rahman Garments Ltd."
              value={form.companyName}
              onChange={(e) => {
                const companyName = e.target.value;
                setForm({
                  ...form,
                  companyName,
                  workspaceSlug: slugTouched ? form.workspaceSlug : slugify(companyName),
                });
              }}
              error={errors.companyName}
            />
            <TextField
              id="workspaceSlug"
              label="Workspace address"
              icon={Globe02Icon}
              suffix=".omnivo.app"
              spellCheck={false}
              placeholder="rahman-garments"
              value={form.workspaceSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setForm({ ...form, workspaceSlug: e.target.value.toLowerCase() });
              }}
              error={errors.workspaceSlug}
            />
            <div className="grid gap-5 sm:grid-cols-2 sm:gap-4">
              <TextField
                id="fullName"
                label="Full name"
                icon={UserIcon}
                autoComplete="name"
                placeholder="Farhana Rahman"
                value={form.fullName}
                onChange={(e) => {
                  setForm({ ...form, fullName: e.target.value });
                }}
                error={errors.fullName}
              />
              <TextField
                id="email"
                label="Work email"
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
            </div>
            <TextField
              id="password"
              label="Password"
              icon={LockPasswordIcon}
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={form.password}
              onChange={(e) => {
                setForm({ ...form, password: e.target.value });
              }}
              error={errors.password}
            />

            <div className="mt-2 flex justify-end border-t border-line pt-6">
              <Button type="submit" disabled={submitting} className="w-full sm:w-auto sm:min-w-40">
                {submitting ? 'Creating workspace…' : 'Create workspace'}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
