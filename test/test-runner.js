"use strict";
// Pure-function tests for the profile runner (no browser).
const test = require("node:test");
const assert = require("node:assert/strict");
const { renderTemplate, validateProfile, getRecipe, validateItems, parseParams, resolveScope } = require("../runner/profile-runner.js");

const baseProfile = {
  schemaVersion: 2,
  domain: "example.com",
  recipes: [
    {
      purpose: "search",
      status: "verified",
      execution: {
        kind: "dom-extract",
        openUrlTemplate: "https://example.com/search?q=${q}&page=${page}",
        extractJs: "(()=>[])",
        requiredFields: ["title", "url"],
        minItems: 1,
      },
    },
  ],
};

test("renderTemplate encodes values into the query string", () => {
  const url = renderTemplate("https://x/?q=${q}&page=${page}", { q: "AI automation", page: 2 });
  assert.equal(url, "https://x/?q=AI%20automation&page=2");
});

test("renderTemplate leaves an absolute URL placeholder untouched", () => {
  const url = renderTemplate("https://x/redirect?to=${u}", { u: "https://y/a b" });
  assert.equal(url, "https://x/redirect?to=https://y/a b");
});

test("renderTemplate rejects a missing parameter by name", () => {
  assert.throws(() => renderTemplate("https://x/?q=${q}", {}), /缺参数 q/);
});

test("parseParams collects repeated --param k=v flags", () => {
  const p = parseParams(["--task", "search", "--param", "q=AI automation", "--param", "page=1"]);
  assert.deepEqual(p, { q: "AI automation", page: "1" });
});

test("parseParams rejects a malformed value", () => {
  assert.throws(() => parseParams(["--param", "oops"]), /k=v/);
});

test("validateProfile rejects unknown schemaVersion and non-dom-extract recipes", () => {
  assert.throws(() => validateProfile({ ...baseProfile, schemaVersion: 9 }), /schemaVersion/);
  const broken = JSON.parse(JSON.stringify(baseProfile));
  broken.recipes[0].execution.kind = "api-capture";
  assert.throws(() => validateProfile(broken), /只支持 dom-extract/);
});

test("getRecipe lists available purposes when the task is unknown", () => {
  const profile = validateProfile(baseProfile);
  assert.equal(getRecipe(profile, "search").purpose, "search");
  assert.throws(() => getRecipe(profile, "nope"), /可用：search/);
});

test("validateItems: limit is a cap, not a floor", () => {
  const exec = { requiredFields: ["title"], minItems: 1 };
  const items = [{ title: "a" }, { title: "b" }];
  const r = validateItems(items, exec, { limit: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.got, 1);
});

test("validateItems: zero items is blank, never ok", () => {
  const r = validateItems([], { requiredFields: ["title"], minItems: 0 }, {});
  assert.equal(r.state, "blank");
  assert.equal(r.ok, false);
});

test("validateItems: missing required fields is invalid with a reason", () => {
  const r = validateItems([{ title: "a", url: "" }], { requiredFields: ["title", "url"], minItems: 1 }, {});
  assert.equal(r.ok, false);
  assert.equal(r.state, "invalid");
  assert.match(r.reason, /缺字段/);
});

test("resolveScope applies recipe defaults (bounded, one page)", () => {
  const recipe = { defaults: { page: "1", limit: 10 }, maxLimit: 10, execution: {} };
  const { limit, params, scope } = resolveScope(recipe, []);
  assert.equal(limit, 10);
  assert.equal(params.page, "1");
  assert.deepEqual(scope, { page: 1, limit: 10, maxLimit: 10, showMore: false, pages: 1 });
});

test("resolveScope lets an explicit limit win within the cap", () => {
  const recipe = { defaults: { limit: 10 }, maxLimit: 10, execution: {} };
  assert.equal(resolveScope(recipe, ["--limit", "3"]).limit, 3);
});

test("resolveScope refuses a limit above maxLimit before any browser work", () => {
  const recipe = { defaults: { limit: 10 }, maxLimit: 10, execution: {} };
  assert.throws(() => resolveScope(recipe, ["--limit", "99"]), /maxLimit=10/);
});

test("resolveScope refuses a write recipe without --allow-write", () => {
  const recipe = { writes: true, maxLimit: 1, execution: {} };
  assert.throws(() => resolveScope(recipe, []), /--allow-write/);
  assert.equal(resolveScope(recipe, ["--allow-write"]).limit, undefined);
});
