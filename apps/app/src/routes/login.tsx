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
import { zodResolver } from '@hookform/resolvers/zod';
import { loginInputSchema } from '@omnivo/contracts';
import { Button, Checkbox, FormAlert, Logo, TextField } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { AuthPreview } from '../components/auth-preview';
import { applyApiError } from '../lib/field-errors';
import { login } from '../lib/session';

const INDUSTRIES = [
  { icon: TShirtIcon, label: 'Garments & textiles' },
  { icon: Medicine02Icon, label: 'Pharmaceuticals' },
  { icon: DeliveryTruck01Icon, label: 'Distribution' },
  { icon: FactoryIcon, label: 'Manufacturing' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  // zodResolver: API যে schema দিয়ে যাচাই করে, ফর্মও ঠিক সেটা দিয়ে — একই মেসেজ, একই নিয়ম
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(loginInputSchema),
    defaultValues: { workspace: '', email: '', password: '', keepSignedIn: true },
  });

  // handleSubmit: আগে Zod যাচাই, পাস করলে তবেই এই ফাংশন — values-এর টাইপ LoginInput
  // (trim/lowercase হয়ে গেছে)। চলার সময় isSubmitting নিজে থেকেই true
  const onSubmit = handleSubmit(async (values) => {
    try {
      await login(values);
      await navigate({ to: '/' });
    } catch (error) {
      applyApiError(error, loginInputSchema.keyof().options, setError);
    }
  });

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
              {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
              <TextField
                label="Workspace"
                icon={Building03Icon}
                suffix=".omnivo.app"
                autoComplete="organization"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="rahman-garments"
                {...register('workspace')}
                error={errors.workspace?.message}
              />
              <TextField
                label="Email"
                icon={Mail01Icon}
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                {...register('email')}
                error={errors.email?.message}
              />
              <TextField
                label="Password"
                icon={LockPasswordIcon}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                {...register('password')}
                error={errors.password?.message}
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
              {/* Radix Checkbox আসল <input> না, তাই register চলে না — Controller মান আর onChange জোড়ে */}
              <Controller
                control={control}
                name="keepSignedIn"
                render={({ field }) => (
                  <Checkbox
                    id="keepSignedIn"
                    label="Keep me signed in on this device"
                    checked={field.value}
                    // Radix-এর মান true | false | 'indeterminate' — আমাদের schema শুধু boolean
                    onCheckedChange={(checked) => {
                      field.onChange(checked === true);
                    }}
                  />
                )}
              />
              <Button type="submit" disabled={isSubmitting} className="w-full">
                {isSubmitting ? 'Signing in…' : 'Sign in'}
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
