/** Build label, set in vite.config.ts: "<package version>+<build date>". */
declare const __BUILD__: string;
/** Bundled pictures (inlined into the one file as data: addresses by the build). */
declare module '*.webp' {
  const src: string;
  export default src;
}
