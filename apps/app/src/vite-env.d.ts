// Vite-এর ImportMetaEnv ডিফল্টে অচেনা key-কে `any` দেয় — এই অপশনে সেটা বন্ধ হয় (rule 3)
interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
