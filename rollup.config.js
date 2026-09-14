// Bundles the action into the committed dist/index.js. GitHub Actions runs that
// file directly and never installs node_modules for an action.
//
// ESM, and rollup rather than @vercel/ncc: @actions/core v3 and @actions/github
// v9 are ESM-only, which is exactly why actions/typescript-action moved off ncc.
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/action/main.ts",
  output: {
    file: "dist/index.js",
    format: "es",
    inlineDynamicImports: true,
    sourcemap: false,
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.action.json",
      compilerOptions: { noEmit: false, declaration: false, sourceMap: false },
    }),
    nodeResolve({ preferBuiltins: true, exportConditions: ["node"] }),
    commonjs(),
  ],
};
