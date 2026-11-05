import { LANGUAGES, setLanguage, useLocale } from '@omnivo/i18n';
import { SegmentedControl } from '@omnivo/ui';

const OPTIONS = LANGUAGES.map((language) => ({ value: language.code, label: language.label }));

// লগইনের আগে user মেনু নেই — তাই লগইন আর সাইনআপ পেজে সরাসরি দুই ভাষার বোতাম।
// value-র টাইপ LANGUAGES থেকে ('en' | 'bn'), তাই setLanguage-এ cast লাগে না
export function LanguageSwitch() {
  const { t, language } = useLocale();
  return (
    <SegmentedControl
      label={t('common.language')}
      value={language}
      options={OPTIONS}
      onChange={(next) => {
        void setLanguage(next);
      }}
    />
  );
}
