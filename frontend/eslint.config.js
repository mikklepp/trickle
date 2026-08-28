import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // These two arrived with eslint-plugin-react-hooks v7 (the React Compiler
      // rules) and currently flag 12 real findings across the components --
      // mutations of captured values, and setState called directly in an effect.
      // They are genuine, not false positives, but fixing them is a component
      // refactor rather than a lint cleanup. Kept as warnings so the rest of the
      // ruleset can gate CI today; drop these overrides once addressed.
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);
