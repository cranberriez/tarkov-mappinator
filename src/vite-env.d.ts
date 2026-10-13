/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default site for group auth (its origin, e.g. http://localhost:3000); Settings can still override it. */
  readonly VITE_GROUP_SITE?: string;
}
