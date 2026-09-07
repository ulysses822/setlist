import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose. That file configures the Tauri dev server and the
// React plugin, and none of it is needed here: everything under test is plain TypeScript whose
// only import from api.ts is `import type`, so no module in the graph reaches for the Tauri IPC
// bridge that doesn't exist outside the webview. Keeping the two apart also means a production
// build never has to load vitest to read its own config.
//
// Deliberately not a jsdom/browser environment. These are the pure-logic modules — diffing,
// linting, the feature maths — where a wrong answer silently changes what gets pushed to
// Spotify. Component rendering is a different job and would want a different setup.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
