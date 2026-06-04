/**
 * Centralized code theme mappings for Shiki and HLJS.
 *
 * Each theme family JSON can specify `codeTheme: { light, dark }` and
 * `shikiTheme: { light, dark }` using the keys defined below.
 * Components should use the hooks exported here rather than maintaining
 * local maps.
 *
 * Performance note: HLJS theme objects (and the `react-syntax-highlighter`
 * theme registry) are loaded on demand from `react-syntax-highlighter`
 * per-theme. Statically importing all 18+ themes pulls ~300–500 KB of
 * CSS-in-JS into the first-paint chunk even though only the active
 * theme is ever rendered. Callers should use `useHljsStyle` (returns
 * the loaded style + a `loaded` flag so the consumer can render a
 * skeleton / plain `<pre>` while the dynamic chunk is in flight).
 */

import type { CSSProperties } from 'react';
import type { BundledTheme } from 'shiki';
import { useEffect, useState } from 'react';

import type { ThemeFamilyMeta, CodeThemeMapping } from './types';

// ── Shiki (used by code-block.tsx via `createHighlighter`) ─────────────

export const SHIKI_DEFAULT_LIGHT: BundledTheme = 'github-light';
export const SHIKI_DEFAULT_DARK: BundledTheme = 'github-dark';

// ── HLJS theme loaders (lazy) ──────────────────────────────────────────

export type HljsStyle = Record<string, CSSProperties>;

/**
 * Each entry maps a theme name (as it appears in the family JSON's
 * `codeTheme.dark` / `codeTheme.light`) to a function that returns the
 * `react-syntax-highlighter` HLJS style object for that theme. The
 * dynamic import keeps the entire style library out of the initial
 * bundle — only the active theme is fetched.
 */
const HLJS_LOADERS: Record<string, () => Promise<HljsStyle>> = {
  oneDark: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.atomOneDark as unknown as HljsStyle),
  oneLight: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.atomOneLight as unknown as HljsStyle),
  nord: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.nord as unknown as HljsStyle),
  solarizedDarkAtom: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.solarizedDark as unknown as HljsStyle),
  solarizedlight: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.solarizedLight as unknown as HljsStyle),
  nightOwl: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.nightOwl as unknown as HljsStyle),
  dracula: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.dracula as unknown as HljsStyle),
  gruvboxDark: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.gruvboxDark as unknown as HljsStyle),
  gruvboxLight: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.gruvboxLight as unknown as HljsStyle),
  ghcolors: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.github as unknown as HljsStyle),
  synthwave84: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.monokaiSublime as unknown as HljsStyle),
  materialDark: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.vs2015 as unknown as HljsStyle),
  materialOceanic: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.atomOneDark as unknown as HljsStyle),
  duotoneSea: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.atomOneDark as unknown as HljsStyle),
  coldarkDark: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.atomOneDark as unknown as HljsStyle),
  coldarkCold: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.atomOneLight as unknown as HljsStyle),
  materialLight: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.idea as unknown as HljsStyle),
  duotoneLight: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.atomOneLight as unknown as HljsStyle),
  vs: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.vs as unknown as HljsStyle),
  coy: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.xcode as unknown as HljsStyle),
  prism: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.lightfair as unknown as HljsStyle),
  duotoneEarth: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.darcula as unknown as HljsStyle),
  duotoneForest: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.zenburn as unknown as HljsStyle),
  twilight: () => import('react-syntax-highlighter/dist/esm/styles/hljs').then((m) => m.obsidian as unknown as HljsStyle),
};

// In-process cache so once a theme is loaded it stays synchronous for
// subsequent mounts. Keyed by resolved theme name.
const hljsCache = new Map<string, HljsStyle>();

/**
 * Resolve the name of the HLJS theme to load for the given code-theme
 * mapping + mode, or `null` if the mapping is missing/invalid. This
 * is a pure helper — the actual import is performed by `useHljsStyle`.
 */
export function resolveHljsThemeName(
  codeTheme: CodeThemeMapping | undefined,
  isDark: boolean,
): string {
  const name = isDark ? codeTheme?.dark : codeTheme?.light;
  if (name && HLJS_LOADERS[name]) return name;
  return isDark ? 'oneDark' : 'oneLight';
}

/**
 * Load an HLJS theme object by name. Returns the cached value
 * synchronously if it has already been loaded, otherwise fetches it.
 * Safe to call from render — React will de-duplicate identical
 * promises produced by useEffect deps.
 */
export function loadHljsStyle(name: string): Promise<HljsStyle> {
  const cached = hljsCache.get(name);
  if (cached) return Promise.resolve(cached);
  const loader = HLJS_LOADERS[name];
  if (!loader) return Promise.resolve(hljsCache.get('oneDark') ?? ({} as HljsStyle));
  return loader().then((style) => {
    hljsCache.set(name, style);
    return style;
  });
}

/**
 * Hook variant: load the HLJS style for the active family + dark mode
 * and return `{ style, loaded }`. Callers should render a plain `<pre>`
 * (or a skeleton) while `loaded` is false.
 */
export function useHljsStyle(
  codeTheme: CodeThemeMapping | undefined,
  isDark: boolean,
): { style: HljsStyle | null; loaded: boolean } {
  const name = resolveHljsThemeName(codeTheme, isDark);
  const [style, setStyle] = useState<HljsStyle | null>(() => hljsCache.get(name) ?? null);

  useEffect(() => {
    let cancelled = false;
    const cached = hljsCache.get(name);
    if (cached) {
      setStyle(cached);
      return;
    }
    setStyle(null);
    void loadHljsStyle(name).then((loaded) => {
      if (!cancelled) setStyle(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  return { style, loaded: style !== null };
}

// ── Resolution helpers ─────────────────────────────────────────────────

/**
 * Resolve a code-theme mapping from the current family metadata.
 * Returns `undefined` if family has no `codeTheme`.
 */
export function resolveCodeTheme(
  families: ThemeFamilyMeta[],
  familyId: string,
): CodeThemeMapping | undefined {
  return families.find((f) => f.id === familyId)?.codeTheme;
}

/**
 * Resolve a shiki-theme mapping from the current family metadata.
 * Returns `undefined` if family has no `shikiTheme`.
 */
export function resolveShikiTheme(
  families: ThemeFamilyMeta[],
  familyId: string,
): CodeThemeMapping | undefined {
  return families.find((f) => f.id === familyId)?.shikiTheme;
}

/** Pick a Shiki BundledTheme pair. Falls back to github-light / github-dark. */
export function resolveShikiThemes(
  shikiTheme: CodeThemeMapping | undefined,
): { light: BundledTheme; dark: BundledTheme } {
  return {
    light: (shikiTheme?.light ?? SHIKI_DEFAULT_LIGHT) as BundledTheme,
    dark: (shikiTheme?.dark ?? SHIKI_DEFAULT_DARK) as BundledTheme,
  };
}
