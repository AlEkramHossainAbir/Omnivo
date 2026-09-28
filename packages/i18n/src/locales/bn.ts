import type { Messages } from './messages.js';

// Messages টাইপ: en-এর কোনো key বাদ পড়লে বা বাড়তি key থাকলে compile error
export const bn: Messages = {
  common: {
    signOut: 'সাইন আউট',
    language: 'ভাষা',
    optional: '(ঐচ্ছিক)',
    retry: 'আবার চেষ্টা করুন',
  },
  shell: {
    mainNav: 'প্রধান',
    workspaces: 'ওয়ার্কস্পেস',
    switchWorkspace: 'ওয়ার্কস্পেস বদলান',
    switchFailed: 'ওয়ার্কস্পেস বদলানো যায়নি। আবার চেষ্টা করুন।',
    switched: '{{name}}-এ চলে এসেছেন',
    account: 'অ্যাকাউন্ট',
  },
  nav: {
    overview: 'সারসংক্ষেপ',
    kitchenSink: 'কিচেন সিঙ্ক',
  },
  dashboard: {
    title: 'সারসংক্ষেপ',
    readyTitle: 'আপনার ওয়ার্কস্পেস তৈরি',
    readyBody:
      'এবার চার্ট অব অ্যাকাউন্টস সাজান আর আপনার হিসাবরক্ষককে আমন্ত্রণ জানান। বায়ার PO, LC আর স্টক রেকর্ড শুরু করলে এখানে দেখা যাবে।',
    teamTitle: 'টিম',
    teamSubtitle: 'এই ওয়ার্কস্পেসে যাঁদের অ্যাক্সেস আছে',
    teamLoadFailed: 'টিমের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
    noRole: 'কোনো রোল নেই',
    columns: {
      member: 'সদস্য',
      roles: 'রোল',
    },
    teamPermissionHint: 'টিম দেখতে ওয়ার্কস্পেস মালিকের কাছে core.user.read অনুমতি চান।',
  },
  ui: {
    dataTable: {
      sortBy: '{{column}} অনুযায়ী সাজান',
      rowCount_one: '{{formatted}}টি সারি',
      rowCount_other: '{{formatted}}টি সারি',
    },
    datePicker: {
      placeholder: 'তারিখ বাছুন',
    },
  },
};
