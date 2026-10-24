#!/usr/bin/env node
"use strict";
// Live contract tests for the site profiles (real browser, real login).
//
// Covers: preflight, normal paths (P0), boundary/error paths (P1), data quality,
// default collection scope, stability (P2). Every case drives the real CLI in
// `runner/profile-runner.js`, so exit codes and the JSON summary are tested too.
//
//   node --test test/test-profiles-live.js
//   SYNAPSE_TEST_SESSION=my-bridge node --test test/test-profiles-live.js
//
// Requires: a running bridge (`agent-collect.js serve <sid>`) with the extension
// attached, and a logged-in browser (Upwork Basic, Fiverr Pro on this machine).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RUNNER = path.join(ROOT, "runner", "profile-runner.js");
const AGENT = path.join(ROOT, "agent", "agent-collect.js");
const SESSION = process.env.SYNAPSE_TEST_SESSION || "profile-test";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-profiles-"));
const OUT = (name) => path.join(TMP, name + ".json");

function run(args, timeout = 180000) {
  const r = spawnSync(process.execPath, [RUNNER, "--session", SESSION, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = String(r.stdout || "")
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  let summary = null;
  try {
    summary = line ? JSON.parse(line) : null;
  } catch (_) {}
  return { code: r.status, summary, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function readOut(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const isEmpty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

function assertFields(items, fields, label) {
  const missing = [];
  for (const item of items) {
    for (const f of fields) {
      if (isEmpty(item[f])) missing.push({ field: f, item: item });
    }
  }
  assert.equal(missing.length, 0, label + " 有 " + missing.length + " 个空字段，首个: " + JSON.stringify(missing[0]));
}

function assertUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const k = String(item[key] || "");
    assert.ok(!seen.has(k), label + " 出现重复 " + key + ": " + k);
    seen.add(k);
  }
}

// ---------------- preflight ----------------
test("preflight: bridge is up and the extension is attached", () => {
  const r = spawnSync(process.execPath, [AGENT, "status", "--session", SESSION], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20000,
  });
  const line = String(r.stdout || "").split("\n").find((l) => l.trim().startsWith("{"));
  const status = line ? JSON.parse(line) : null;
  assert.ok(status && status.ok, "bridge not ready: " + JSON.stringify(status));
  assert.ok((status.extension.wsAgents || []).length > 0, "extension not attached: " + JSON.stringify(status.extension));
});

// ---------------- P0: normal paths ----------------
test("upwork search: 10 jobs, clean URLs, digits cipher", () => {
  const out = OUT("uw-search");
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation", "--out", out]);
  assert.equal(r.code, 0, "exit " + r.code + " " + r.stderr.slice(0, 300));
  assert.equal(r.summary.got, 10);
  assert.equal(r.summary.scope.page, 1);
  assert.equal(r.summary.scope.limit, 10);
  const items = readOut(out);
  assert.equal(items.length, 10);
  assertFields(items, ["title", "url", "cipher"], "upwork search");
  assertUnique(items, "url", "upwork search");
  for (const it of items) {
    assert.match(it.url, /^https:\/\/www\.upwork\.com\/jobs\/~\d+\/$/, "dirty url: " + it.url);
    assert.match(it.cipher, /^\d{15,}$/);
    assert.ok(it.title.length > 5, "title too short: " + it.title);
  }
  const proposals = items.filter((i) => i.proposals).map((i) => i.proposals);
  assert.ok(proposals.every((p) => /^Proposals:\s*\S/.test(p)), "bad proposals: " + proposals.join(" | "));
});

let searchCipher = null;

test("upwork job: detail body and client block by cipher", () => {
  const search = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation", "--out", OUT("uw-search2")]);
  searchCipher = readOut(OUT("uw-search2"))[0].cipher;
  const out = OUT("uw-job");
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "job", "--param", "cipher=" + searchCipher, "--out", out]);
  assert.equal(r.code, 0, r.stderr.slice(0, 300));
  const [job] = readOut(out);
  assert.ok(job.descriptionLen > 200, "descriptionLen=" + job.descriptionLen);
  assert.ok(job.url.includes("~" + searchCipher + "/"), "url mismatch: " + job.url);
  assertFields([job], ["title", "description"], "upwork job");
});

