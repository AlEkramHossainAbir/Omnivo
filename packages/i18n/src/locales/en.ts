import type { ErrorCode } from '@omnivo/contracts';

// ইংরেজি = উৎস ভাষা। Messages টাইপ এখান থেকে আসে, তাই নতুন key প্রথমে এখানে যোগ হবে
export const en = {
  common: {
    signOut: 'Sign out',
    language: 'Language',
    optional: '(optional)',
    retry: 'Retry',
  },
  shell: {
    mainNav: 'Main',
    workspaces: 'Workspaces',
    switchWorkspace: 'Switch workspace',
    switchFailed: "Couldn't switch workspace. Try again.",
    switched: 'Switched to {{name}}',
    account: 'Account',
  },
  nav: {
    overview: 'Overview',
    kitchenSink: 'Kitchen sink',
  },
  auth: {
    workspace: 'Workspace',
    email: 'Email',
    password: 'Password',
    login: {
      title: 'Sign in',
      subtitle: 'Welcome back. Enter your details to continue.',
      passwordPlaceholder: 'Enter your password',
      showPassword: 'Show password',
      hidePassword: 'Hide password',
      keepSignedIn: 'Keep me signed in on this device',
      submit: 'Sign in',
      submitting: 'Signing in…',
      newHere: 'New to Omnivo?',
      createWorkspace: 'Create a workspace',
      panelLabel: 'What Omnivo does',
      panelTitle: 'Production, stock and accounts. One system.',
      panelBody:
        'From buyer orders to payroll, every department works from the same numbers, even when the internet is down.',
      industries: {
        garments: 'Garments & textiles',
        pharma: 'Pharmaceuticals',
        distribution: 'Distribution',
        manufacturing: 'Manufacturing',
      },
    },
    signUp: {
      haveWorkspace: 'Already have a workspace?',
      signIn: 'Sign in',
      title: 'Create your workspace',
      subtitle:
        "You'll be the workspace owner. You can invite your accountants, managers and store staff after setup.",
      companyName: 'Company name',
      workspaceAddress: 'Workspace address',
      fullName: 'Full name',
      workEmail: 'Work email',
      passwordPlaceholder: 'At least 8 characters',
      submit: 'Create workspace',
      submitting: 'Creating workspace…',
    },
  },
  dashboard: {
    title: 'Overview',
    readyTitle: 'Your workspace is ready',
    readyBody:
      'Next, set up your chart of accounts and invite your accountant. Buyer POs, LCs and stock will show up here once you start recording them.',
    teamTitle: 'Team',
    teamSubtitle: 'People with access to this workspace',
    teamLoadFailed: "Couldn't load your team. Refresh the page to try again.",
    loadingMore: 'Loading more…',
    noRole: 'No role',
    columns: {
      member: 'Member',
      roles: 'Roles',
    },
    teamPermissionHint: 'Ask a workspace owner for the core.user.read permission to see your team.',
  },
  // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
  // পর্যন্ত compile error, আর তালিকায় নেই এমন key লিখলেও error
  errors: {
    invalid_input: 'Check the highlighted fields and try again.',
    required: 'Fill in this field.',
    too_short: 'This is too short.',
    too_long: 'This is too long. Shorten it and try again.',
    too_small: 'Enter a larger number.',
    too_large: 'Enter a smaller number.',
    invalid_format: 'Check the format and try again.',
    invalid_value: 'Enter a valid value.',
    company_name_required: 'Enter your company name.',
    full_name_required: 'Enter your full name.',
    email_invalid: 'Enter an email like name@company.com.',
    email_taken: 'An account with this email already exists. Sign in instead.',
    password_required: 'Enter your password.',
    password_too_short: 'Use at least 8 characters.',
    password_too_long: 'Use 128 characters or fewer.',
    slug_too_short: 'Use at least 3 letters or numbers.',
    slug_too_long: 'Use 32 characters or fewer.',
    slug_format: 'Use lowercase letters, numbers and single hyphens, like rahman-garments.',
    slug_reserved: 'This address is reserved. Try adding your city, like rahman-gazipur.',
    slug_taken: 'This address is taken. Try adding your city, like rahman-gazipur.',
    workspace_not_found: "We couldn't find this workspace. Check the address.",
    invalid_credentials: 'Email or password is incorrect. Check them and try again.',
    not_a_member:
      "This account isn't a member of this workspace. Ask a workspace owner to invite you.",
    sign_in_required: 'Sign in to continue.',
    session_ended: 'Your session has ended. Sign in again.',
    access_revoked: 'You no longer have access to this workspace. Sign in again.',
    switch_denied: "You aren't a member of that workspace.",
    permission_missing:
      'You need the {{permissions}} permission. Ask a workspace owner to grant it.',
    invalid_cursor: 'This list has changed. Reload the page and try again.',
    malformed_request: "The server couldn't read this request. Reload the page and try again.",
    not_found: "We couldn't find what you were looking for.",
    request_failed: "The server couldn't complete this request. Try again.",
    internal_error: 'Something went wrong on our side. Try again in a moment.',
    network_error: 'Could not reach the server. Check your connection and try again.',
    unexpected_response:
      "The server sent a reply this version of the app can't read. Reload the page.",
    unknown_error: 'Something went wrong. Try again in a moment.',
  } satisfies Record<ErrorCode, string>,
  ui: {
    dataTable: {
      sortBy: 'Sort by {{column}}',
      // count বাছে এক/বহুবচন; formatted = ভাষা-অনুযায়ী গোছানো সংখ্যা (10,000 / ১০,০০০)
      rowCount_one: '{{formatted}} row',
      rowCount_other: '{{formatted}} rows',
    },
    datePicker: {
      placeholder: 'Pick a date',
    },
  },
};
