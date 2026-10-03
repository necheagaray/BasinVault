// Minimal ESLint config used only by preflight-check.mjs's "no-undef" pass.
// This exists because of a real, recurring bug class: a variable correctly
// scoped in one function gets referenced by a similarly-named but different
// variable in another function during a refactor (e.g. weeksMetaFull vs
// weeksMetaForChart). node --check cannot catch this — it's a reference
// error, not a syntax error — but ESLint's no-undef rule can, because it
// actually tracks variable scope. Caught this exact bug twice in one
// session before this check existed.
export default [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly", document: "readonly", console: "readonly", localStorage: "readonly",
        fetch: "readonly", Store: "writable", setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly", navigator: "readonly", FileReader: "readonly",
        Blob: "readonly", URL: "readonly", DOMParser: "readonly", XLSX: "readonly",
        requestAnimationFrame: "readonly", confirm: "readonly", prompt: "readonly", alert: "readonly",
        ClipboardItem: "readonly", location: "readonly", history: "readonly", crypto: "readonly",
      },
    },
    rules: { "no-undef": "error" },
  },
];
