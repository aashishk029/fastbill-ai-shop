"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isPublicRoute,
  shopIdFromPath,
  resourceScopeFor,
  shopIdsInRequest,
  readBearerToken,
  resolveSecret,
  signSession,
  verifySession,
  makeAuthMiddleware,
} = require("./auth");

const SECRET = "x".repeat(48);
const SHOP = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

// --- what may be reached without logging in -------------------------------------------

test("login and health are reachable without a session", () => {
  assert.equal(isPublicRoute("POST", "/api/shops/login"), true);
  assert.equal(isPublicRoute("GET", "/api/health"), true);
});

test("the online-order webhook stays public because it carries its own secret", () => {
  assert.equal(isPublicRoute("POST", "/api/webhooks/online-order"), true);
});

test("shop data is never public", () => {
  assert.equal(isPublicRoute("GET", `/api/shops/${SHOP}`), false);
  assert.equal(isPublicRoute("GET", `/api/inventory/status/${SHOP}`), false);
});

test("a public path on the wrong verb is not public", () => {
  // GET /api/shops/login must not slip through the POST allowance.
  assert.equal(isPublicRoute("GET", "/api/shops/login"), false);
});

test("query strings and trailing slashes do not smuggle a path past the check", () => {
  assert.equal(isPublicRoute("GET", "/api/health?x=1"), true);
  assert.equal(isPublicRoute("GET", `/api/shops/${SHOP}?pretty=1`), false);
});

// --- reading the session --------------------------------------------------------------

test("a signed session round-trips", () => {
  const token = signSession({ shopId: SHOP }, SECRET);
  assert.equal(verifySession(token, SECRET).shopId, SHOP);
});

test("a session signed with another secret is rejected", () => {
  const token = signSession({ shopId: SHOP }, "y".repeat(48));
  assert.equal(verifySession(token, SECRET), null);
});

test("a tampered payload is rejected rather than trusted", () => {
  const token = signSession({ shopId: SHOP }, SECRET);
  const [h, , s] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ shopId: OTHER })).toString("base64url");
  assert.equal(verifySession(`${h}.${forged}.${s}`, SECRET), null);
});

test("garbage and empty tokens are rejected, not thrown on", () => {
  assert.equal(verifySession("not-a-token", SECRET), null);
  assert.equal(verifySession("", SECRET), null);
  assert.equal(verifySession(null, SECRET), null);
});

