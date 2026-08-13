"use strict";

// Booking a courier, without committing to a courier.
//
// Which carrier a shop uses is a commercial decision that changes — a better rate appears,
// a pincode stops being serviceable, an account takes weeks to approve. None of that should
// reach the order routes, so everything carrier-specific lives behind one small interface
// and the rest of the system only ever sees an AWB, a label and a tracking URL.
//
// An adapter implements:
//   name                              — stored on the order, so old shipments stay readable
//                                       after the shop switches carrier
//   isConfigured()                    — whether credentials are present
//   createShipment(order)             — book it; resolve { shipmentRef, awb, labelUrl, trackingUrl }
//   track(order)                      — current state; resolve { status, trackingUrl }
//
// `status` from track() is one of the order statuses below, or null when the carrier says
// nothing useful yet. Adapters translate carrier vocabulary; callers never see it.

const ORDER_STATUSES = ["paid", "packed", "shipped", "delivered", "cancelled"];

// Which moves are legal. A packed order can ship; a delivered one is finished. Without this
// a mistyped request could walk an order backwards and lose the fact that it already went
// out, and a second courier booking on an already-shipped order would orphan the first AWB.
const ALLOWED_TRANSITIONS = {
  paid: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

function canTransition(from, to) {
  if (!ORDER_STATUSES.includes(to)) return false;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

// An address a carrier will actually accept. Pincode is the field that decides both
// serviceability and price, so a missing or malformed one is caught here rather than as an
// opaque rejection from the carrier after the shopkeeper has already tapped Book.
function validateAddress(order) {
  const problems = [];
  if (!order) return ["Order nahi mila"];
  if (!String(order.customer_name || "").trim()) problems.push("Customer ka naam nahi hai");
  if (!/^\d{10}$/.test(String(order.customer_phone || "").replace(/\D/g, "").slice(-10))) {
    problems.push("10 digit phone number chahiye");
  }
  if (!String(order.address_line || "").trim()) problems.push("Address nahi hai");
  if (!/^\d{6}$/.test(String(order.pincode || "").trim())) problems.push("6 digit pincode chahiye");
  return problems;
}

// A stand-in carrier, used until a real account exists and in tests.
//
// It is deliberately not a silent no-op: it returns a clearly fake AWB and a label URL that
// announces itself. A mock that looked real would let a shop believe parcels were booked
// when nothing had been handed to anyone.
const mockAdapter = {
  name: "mock",
  isConfigured: () => true,
  async createShipment(order) {
    const problems = validateAddress(order);
    if (problems.length) {
      throw Object.assign(new Error(problems.join(", ")), { status: 400 });
    }
    const awb = `MOCK${String(order.external_ref || order.id || "").replace(/\W/g, "").slice(-10).toUpperCase()}`;
    return {
      shipmentRef: `mock_${awb}`,
      awb,
      labelUrl: null,
      trackingUrl: null,
      mock: true,
    };
  },
  async track(order) {
    return { status: null, trackingUrl: null, mock: true };
  },
};

const adapters = new Map([["mock", mockAdapter]]);

function registerAdapter(adapter) {
  if (!adapter || !adapter.name) throw new Error("adapter needs a name");
  adapters.set(adapter.name, adapter);
  return adapter;
}

// Which carrier to use. SHIPPING_PROVIDER names it; unset means the mock, so a fresh
// deployment books nothing real by accident. An adapter that is named but missing its
// credentials is an error rather than a silent fall back to the mock — falling back would
// hand the shop a fake AWB while it believed it had a real one.
function getAdapter(env = process.env) {
  const wanted = (env.SHIPPING_PROVIDER || "mock").trim();
  const adapter = adapters.get(wanted);
  if (!adapter) {
    throw Object.assign(new Error(`Unknown SHIPPING_PROVIDER "${wanted}"`), { status: 503 });
  }
  if (!adapter.isConfigured(env)) {
    throw Object.assign(
      new Error(`${adapter.name} ke credentials set nahi hain`),
      { status: 503 }
    );
  }
  return adapter;
}

module.exports = {
  ORDER_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  validateAddress,
  mockAdapter,
  registerAdapter,
  getAdapter,
};
