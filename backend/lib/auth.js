"use strict";

// Session auth for the shop API.
//
// Every data route used to take the shop UUID straight from the URL and answer with that
// shop's data, so the UUID was doing the job of a password. A UUID identifies; it cannot
// authenticate, because it travels in logs, URLs, screenshots and app bundles and can
// never be rotated once it leaks. This module issues a signed session at login and gives
// the server one place to answer two questions on every request: who is calling, and are
// they allowed to touch the shop this request names.
//
// The functions here are deliberately free of Express and Supabase so their rules can be
// tested directly; only makeAuthMiddleware binds them to a request.

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — a shopkeeper should not re-enter a PIN daily.

// Routes reachable without a session, and why each one has to be:
//   health        — uptime probes run before anyone logs in
//   shops/init    — creates the first shop; there is no session to present yet
//   shops/login   — issues the session
//   webhooks/*    — authenticated by its own shared secret via timingSafeEqual
//   ads/active    — public promo content, carries no shop data
//   jewellery/rates — public market rates, carries no shop data
const PUBLIC_ROUTES = [
  { method: "GET", path: "/api/health" },
  { method: "POST", path: "/api/shops/init" },
  { method: "POST", path: "/api/shops/login" },
  { method: "POST", path: "/api/webhooks/online-order" },
  { method: "GET", path: "/api/ads/active" },
  { method: "GET", path: "/api/jewellery/rates" },
];

// Express routes with strict routing and case-sensitive routing both off by default, so
// /api/shops/<id>/ and /API/SHOPS/<id> reach the same handler as /api/shops/<id>. Matching
// the raw path therefore missed those spellings and skipped the ownership check entirely —
// a session for one shop could read another just by adding a trailing slash. Every matcher
// below compares against this normalised form, and the patterns carry the /i flag; the
// captured id still comes from the original string, so its case is preserved for the
// comparison against the session.
//
// Percent-encoded spellings are deliberately left alone. Express matches literal segments
// against the raw path, so an encoded route name simply 404s, and an encoded id fails the
// comparison and is refused. Both directions fail closed.
function normalisePath(path) {
  return String(path || "")
    .split("?")[0]
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "") || "/";
}

function isPublicRoute(method, path) {
  const clean = normalisePath(path);
  return PUBLIC_ROUTES.some((r) => r.method === method && r.path.toLowerCase() === clean.toLowerCase());
}

// Routes that name a record by its own id instead of a shop id. The id alone says nothing
// about ownership, so each entry states which table holds the record and which column ties
// it back to a shop. Without this a caller with a valid session for their own shop could
// still delete another shop's invoice by guessing its id — authentication without
// authorisation.
//
// Method is part of the match because the same path shape means different things per verb:
// GET /api/expenses/:shopId lists a shop's expenses, while DELETE /api/expenses/:id removes
// one record.
const RESOURCE_SCOPES = [
  { method: "PATCH", pattern: /^\/api\/recurring-invoices\/([^/]+)$/i, table: "recurring_invoices" },
  { method: "DELETE", pattern: /^\/api\/recurring-invoices\/([^/]+)$/i, table: "recurring_invoices" },
  { method: "POST", pattern: /^\/api\/purchases\/([^/]+)\/return$/i, table: "purchases" },
  { method: "PATCH", pattern: /^\/api\/purchases\/([^/]+)\/payment$/i, table: "purchases" },
  { method: "POST", pattern: /^\/api\/cash-sessions\/([^/]+)\/close$/i, table: "cash_sessions" },
  { method: "PATCH", pattern: /^\/api\/bank-transactions\/([^/]+)\/match$/i, table: "bank_transactions" },
  { method: "PATCH", pattern: /^\/api\/invoices\/([^/]+)\/payment$/i, table: "invoices" },
  { method: "POST", pattern: /^\/api\/invoices\/([^/]+)\/return$/i, table: "invoices" },
  { method: "POST", pattern: /^\/api\/invoices\/([^/]+)\/eway-bill-data$/i, table: "invoices" },
  { method: "DELETE", pattern: /^\/api\/invoices\/([^/]+)$/i, table: "invoices" },
  { method: "DELETE", pattern: /^\/api\/inventory\/([^/]+)$/i, table: "inventory" },
  { method: "DELETE", pattern: /^\/api\/expenses\/([^/]+)$/i, table: "expenses" },
  // The path segment is an invoice id, and payment_events carries no shop column of its
  // own, so ownership is decided by the invoice the events hang off.
  { method: "GET", pattern: /^\/api\/payment-events\/([^/]+)$/i, table: "invoices" },
  // designs has no shop_id at all — a design reaches a shop through the inventory row that
  // stocks it, so that join is what proves ownership here.
  { method: "PATCH", pattern: /^\/api\/designs\/([^/]+)\/unit$/i, table: "inventory", column: "design_id" },
];