test("the bearer header is read case-insensitively and trimmed", () => {
  assert.equal(readBearerToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(readBearerToken({ headers: { authorization: "bearer  abc  " } }), "abc");
  assert.equal(readBearerToken({ headers: {} }), null);
  assert.equal(readBearerToken({ headers: { authorization: "Basic abc" } }), null);
});

test("a missing JWT_SECRET yields a random secret, never a fixed fallback", () => {
  const a = resolveSecret({}, () => {});
  const b = resolveSecret({}, () => {});
  assert.equal(a.ephemeral, true);
  assert.notEqual(a.secret, b.secret, "two boots must not share a guessable secret");
  assert.ok(a.secret.length >= 32);
});

test("a too-short JWT_SECRET is refused rather than used weakly", () => {
  const r = resolveSecret({ JWT_SECRET: "short" }, () => {});
  assert.equal(r.ephemeral, true);
  assert.notEqual(r.secret, "short");
});

test("a proper JWT_SECRET is used as-is so sessions survive a restart", () => {
  const r = resolveSecret({ JWT_SECRET: SECRET }, () => {});
  assert.deepEqual(r, { secret: SECRET, ephemeral: false });
});

// --- which shop a request is asking about ---------------------------------------------

test("a shop id is picked up from path, body or query alike", () => {
  // The path form is what app-level middleware actually sees; req.params is empty there.
  assert.deepEqual(shopIdsInRequest({ method: "GET", path: `/api/shops/${SHOP}`, params: {} }), [SHOP]);
  assert.deepEqual(shopIdsInRequest({ method: "POST", path: "/api/invoices/generate", body: { shopId: SHOP } }), [SHOP]);
  assert.deepEqual(shopIdsInRequest({ method: "GET", path: "/api/whatever", query: { shopId: SHOP } }), [SHOP]);
});

test("a request naming two different shops surfaces both so it can be refused", () => {
  const ids = shopIdsInRequest({ method: "GET", path: `/api/shops/${SHOP}`, body: { shopId: OTHER } });
  assert.deepEqual(ids.sort(), [SHOP, OTHER].sort());
});

test("the shop id is read from the path itself, since req.params is empty in middleware", () => {
  assert.equal(shopIdFromPath("GET", `/api/shops/${SHOP}`), SHOP);
  assert.equal(shopIdFromPath("GET", `/api/inventory/status/${SHOP}`), SHOP);
  assert.equal(shopIdFromPath("POST", `/api/export/${SHOP}/tally`), SHOP);
  assert.equal(shopIdFromPath("GET", `/api/shops/${SHOP}/staff`), SHOP);
});

test("a record id is not mistaken for a shop id", () => {
  // DELETE /api/recurring-invoices/:id names a record; only the GET form names a shop.
  assert.equal(shopIdFromPath("DELETE", "/api/recurring-invoices/rec1"), null);
  assert.equal(shopIdFromPath("GET", `/api/recurring-invoices/${SHOP}`), SHOP);
  assert.equal(shopIdFromPath("DELETE", "/api/expenses/e1"), null);
  assert.equal(shopIdFromPath("GET", `/api/expenses/${SHOP}`), SHOP);
});

test("a trailing record id does not shadow the shop id in front of it", () => {
  assert.equal(shopIdFromPath("GET", `/api/credit-notes/${SHOP}/cn1`), SHOP);
  assert.equal(shopIdFromPath("GET", `/api/purchases/latest-rate/${SHOP}/design1`), SHOP);
  assert.equal(shopIdFromPath("DELETE", `/api/shops/${SHOP}/staff/staff1`), SHOP);
});

test("every :shopId route in server.js is covered by the scope table", () => {
  // The guard: adding a shop-scoped route without registering its shape here would leave
  // it reachable with any session, so that mistake fails the suite instead of shipping.
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = [...src.matchAll(/^app\.(get|post|put|patch|delete)\("(\/api\/[^"]*:shopId[^"]*)"/gm)]
    .map((m) => ({ method: m[1].toUpperCase(), path: m[2] }));
  assert.ok(routes.length >= 25, `expected many shop-scoped routes, found ${routes.length}`);
  const uncovered = routes.filter(({ method, path: p }) => {
    const concrete = p.replace(":shopId", SHOP).replace(/:[A-Za-z]+/g, "xyz");
    return shopIdFromPath(method, concrete) !== SHOP;
  });
  assert.deepEqual(uncovered, [], "these routes carry a shopId but no scope entry");
});

// --- record-level ownership ------------------------------------------------------------

test("record routes map to the table that ties the record to a shop", () => {
  assert.deepEqual(resourceScopeFor("DELETE", "/api/invoices/abc"), { table: "invoices", column: "id", id: "abc" });
  assert.deepEqual(resourceScopeFor("POST", "/api/purchases/p1/return"), { table: "purchases", column: "id", id: "p1" });
});

test("payment events resolve through the invoice, which is what holds the shop", () => {
  assert.deepEqual(resourceScopeFor("GET", "/api/payment-events/inv9"), { table: "invoices", column: "id", id: "inv9" });
});

test("a design proves ownership through the inventory row that stocks it", () => {
  // designs has no shop_id column at all, so id-on-designs would not be checkable.
  assert.deepEqual(resourceScopeFor("PATCH", "/api/designs/d1/unit"), { table: "inventory", column: "design_id", id: "d1" });
});

test("same path shape, different verb, different meaning", () => {
  // GET /api/expenses/:shopId lists a shop; DELETE /api/expenses/:id removes one record.
  assert.equal(resourceScopeFor("GET", `/api/expenses/${SHOP}`), null);
  assert.deepEqual(resourceScopeFor("DELETE", "/api/expenses/e1"), { table: "expenses", column: "id", id: "e1" });
});

test("routes that already name their shop need no record lookup", () => {
  assert.equal(resourceScopeFor("GET", `/api/inventory/status/${SHOP}`), null);
  assert.equal(resourceScopeFor("PATCH", "/api/inventory/adjust"), null);
});

// --- the middleware ---------------------------------------------------------------------

function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ passed: false, status: this.statusCode, body: b }); return this; },
    };
    mw(req, res, () => resolve({ passed: true, req }));
  });
}

const req = (over = {}) => ({ method: "GET", path: "/api/health", headers: {}, params: {}, body: {}, query: {}, ...over });
const authed = (shopId) => ({ authorization: `Bearer ${signSession({ shopId }, SECRET)}` });
const stubDb = (row) => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }) }) }) });

test("a request with no session is refused", async () => {
  const mw = makeAuthMiddleware({ supabase: stubDb(null), secret: SECRET });
  const out = await runMiddleware(mw, req({ path: `/api/shops/${SHOP}`, params: { shopId: SHOP } }));
  assert.equal(out.passed, false);
  assert.equal(out.status, 401);
});

test("a valid session reaches its own shop", async () => {
  const mw = makeAuthMiddleware({ supabase: stubDb(null), secret: SECRET });
  const out = await runMiddleware(mw, req({ path: `/api/shops/${SHOP}`, params: { shopId: SHOP }, headers: authed(SHOP) }));
  assert.equal(out.passed, true);
  assert.equal(out.req.auth.shopId, SHOP);
});

test("a valid session cannot reach a different shop", async () => {
  // The whole point: holding one shop's UUID no longer opens another's data.
  const mw = makeAuthMiddleware({ supabase: stubDb(null), secret: SECRET });
  const out = await runMiddleware(mw, req({ path: `/api/shops/${OTHER}`, params: { shopId: OTHER }, headers: authed(SHOP) }));
  assert.equal(out.status, 403);
});

