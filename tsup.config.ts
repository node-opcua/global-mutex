import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "source/index.ts" },
    outDir: "dist",
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    minify: false,
    shims: true,
    external: ["proper-lockfile"]
});
