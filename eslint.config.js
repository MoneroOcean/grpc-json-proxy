import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "*.js~", "**/*.un~"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    rules: {
      "no-throw-literal": "error",
      "default-case-last": "error",
      "no-unused-expressions": "error",
      "no-var": "error",
      "no-else-return": "error",
      "prefer-const": "error",
      "eqeqeq": ["error", "always", { "null": "ignore" }],
      "no-implicit-coercion": "error",
      "object-shorthand": "error",
      "prefer-template": "error",
      "no-shadow": "error",
      "no-param-reassign": "error"
    }
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" }]
    }
  }
];
