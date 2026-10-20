/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STAND_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
