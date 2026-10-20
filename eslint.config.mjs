import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // `agent/` is a separate package with its own toolchain.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "agent/**",
    "data/**",
  ]),
  // PR #3 is actively editing these paths. eslint-config-next 16 flags the
  // existing fetch/sync effects; leave the files alone and turn off only this rule.
  {
    files: [
      "src/app/d/\\[token\\]/defend/**/*.{ts,tsx}",
      "src/app/learn/**/*.{ts,tsx}",
      "src/components/voice/**/*.{ts,tsx}",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
