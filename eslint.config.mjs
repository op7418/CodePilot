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

  // ── Discourage Lucide imports project-wide ──
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["lucide-react"],
              message: "Use @phosphor-icons/react instead. See docs/ui-governance.md for mapping.",
            },
          ],
        },
      ],
    },
  },

  // ── Discourage direct Phosphor imports outside ui/ and ai-elements/ — use ui/icon.tsx ──
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
      "src/hooks/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["@phosphor-icons/react"],
              message: "Import icons from @/components/ui/icon instead. See docs/ui-governance.md.",
            },
          ],
        },
      ],
    },
  },

  // ── Raw status colors ──
  // ESLint cannot lint inside className strings. Use `npm run lint:colors` (grep-based)
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
