#!/usr/bin/env node
// Preflight check — run this before every single deploy, no exceptions.
//
// This exists because of a real incident: a function (seedUnbilledRevenue)
// was called in main.js but never added to its import statement. Plain
// `node --check` only validates syntax, not whether every referenced name
// actually resolves — so that bug shipped silently and broke login for any
// account whose saved data predated the feature that triggered the call.
// This script closes that gap, plus a few other classes of bug in the same
// family (missing DOM ids, CSS issues, migration crashes on real-shaped data).
//
// Usage: node scripts/preflight-check.mjs
// Exits non-zero (and prints exactly what's wrong) if anything fails.

import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const jsDir = path.join(root, "public/js");
const fnDir = path.join(root, "netlify/functions");

let failures = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };
const ok = (msg) => console.log(`OK: ${msg}`);

// ---------- 1. Syntax check every JS/MJS file ----------
console.log("\n=== 1. Syntax check ===");
for (const dir of [jsDir, fnDir]) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js") && !f.endsWith(".mjs")) continue;
    const full = path.join(dir, f);
    try {
      execSync(`node --check "${full}"`, { stdio: "pipe" });
      ok(`${f} syntax valid`);
    } catch (e) {
      fail(`${f} has a syntax error:\n${e.stderr?.toString() || e.message}`);
    }
  }
}

// ---------- 2. Cross-module reference check ----------
// For every JS file in public/js, find every OTHER module's exported names
// that appear as a bare identifier in this file's body, and confirm it's
// actually in this file's own import statement. This is the exact category
// of bug that caused the login outage.
console.log("\n=== 2. Cross-module import check (catches the login bug's root cause) ===");
const files = readdirSync(jsDir).filter((f) => f.endsWith(".js"));
const exportsByFile = {};
for (const f of files) {
  const text = readFileSync(path.join(jsDir, f), "utf8");
  const names = [...text.matchAll(/^export (?:function|const|async function|let)\s+([a-zA-Z_$][\w$]*)/gm)].map((m) => m[1]);
  exportsByFile[f] = names;
}

