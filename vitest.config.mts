import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

// Mirror the tsconfig `paths` aliases (@shared/*, @utils/*, ...) so tests resolve imports like the app does.
const root = fileURLToPath(new URL(".", import.meta.url));
const tsconfig = JSON.parse(readFileSync(new URL("tsconfig.json", import.meta.url), "utf8")) as {
  compilerOptions: { paths: Record<string, string[]> };
};
const alias: Record<string, string> = {};
for (const [key, [target]] of Object.entries(tsconfig.compilerOptions.paths)) {
  alias[key.replace(/\/\*$/, "")] = root + target.replace(/\/\*$/, "").replace(/^\.?\//, "");
}

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/unit/setup.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["lcov", "text-summary"],
      reportsDirectory: "coverage",
    },
  },
});