test("upwork feed: default board is bounded", () => {
  const out = OUT("uw-feed");
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "feed", "--out", out]);
  assert.equal(r.code, 0, r.stderr.slice(0, 300));
  assert.ok(r.summary.got >= 1 && r.summary.got <= 10, "got=" + r.summary.got);
  const items = readOut(out);
  assertFields(items, ["title", "url"], "upwork feed");
  assertUnique(items, "url", "upwork feed");
});

test("upwork saved: read-only list, no duplicates", () => {
  const out = OUT("uw-saved");
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "saved", "--out", out]);
  assert.equal(r.code, 0, r.stderr.slice(0, 300));
  const items = readOut(out);
  assert.ok(items.length >= 1, "saved list empty");
  assertFields(items, ["title", "url"], "upwork saved");
  assertUnique(items, "url", "upwork saved");
});

test("fiverr search: 16 freelancers with ratings and clean urls", () => {
  const out = OUT("fv-search");
  const r = run(["--profile", "profiles/fiverr.com.json", "--task", "search", "--param", "q=ai automation", "--out", out]);
  assert.equal(r.code, 0, r.stderr.slice(0, 300));
  assert.ok(r.summary.got >= 14 && r.summary.got <= 16, "got=" + r.summary.got);
  assert.equal(r.summary.scope.limit, 16);
  assert.equal(r.summary.scope.showMore, false);
  const items = readOut(out);
  assertFields(items, ["name", "url"], "fiverr search");
  assertUnique(items, "url", "fiverr search");
  for (const it of items) {
    assert.match(it.url, /^https:\/\/pro\.fiverr\.com\/(freelancers|agencies)\//);
    if (it.rating) assert.match(it.rating, /^\d\.\d$/);
    if (it.reviews) assert.match(it.reviews, /^\d+$/);
    assert.ok(["freelancer", "agency"].includes(it.type), "bad type: " + it.type);
  }
});

test("fiverr freelancer: detail page", () => {
  const out = OUT("fv-detail");
  const r = run(["--profile", "profiles/fiverr.com.json", "--task", "freelancer", "--param", "username=bakhtali1", "--out", out]);
  assert.equal(r.code, 0, r.stderr.slice(0, 300));
  const [p] = readOut(out);
  assert.ok(p.name && p.name.length > 1, "empty name");
  assert.ok(p.aboutLen > 0, "aboutLen=0");
});

// ---------------- P1: boundary and error paths ----------------
test("missing required param fails before opening a tab", () => {
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "search"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /缺参数 q/);
  assert.equal(r.summary, null);
});

test("unknown task lists available purposes", () => {
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "nope"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /可用：/);
});

test("limit above maxLimit is refused before the browser", () => {
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation", "--limit", "100"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /maxLimit=10/);
  assert.equal(r.summary, null);
});

test("limit is a cap: limit=1 returns one item", () => {
  const out = OUT("uw-one");
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation", "--limit", "1", "--out", out]);
  assert.equal(r.code, 0, r.stderr.slice(0, 200));
  assert.equal(r.summary.got, 1);
  assert.equal(r.summary.scope.limit, 1);
  assert.equal(readOut(out).length, 1);
});

test("explicit page=2 returns a different page", () => {
  const out1 = OUT("uw-p1");
  const out2 = OUT("uw-p2");
  const a = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation", "--param", "page=1", "--out", out1]);
  const b = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation", "--param", "page=2", "--out", out2]);
  assert.equal(a.code, 0, a.stderr.slice(0, 200));
  assert.equal(b.code, 0, b.stderr.slice(0, 200));
  assert.equal(b.summary.scope.page, 2);
  const aUrls = new Set(readOut(out1).map((i) => i.url));
  const overlap = readOut(out2).filter((i) => aUrls.has(i.url)).length;
  assert.ok(overlap <= 1, "page 2 overlapped page 1 by " + overlap + " items");
});