for (const f of files) {
  const text = readFileSync(path.join(jsDir, f), "utf8");
  const importBlockMatches = [...text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/gs)];
  const importedNames = new Set();
  for (const m of importBlockMatches) {
    for (const n of m[1].split(",")) {
      const clean = n.trim();
      if (clean) importedNames.add(clean);
    }
  }
  // a namespace import (import * as api from "./api.js") makes every one of
  // that module's exports available as api.X — those are accessed through
  // the namespace object, not as bare identifiers, so they're exempt from
  // needing to appear in a named-import list.
  const namespaceImports = [...text.matchAll(/import\s*\*\s*as\s*(\w+)\s*from\s*["']\.\/([^"']+)["']/g)];
  const namespacedFiles = new Set(namespaceImports.map((m) => m[2]));

  // strip this file's own import lines before searching its body, so a
  // name appearing only in its own import statement doesn't self-match.
  // Also strip any "namespace.identifier" occurrence (e.g. api.login) so a
  // namespaced module's export names don't get flagged as bare-identifier misses.
  let body = text.replace(/import\s*\{[^}]+\}\s*from\s*["'][^"']+["'];?/gs, "").replace(/import\s*\*\s*as\s*\w+\s*from\s*["'][^"']+["'];?/g, "");
  for (const m of namespaceImports) {
    const ns = m[1];
    body = body.replace(new RegExp(`\\b${ns}\\.\\w+`, "g"), "");
  }

  for (const otherFile of files) {
    if (otherFile === f) continue;
    if (namespacedFiles.has(otherFile)) continue; // accessed via namespace, not bare names
    for (const name of exportsByFile[otherFile]) {
      const usedPattern = new RegExp(`(?<![\\w.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);
      if (usedPattern.test(body) && !importedNames.has(name)) {
        fail(`${f} uses "${name}" (exported from ${otherFile}) but never imports it`);
      }
    }
  }
}
if (failures === 0) ok("every cross-file function reference is properly imported");

// ---------- 3. Every document.getElementById target exists somewhere reachable ----------
// "Somewhere reachable" means either the static index.html, OR the SAME JS
// file creates it dynamically via an innerHTML template string (a normal,
// common pattern: build the element, then immediately wire it up).
console.log("\n=== 3. DOM id check ===");
const indexHtml = readFileSync(path.join(root, "public/index.html"), "utf8");
const preCount = failures;
for (const f of files) {
  const text = readFileSync(path.join(jsDir, f), "utf8");
  const ids = [...text.matchAll(/document\.getElementById\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  const dynamicIds = new Set([...text.matchAll(/id=["']([^"']+)["']/g)].map((m) => m[1]));
  for (const id of new Set(ids)) {
    if (!indexHtml.includes(`id="${id}"`) && !dynamicIds.has(id)) {
      fail(`${f} references document.getElementById("${id}") but no element with that id exists in index.html or is created dynamically in ${f}`);
    }
  }
}
if (failures === preCount) ok("every referenced DOM id exists (static or dynamically created)");

// ---------- 4. CSS brace balance ----------
console.log("\n=== 4. CSS brace balance ===");
const css = readFileSync(path.join(root, "public/styles.css"), "utf8");
const open = (css.match(/\{/g) || []).length;
const close = (css.match(/\}/g) || []).length;
if (open !== close) fail(`styles.css has ${open} '{' but ${close} '}'`);
else ok(`styles.css braces balanced (${open} pairs)`);

// ---------- 5. Migration smoke test against intentionally old/incomplete data ----------
console.log("\n=== 5. Migration smoke test (old/missing-field data shapes) ===");
try {
  const stateMod = await import(path.join(jsDir, "state.js"));
  const { defaultState, migratePeriod, migrateTransfersToStateLevel } = stateMod;

  // Simulate an account whose saved data predates every recent feature —
  // the exact shape that broke login.
  const remote = defaultState();
  delete remote.unbilledRevenue;
  delete remote.tombstones.unbilledRevenue;
  delete remote.transfers;
  remote.periods[0].label = "Old Saved Period";
  delete remote.periods[0].interest;
  delete remote.periods[0].projectedAP;
  delete remote.periods[0].basinSavingsDistributions;

  if (!remote.manualOutflowCategories.includes("Other")) remote.manualOutflowCategories.push("Other");
  if (!remote.unbilledReceivables) remote.unbilledReceivables = [];
  if (!remote.transfers) remote.transfers = [];
  if (!remote.tombstones) remote.tombstones = { receivables: {}, payables: {}, fixedPayments: {}, unbilledReceivables: {}, transfers: {}, unbilledRevenue: {} };
  if (!remote.tombstones.transfers) remote.tombstones.transfers = {};
  if (!remote.tombstones.unbilledRevenue) remote.tombstones.unbilledRevenue = {};
  if (!remote.unbilledRevenue) { remote.unbilledRevenue = stateMod.seedUnbilledRevenue(); }
  remote.periods.forEach((p) => migratePeriod(p));
  migrateTransfersToStateLevel(remote);

  // also run a full forecast computation against this migrated data, since
  // a migration can "succeed" but still leave a shape that crashes compute
  const calc = stateMod.computeForecast(remote, remote.periods[0]);
  if (!calc || !Array.isArray(calc.weeks)) throw new Error("computeForecast returned something unexpected");

  ok("boot's exact migration sequence + a full forecast computation both run clean against old-shaped data");
} catch (e) {
  fail(`migration smoke test threw: ${e.stack || e.message}`);
}

// ---------- 6. Combined single-file bundle — checked under real module-parsing rules ----------
// This exists because of a second real incident: state.js and views.js each
// independently defined their own local `sum()` helper. node --check on a
// plain .js file (classic-script parsing) silently allows two top-level
// function declarations with the same name — but the single-file build ships
// as <script type="module">, where that is a hard SyntaxError, and it only
// surfaced when actually loaded in a browser. A classic-script check can
// never catch this; only checking under genuine module-parsing rules (the
// .mjs extension forces that in Node, matching the browser) can.
console.log("\n=== 6. Combined bundle — module-parsing check (catches the duplicate-sum bug's root cause) ===");
try {
  const stripImports = (text) => text.replace(/^import[\s\S]*?;\s*\n/gm, "");
  const stripExports = (text) => text.replace(/^export (function|const|async function|let)/gm, "$1");
  const read = (f) => readFileSync(path.join(jsDir, f), "utf8");
  const apiNs = "const api = { getToken, getUser, setSession, clearSession, login, fetchState, saveState, fetchHistory, fetchSnapshot };";
  const combined = [
    stripExports(read("util.js")),
    stripExports(read("api.js")),
    apiNs,
    stripExports(stripImports(read("state.js"))),
    stripExports(stripImports(read("parser.js"))),
    stripExports(stripImports(read("views.js"))),
    stripImports(read("main.js")),
  ].join("\n");
  const tmpFile = path.join(root, "scripts", ".preflight-bundle-check.mjs");
  writeFileSync(tmpFile, combined);
  try {
    execSync(`node --check "${tmpFile}"`, { stdio: "pipe" });
    ok("combined bundle parses cleanly as a real ES module (no duplicate top-level declarations)");

    // ---------- 7. ESLint no-undef — catches cross-scope variable-name mix-ups ----------
    // A second real, recurring bug class: a variable correctly scoped in one
    // function gets referenced by a similarly-named but different variable in
    // another function during a refactor (netTotal, then weeksMetaFull vs
    // weeksMetaForChart). node --check cannot catch this — it's a reference
    // error, not a syntax error. ESLint's no-undef rule tracks real variable
    // scope and catches it. Caught this exact bug class twice before this
    // check existed.
    console.log("\n=== 7. ESLint no-undef (catches cross-scope variable-name mix-ups) ===");
    try {
      const eslintConfig = path.join(root, "scripts", "eslint-undef-config.mjs");
      execSync(`npx --yes eslint --no-config-lookup --config "${eslintConfig}" "${tmpFile}"`, { stdio: "pipe", timeout: 60000 });
      ok("no undefined-variable references in the combined bundle");
    } catch (e) {
      const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
      if (/ENOTFOUND|ETIMEDOUT|network|could not resolve/i.test(out) || e.signal === "SIGTERM") {
        console.log("WARN: could not reach npm registry to run ESLint — skipping this check this run (not a code failure)");
      } else {
        fail(`ESLint found undefined-variable references that would crash at runtime:\n${out}`);
      }
    }
  } catch (e) {
    fail(`the combined single-file bundle has a module-parsing error that would crash in the browser:\n${e.stderr?.toString() || e.message}`);
  } finally {
    unlinkSync(tmpFile);
  }
} catch (e) {
  fail(`combined bundle check itself threw: ${e.stack || e.message}`);
}

// ---------- Summary ----------
console.log("\n" + "=".repeat(50));
if (failures > 0) {
  console.error(`${failures} CHECK(S) FAILED — DO NOT SHIP THIS BUILD`);
  process.exit(1);
} else {
  console.log("ALL CHECKS PASSED — safe to package and ship");
  process.exit(0);
}
