// Flat config. The Rust half has had `cargo fmt --check` and `clippy -D warnings` gated in CI
// since early on; this is the missing other half, and it is here for the same reason clippy is:
// to catch the mistakes that type-check cleanly.
//
// The type-aware rules are the point. `no-floating-promises` in particular — this codebase
// fires a lot of async work it deliberately doesn't await (`void loadList()`), and the rule is
// what keeps `void` a decision rather than an omission.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Build output, dependencies, and the Rust crate's own target dir.
  {
    ignores: ["dist/", "node_modules/", "src-tauri/", "docs/"],
  },

  // The app: React + TypeScript, type-aware.
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-refresh": reactRefresh,
    },
    rules: {
      // --- react-hooks v7 ships the React Compiler's rules. This app is not built with the
      // compiler, and they flag patterns it holds deliberately and documents in place:
      // `errorRef.current = error` during render so `play` can stay identity-stable, reading
      // `deviceRef.current` in the value memo, `Date.now()` during a "how stale is this?"
      // render, and effects that sync one derived flag. Satisfying them means restructuring
      // the player to please a compiler that isn't in the build.
      //
      // Off as a group, not one at a time, because they interact: the compiler stops at the
      // first thing it can't analyse, so silencing one reveals the next. Library.tsx showed
      // this — removing a single forward reference let it analyse far enough to start
      // reporting `preserve-manual-memoization` on memos that had not changed at all.
      // Revisit the whole set together if React Compiler is ever adopted.
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",

      // Stays on, and stays a warning. Every hit is a real question about whether a memo can
      // serve a stale result, but the answers are behavioural — changing a dependency array
      // needs the app run, not a type-check — so they are a review list rather than a gate.
      "react-hooks/exhaustive-deps": "warn",

      // Purely about how finely Vite's fast refresh can reload a file. Every hit is a context
      // module exporting its provider next to its `useX` hook, which is the ordinary React
      // pattern and is not worth splitting files over.
      "react-refresh/only-export-components": "off",

      // Type-aware rules, picked rather than taken wholesale. The full
      // `recommendedTypeChecked` set is mostly `no-unsafe-*`, which fires on every value
      // crossing the Tauri IPC boundary as `any` — a real typing project, and not one worth
      // blocking a lint gate on. These are the ones that catch mistakes instead of demanding
      // annotations.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // An async handler on a JSX prop is ordinary React, and the alternative — wrapping
        // every one in `void (async () => ...)()` — is noise. The other checks stay on: an
        // unawaited promise in a condition or a spread is always a bug.
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },

  // The build's own config files. Linted too — a mistake in vite.config.ts breaks the build
  // for everyone, and nothing else here would have looked at them.
  {
    files: ["*.config.{js,ts}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  },

  // The two standalone scripts are plain Node ESM, deliberately outside the TypeScript build
  // (see the header of get-refresh-token.mjs). Lint them as Node, untyped.
  {
    files: ["scripts/**/*.mjs", "templates/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  }
);
