import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.config.*",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: true },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // This release-test manifest intentionally lives beside Vitest configs,
    // outside apps/mcp's build/typecheck source root.
    files: ["apps/mcp/vitest.tiers.ts"],
    languageOptions: {
      parserOptions: {
        project: "./apps/mcp/tsconfig.eslint.json",
        tsconfigRootDir: repoRoot,
      },
    },
  },
];
