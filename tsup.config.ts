import { defineConfig } from "tsup";

const pkg = require("./package.json");
const externalDeps = Object.keys(pkg.dependencies || {});

export default defineConfig({
    entry: { index: "source/index.ts" },
    outDir: "dist",
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    shims: true,
    external: externalDeps
});