test("a shop id smuggled in the body is checked too, not just the path", async () => {
  const mw = makeAuthMiddleware({ supabase: stubDb(null), secret: SECRET });
  const out = await runMiddleware(mw, req({
    method: "POST", path: "/api/invoices/generate", body: { shopId: OTHER }, headers: authed(SHOP),
  }));
  assert.equal(out.status, 403);
});

test("deleting another shop's invoice is refused even with a valid session", async () => {
  const mw = makeAuthMiddleware({ supabase: stubDb(null), secret: SECRET }); // lookup finds nothing for this shop
  const out = await runMiddleware(mw, req({ method: "DELETE", path: "/api/invoices/abc", headers: authed(SHOP) }));
  assert.equal(out.status, 404);
});

test("deleting your own invoice passes the record check", async () => {
  const mw = makeAuthMiddleware({ supabase: stubDb({ shop_id: SHOP }), secret: SECRET });
  const out = await runMiddleware(mw, req({ method: "DELETE", path: "/api/invoices/abc", headers: authed(SHOP) }));
  assert.equal(out.passed, true);
});

test("public routes skip every check", async () => {
  const mw = makeAuthMiddleware({ supabase: stubDb(null), secret: SECRET });
  assert.equal((await runMiddleware(mw, req({ method: "POST", path: "/api/shops/login" }))).passed, true);
});

test("report-only mode lets the request through but says what it would have blocked", async () => {
  const lines = [];
  const mw = makeAuthMiddleware({ supabase: stubDb(null), secret: SECRET, enforce: false, log: (m) => lines.push(m) });
  const out = await runMiddleware(mw, req({ path: `/api/shops/${OTHER}`, params: { shopId: OTHER }, headers: authed(SHOP) }));
  assert.equal(out.passed, true, "an old app build must keep working during rollout");
  assert.match(lines.join("\n"), /would have blocked/);
});

// --- path spellings that reach the same route ------------------------------------------

test("a trailing slash does not skip the shop check", () => {
  // Express runs with strict routing off, so /api/shops/<id>/ hits the same handler.
  // Matching the raw path missed it, which let one session read another shop.
  assert.equal(shopIdFromPath("GET", `/api/shops/${OTHER}/`), OTHER);
});

test("an uppercased path does not skip the shop check", () => {
  // Case-sensitive routing is off too, so /API/SHOPS/<id> reaches the handler as well.
  assert.equal(shopIdFromPath("GET", `/API/SHOPS/${OTHER}`), OTHER);
  assert.equal(shopIdFromPath("GET", `/API/Inventory/Status/${OTHER}`), OTHER);
});

test("doubled slashes do not skip the shop check", () => {
  assert.equal(shopIdFromPath("GET", `/api//shops/${OTHER}`), OTHER);
});

test("record routes are matched under the same spellings", () => {
  assert.deepEqual(resourceScopeFor("DELETE", "/API/Invoices/abc/"), { table: "invoices", column: "id", id: "abc" });
});

test("public routes stay public under those spellings, and no others sneak in", () => {
  assert.equal(isPublicRoute("GET", "/API/Health/"), true);
  assert.equal(isPublicRoute("GET", `/API/SHOPS/${SHOP}/`), false);
});

test("the id keeps its original case so it can be compared to the session", () => {
  // Lowercasing the whole path would corrupt the id before the comparison.
  assert.equal(shopIdFromPath("GET", "/API/SHOPS/AbCd-1234"), "AbCd-1234");
});

test("a session for one shop cannot reach another by respelling the path", async () => {
  const mw = makeAuthMiddleware({ supabase: stubDb(null), secret: SECRET });
  for (const p of [`/api/shops/${OTHER}/`, `/API/SHOPS/${OTHER}`, `/api//shops/${OTHER}`]) {
    const out = await runMiddleware(mw, req({ path: p, headers: authed(SHOP) }));
    assert.equal(out.status, 403, `${p} should be refused`);
  }
});

test("a failed ownership lookup blocks when enforcing but not in report-only", async () => {
  const exploding = { from: () => { throw new Error("db down"); } };
  const enforcing = makeAuthMiddleware({ supabase: exploding, secret: SECRET });
  const out = await runMiddleware(enforcing, req({ method: "DELETE", path: "/api/invoices/abc", headers: authed(SHOP) }));
  assert.equal(out.status, 503, "an errored lookup proves nothing about ownership");

  const reporting = makeAuthMiddleware({ supabase: exploding, secret: SECRET, enforce: false, log: () => {} });
  const out2 = await runMiddleware(reporting, req({ method: "DELETE", path: "/api/invoices/abc", headers: authed(SHOP) }));
  assert.equal(out2.passed, true, "a database hiccup must not start blocking during rollout");
});