// Actions a staff member needs explicit permission for. The mobile app already hides these
// controls from staff who lack the permission, but hiding a button is not a control: the
// API sat open, so any staff login could delete invoices or rewrite prices by calling it
// directly. The owner (a session with no staffId) is never restricted.
const PERMISSION_SCOPES = [
  { methods: ["DELETE"], pattern: /^\/api\/inventory\/[^/]+$/i, permission: "canDelete" },
  { methods: ["DELETE"], pattern: /^\/api\/invoices\/[^/]+$/i, permission: "canDelete" },
  { methods: ["DELETE"], pattern: /^\/api\/expenses\/[^/]+$/i, permission: "canDelete" },
  { methods: ["DELETE"], pattern: /^\/api\/recurring-invoices\/[^/]+$/i, permission: "canDelete" },
  { methods: ["PATCH"], pattern: /^\/api\/inventory\/set-price$/i, permission: "canEditPrice" },
  { methods: ["POST", "PATCH", "DELETE"], pattern: /^\/api\/shops\/[^/]+\/staff(?:\/[^/]+)?$/i, permission: "canManageStaff" },
];

function permissionFor(method, path) {
  const clean = normalisePath(path);
  const hit = PERMISSION_SCOPES.find((s) => s.methods.includes(method) && s.pattern.test(clean));
  return hit ? hit.permission : null;
}

function resourceScopeFor(method, path) {
  const clean = normalisePath(path);
  for (const scope of RESOURCE_SCOPES) {
    if (scope.method !== method) continue;
    const m = clean.match(scope.pattern);
    if (m) return { table: scope.table, column: scope.column || "id", id: m[1] };
  }
  return null;
}

// Where a shop id sits in each path that carries one.
//
// This cannot read req.params: Express only fills those in once a route matches, and this
// gate runs as app-level middleware ahead of routing, so req.params is always empty here.
// Reading it anyway is exactly the kind of check that looks present and silently passes
// everything, so the position is matched explicitly instead.
//
// Method is part of the match because several paths mean different things per verb --
// GET /api/recurring-invoices/:shopId lists a shop's schedules while
// DELETE /api/recurring-invoices/:id removes one record. Order matters too: the literal
// prefixes (credit-score, latest-rate) are listed before the bare /:shopId forms they
// would otherwise be swallowed by.
//
// auth.test.js asserts this table against every :shopId route declared in server.js, so a
// new route added without an entry here fails the suite rather than shipping unguarded.
const SHOP_SCOPED_PATHS = [
  { methods: ["GET"], pattern: /^\/api\/customers\/credit-score\/([^/]+)(?:\/[^/]*)?$/i },
  { methods: ["GET"], pattern: /^\/api\/purchases\/latest-rate\/([^/]+)(?:\/[^/]+)?$/i },
  { methods: ["GET"], pattern: /^\/api\/inventory\/status\/([^/]+)$/i },
  { methods: ["GET"], pattern: /^\/api\/cash-sessions\/current\/([^/]+)$/i },
  { methods: ["GET"], pattern: /^\/api\/invoices\/(?:last-rate|history)\/([^/]+)$/i },
  { methods: ["GET"], pattern: /^\/api\/bae\/briefing\/([^/]+)$/i },
  { methods: ["GET"], pattern: /^\/api\/tax\/summary\/([^/]+)$/i },
  { methods: ["GET"], pattern: /^\/api\/reminders\/overdue\/([^/]+)$/i },
  { methods: ["GET"], pattern: /^\/api\/analytics\/projections\/([^/]+)$/i },
  { methods: ["GET", "PATCH", "POST"], pattern: /^\/api\/shops\/([^/]+)(?:\/staff(?:\/[^/]+)?|\/repair-shared-pricing)?$/i },
  { methods: ["DELETE"], pattern: /^\/api\/shops\/([^/]+)\/staff\/[^/]+$/i },
  { methods: ["GET", "PUT"], pattern: /^\/api\/customers\/([^/]+)(?:\/(?:credit-check|limit|limits|history))?$/i },
  { methods: ["GET"], pattern: /^\/api\/recurring-invoices\/([^/]+)$/i },
  { methods: ["GET", "PUT"], pattern: /^\/api\/suppliers\/([^/]+)$/i },
  { methods: ["GET"], pattern: /^\/api\/(?:debit-notes|decisions|alerts|bakaya|credit-score|expenses)\/([^/]+)$/i },
  { methods: ["GET"], pattern: /^\/api\/cash-sessions\/([^/]+)$/i },
  { methods: ["POST"], pattern: /^\/api\/export\/([^/]+)(?:\/(?:csv|tally))?$/i },
  { methods: ["GET"], pattern: /^\/api\/bank-transactions\/([^/]+)(?:\/suggestions)?$/i },
  { methods: ["GET"], pattern: /^\/api\/credit-notes\/([^/]+)(?:\/[^/]+)?$/i },
];

function shopIdFromPath(method, path) {
  const clean = normalisePath(path);
  for (const entry of SHOP_SCOPED_PATHS) {
    if (!entry.methods.includes(method)) continue;
    const m = clean.match(entry.pattern);
    if (m) return m[1];
  }
  return null;
}

