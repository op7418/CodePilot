import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "release/**",
    "dist-electron/**",
    "next-env.d.ts",
    // apps/site generated artifacts
    "apps/site/.next/**",
    "apps/site/.source/**",
    // External reference materials / vendored packages (not part of the main codebase)
    "资料/**",
  ]),

  // ── Governance rules for business components ──
  {
    files: [
      "src/components/settings/**/*.{ts,tsx}",
      "src/components/bridge/**/*.{ts,tsx}",
      "src/components/chat/**/*.{ts,tsx}",
      "src/components/gallery/**/*.{ts,tsx}",
      "src/components/plugins/**/*.{ts,tsx}",
      "src/components/skills/**/*.{ts,tsx}",
      "src/components/project/**/*.{ts,tsx}",
      "src/components/layout/**/*.{ts,tsx}",
      "src/components/cli-tools/**/*.{ts,tsx}",
      "src/app/**/*.{ts,tsx}",
    ],
    rules: {
      // Discourage native HTML controls — use ui/ components instead
      "no-restricted-syntax": [
        "warn",
        {
          selector: "JSXOpeningElement[name.name='button']",
          message: "Use <Button> from @/components/ui/button instead of native <button>.",
        },
        {
          selector: "JSXOpeningElement[name.name='input']",
          message: "Use <Input> from @/components/ui/input instead of native <input>.",
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Use <Select> from @/components/ui/select instead of native <select>.",
        },
        {
          selector: "JSXOpeningElement[name.name='textarea']",
          message: "Use <Textarea> from @/components/ui/textarea instead of native <textarea>.",
        },
      ],
    },
  },

  // ── Phase 7 icon guardrails (revised 2026-05-21) ──
  // Goal: business code defaults to CodePilotIcon (semantic layer →
  // HugeIcons via @/components/ui/semantic-icon). @/components/ui/icon
  // (Phosphor wrapper) stays as a compatibility surface for STRUCTURAL
  // icons (CaretDown, CheckCircle, X, status badges, Caret*, SpinnerGap,
  // etc.) and for files in the ai-elements/shadcn primitive allowlist.
  //
  // Three specific Phosphor names — Brain / Lightning / Terminal — are
  // banned at the wrapper level because Phase 7 mapped them to semantic
  // aliases (memory / runtime / terminal / cli / skill). Importing the
  // raw names re-introduces the cross-semantic overload Phase 7 resolved.
  //
  // Lucide is banned project-wide; redirect target updated from
  // @phosphor-icons/react (pre-Phase-7) to CodePilotIcon semantic layer.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["lucide-react"],
              message:
                "Use CodePilotIcon from @/components/ui/semantic-icon (semantic layer → HugeIcons). " +
                "For structural icons not yet aliased (CaretDown, status badges), import from @/components/ui/icon. " +
                "See docs/design.md.",
            },
          ],
        },
      ],
    },
  },

  // Business code: prefer CodePilotIcon. Direct @phosphor-icons/react
  // import remains a warning (redirect target updated to the semantic
  // layer). Named-import block: Brain / Lightning / Terminal from the
  // wrapper are banned to prevent cross-semantic regression.
  {
    files: [
      "src/components/settings/**/*.{ts,tsx}",
      "src/components/bridge/**/*.{ts,tsx}",
      "src/components/chat/**/*.{ts,tsx}",
      "src/components/gallery/**/*.{ts,tsx}",
      "src/components/plugins/**/*.{ts,tsx}",
      "src/components/skills/**/*.{ts,tsx}",
      "src/components/project/**/*.{ts,tsx}",
      "src/components/layout/**/*.{ts,tsx}",
      "src/components/cli-tools/**/*.{ts,tsx}",
      "src/components/git/**/*.{ts,tsx}",
      "src/app/**/*.{ts,tsx}",
      "src/hooks/**/*.{ts,tsx}",
      "src/lib/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["@phosphor-icons/react"],
              message:
                "Prefer CodePilotIcon from @/components/ui/semantic-icon (semantic layer → HugeIcons). " +
                "Structural icons without HugeIcons equivalent (CaretDown, CheckCircle, Warning, etc.) " +
                "can import from @/components/ui/icon.",
            },
          ],
          paths: [
            {
              name: "@/components/ui/icon",
              importNames: ["Brain", "Lightning", "Terminal"],
              message:
                "Phase 7 mapped these to semantic aliases: " +
                "Brain → CodePilotIcon name=\"memory\"; " +
                "Lightning → \"runtime\" (or \"skill\" / \"code\" depending on context); " +
                "Terminal → \"terminal\" (for shell UI) or \"cli\" (for CLI tools catalog). " +
                "Importing the raw Phosphor name re-introduces the cross-semantic overload Phase 7 resolved.",
            },
            {
              name: "@phosphor-icons/react",
              importNames: ["Brain", "Lightning", "Terminal"],
              message:
                "Phase 7 mapped these to semantic aliases (see CodePilotIcon). " +
                "Bypassing the wrapper does NOT bypass the ban — raw Phosphor Brain / Lightning / Terminal " +
                "re-introduces the cross-semantic overload Phase 7 resolved. Use CodePilotIcon name=\"memory|runtime|terminal|cli|skill|code\" instead.",
            },
          ],
        },
      ],
    },
  },

  // File type artwork is a build-time-only dependency. Product code may
  // consume only the generated static subset through FileTypeIcon.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/FileTypeIcon.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["material-icon-theme", "material-icon-theme/*"],
              message:
                "material-icon-theme is build-time only; use FileTypeIcon.",
            },
            {
              group: ["@/components/ui/file-type-icons.generated"],
              message:
                "Only FileTypeIcon may import the generated icon mapping.",
            },
          ],
        },
      ],
    },
  },

  // ── Raw status colors ──
  // ESLint cannot lint inside className strings. Use `npm run lint:colors`.
  // to check for raw green/red/yellow/orange/blue-{400-700} usage in business components.
  // Add `// lint-allow-raw-color` on lines where raw colors are intentional (e.g. diff syntax).

  // ── Component file size limit ──
  {
    files: ["src/components/**/*.{ts,tsx}"],
    ignores: [
      "src/components/ui/**",
      "src/components/ai-elements/**",
    ],
    rules: {
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },

  // ── Patterns layer: no data logic imports ──
  {
    files: ["src/components/patterns/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/hooks/*", "@/hooks"],
              message: "Pattern components must be pure presentation — no hooks imports.",
            },
            {
              group: ["@/lib/*", "!@/lib/utils"],
              message: "Pattern components must be pure presentation — no lib imports. Use @/lib/utils for cn() only.",
            },
          ],
          paths: [],
        },
      ],
    },
  },
]);

export default eslintConfig;
