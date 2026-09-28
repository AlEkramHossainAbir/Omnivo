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
  dashboard: {
    title: 'Overview',
    readyTitle: 'Your workspace is ready',
    readyBody:
      'Next, set up your chart of accounts and invite your accountant. Buyer POs, LCs and stock will show up here once you start recording them.',
    teamTitle: 'Team',
    teamSubtitle: 'People with access to this workspace',
    teamLoadFailed: "Couldn't load your team. Refresh the page to try again.",
    noRole: 'No role',
    columns: {
      member: 'Member',
      roles: 'Roles',
    },
    teamPermissionHint: 'Ask a workspace owner for the core.user.read permission to see your team.',
  },
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