// A request may name its shop in the path, the body or the query string depending on the
// route. All three are equally untrusted, so all three are read and compared against the
// session. Conflicting values are treated as a mismatch rather than picking a winner.
function shopIdsInRequest(req) {
  const found = [
    shopIdFromPath(req.method, req.path),
    req.body && req.body.shopId,
    req.query && req.query.shopId,
  ];
  return [...new Set(found.filter((v) => typeof v === "string" && v.length > 0))];
}

function readBearerToken(req) {
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// A missing JWT_SECRET must not take the API down, and must not fall back to a fixed
// string either — a predictable secret lets anyone mint a session for any shop, which is
// worse than the hole this module closes. A random per-process secret keeps the server
// safe and merely costs users a re-login whenever the process restarts, which is the
// visible nudge to set the variable.
function resolveSecret(env = process.env, warn = console.warn) {
  const configured = env.JWT_SECRET;
  if (configured && configured.length >= 32) return { secret: configured, ephemeral: false };
  if (configured) {
    warn("SECURITY: JWT_SECRET is shorter than 32 characters — ignoring it and using a random per-process secret. Set a long random value.");
  } else {
    warn("SECURITY: JWT_SECRET is not set — sessions are signed with a random per-process secret and will not survive a restart. Set JWT_SECRET on the host.");
  }
  return { secret: crypto.randomBytes(48).toString("hex"), ephemeral: true };
}

function signSession({ shopId, staffId = null, permissions = null }, secret) {
  if (!shopId) throw new Error("signSession requires a shopId");
  return jwt.sign({ shopId, staffId, permissions }, secret, { expiresIn: TOKEN_TTL_SECONDS });
}

function verifySession(token, secret) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret);
    return payload && payload.shopId ? payload : null;
  } catch (e) {
    return null; // expired, tampered, or signed with a secret from a previous process
  }
}

// enforce=false runs the whole check and reports what it would have rejected without
// rejecting it. Turning auth on for every client at the same instant would lock out any
// app build already in users' hands, so the flag exists to let the new build ship first
// and the enforcement follow once the fleet has caught up.
function makeAuthMiddleware({ supabase, secret, enforce = true, log = console.warn }) {
  return async function authMiddleware(req, res, next) {
    if (isPublicRoute(req.method, req.path)) return next();

    const deny = (status, error) => {
      if (enforce) return res.status(status).json({ error });
      log(`AUTH (report-only, would have blocked): ${req.method} ${req.path} — ${error}`);
      return next();
    };

    const payload = verifySession(readBearerToken(req), secret);
    if (!payload) return deny(401, "Login karein — session expired ya missing hai");
    req.auth = payload;

    const named = shopIdsInRequest(req);
    if (named.some((id) => id !== payload.shopId)) {
      return deny(403, "Ye shop aapki nahi hai");
    }

    const needed = permissionFor(req.method, req.path);
    if (needed && payload.staffId) {
      // Read the permission from the database rather than the token. Permissions are
      // stamped into the session at login and the session lasts 30 days, so trusting the
      // token would keep a revoked permission working for a month, and a deactivated staff
      // member would keep full access until their session expired.
      let staff = null;
      try {
        const { data } = await supabase
          .from("shop_staff")
          .select("active, can_edit_price, can_delete, can_manage_staff")
          .eq("id", payload.staffId)
          .eq("shop_id", payload.shopId)
          .maybeSingle();
        staff = data;
      } catch (e) {
        return deny(503, "Permission check nahi ho paaya, dobara try karein");
      }
      const granted = staff && staff.active && {
        canEditPrice: staff.can_edit_price,
        canDelete: staff.can_delete,
        canManageStaff: staff.can_manage_staff,
      }[needed];
      if (!granted) return deny(403, "Iske liye aapko permission nahi hai");
    }

    const scope = resourceScopeFor(req.method, req.path);
    if (scope) {
      let row = null;
      try {
        const { data } = await supabase
          .from(scope.table)
          .select("shop_id")
          .eq(scope.column, scope.id)
          .eq("shop_id", payload.shopId)
          .maybeSingle();
        row = data;
      } catch (e) {
        // Fail closed when enforcing: a lookup that errored proves nothing about
        // ownership. In report-only mode this still has to go through deny(), or a
        // database hiccup would start blocking requests that the old build handled fine —
        // the one thing report-only exists to prevent.
        return deny(503, "Ownership check nahi ho paaya, dobara try karein");
      }
      // Absent and not-yours are answered identically on purpose: a distinct "exists but
      // belongs to someone else" reply would let a caller probe for valid record ids.
      if (!row) return deny(404, "Record nahi mila");
    }

    next();
  };
}

module.exports = {
  TOKEN_TTL_SECONDS,
  PUBLIC_ROUTES,
  RESOURCE_SCOPES,
  isPublicRoute,
  normalisePath,
  resourceScopeFor,
  permissionFor,
  PERMISSION_SCOPES,
  shopIdFromPath,
  SHOP_SCOPED_PATHS,
  shopIdsInRequest,
  readBearerToken,
  resolveSecret,
  signSession,
  verifySession,
  makeAuthMiddleware,
};