test("out-of-range page is bounded, never unbounded", () => {
  // Upwork clamps the page instead of returning zero results; the contract is
  // "one page worth of items, never more".
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation", "--param", "page=99"]);
  assert.ok([0, 2].includes(r.code), "unexpected exit " + r.code);
  if (r.code === 0) assert.ok(r.summary.got <= 10, "got=" + r.summary.got);
});

test("no-match query is rejected as off-query, not ingested", () => {
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=zzzqqqxxyy"]);
  assert.equal(r.code, 2);
  assert.equal(r.summary.state, "off-query");
  assert.match(r.summary.reason, /无关/);
});

test("non-ascii query is URI-encoded", () => {
  const r = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=自动化", "--limit", "1"]);
  assert.ok([0, 2].includes(r.code), "unexpected exit " + r.code);
  assert.match(r.summary.url, /q=%E8%87%AA%E5%8A%A8%E5%8C%96/);
  if (r.code === 2) assert.equal(r.summary.state, "off-query");
});

test("fiverr page param is a documented no-op (same set)", () => {
  const out1 = OUT("fv-p1");
  const out2 = OUT("fv-p2");
  const a = run(["--profile", "profiles/fiverr.com.json", "--task", "search", "--param", "q=ai automation", "--param", "page=1", "--out", out1]);
  const b = run(["--profile", "profiles/fiverr.com.json", "--task", "search", "--param", "q=ai automation", "--param", "page=2", "--out", out2]);
  assert.equal(a.code, 0, a.stderr.slice(0, 200));
  assert.equal(b.code, 0, b.stderr.slice(0, 200));
  const setA = new Set(readOut(out1).map((i) => i.url));
  const overlap = readOut(out2).filter((i) => setA.has(i.url)).length;
  assert.equal(overlap, 16, "expected the same 16 people, got overlap=" + overlap);
});

test("write recipes need --allow-write", () => {
  const profilePath = path.join(TMP, "write-profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      schemaVersion: 2,
      domain: "example.com",
      recipes: [
        {
          purpose: "save",
          writes: true,
          execution: {
            kind: "dom-extract",
            openUrlTemplate: "https://example.com/save?q=${q}",
            extractJs: "(()=>[])",
          },
        },
      ],
    }),
    "utf8",
  );
  const blocked = run(["--profile", profilePath, "--task", "save", "--param", "q=x"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /--allow-write/);
});

// ---------------- P2: stability ----------------
test("repeat runs are stable", () => {
  const counts = [];
  for (let i = 0; i < 2; i++) {
    const r = run(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation"]);
    assert.equal(r.code, 0, r.stderr.slice(0, 200));
    counts.push(r.summary.got);
  }
  assert.ok(counts.every((c) => c === 10), "unstable counts: " + counts.join(","));
});

test("two recipes can run concurrently", async () => {
  const spawnOne = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [RUNNER, "--session", SESSION, ...args], { cwd: ROOT });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });
  const [a, b] = await Promise.all([
    spawnOne(["--profile", "profiles/upwork.com.json", "--task", "search", "--param", "q=AI automation"]),
    spawnOne(["--profile", "profiles/fiverr.com.json", "--task", "freelancer", "--param", "username=bakhtali1"]),
  ]);
  assert.equal(a.code, 0, "concurrent search failed: " + a.out.slice(0, 200));
  assert.equal(b.code, 0, "concurrent freelancer failed: " + b.out.slice(0, 200));
});

test("no capture sessions or profile tabs leak", () => {
  const status = spawnSync(process.execPath, [AGENT, "status", "--session", SESSION], { cwd: ROOT, encoding: "utf8", timeout: 20000 });
  const line = String(status.stdout || "").split("\n").find((l) => l.trim().startsWith("{"));
  const snapshot = line ? JSON.parse(line) : null;
  assert.ok(snapshot && snapshot.ok, "bridge died");
  assert.equal(snapshot.extension.captureSessions, null, "capture session leaked");
});
