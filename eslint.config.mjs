import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".artifacts/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Input validators deliberately reject ASCII control characters.
  { files: ["src/**/*.ts"], rules: { "no-control-regex": "off" } },
);
