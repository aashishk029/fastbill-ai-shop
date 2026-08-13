"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canTransition,
  validateAddress,
  mockAdapter,
  registerAdapter,
  getAdapter,
} = require("./shipping");

const good = {
  id: "o1",
  external_ref: "pay_ABC123XYZ",
  customer_name: "Sima Devi",
  customer_phone: "9415911915",
  address_line: "Mahpur Road, nr Mira Hotel",
  city: "Siwan",
  pincode: "841226",
};

// --- the lifecycle -----------------------------------------------------------------------

test("an order walks forward through its states", () => {
  assert.equal(canTransition("paid", "packed"), true);
  assert.equal(canTransition("packed", "shipped"), true);
  assert.equal(canTransition("shipped", "delivered"), true);
});

test("an order cannot walk backwards", () => {
  // Losing the fact that something already went out is worse than refusing the request.
  assert.equal(canTransition("shipped", "packed"), false);
  assert.equal(canTransition("delivered", "shipped"), false);
  assert.equal(canTransition("packed", "paid"), false);
});

test("a finished order is finished", () => {
  assert.equal(canTransition("delivered", "cancelled"), false);
  assert.equal(canTransition("cancelled", "packed"), false);
});

test("anything still in flight can be cancelled", () => {
  assert.equal(canTransition("paid", "cancelled"), true);
  assert.equal(canTransition("packed", "cancelled"), true);
  assert.equal(canTransition("shipped", "cancelled"), true);
});

test("a status nobody defined is refused", () => {
  assert.equal(canTransition("paid", "despatched"), false);
  assert.equal(canTransition("paid", ""), false);
});

// --- the address a carrier will accept ---------------------------------------------------

test("a complete address passes", () => {
  assert.deepEqual(validateAddress(good), []);
});

test("a missing pincode is caught here, not by the carrier", () => {
  // Pincode decides serviceability and price; an opaque carrier rejection after the
  // shopkeeper has already tapped Book is a worse way to find out.
  assert.deepEqual(validateAddress({ ...good, pincode: "" }), ["6 digit pincode chahiye"]);
  assert.deepEqual(validateAddress({ ...good, pincode: "8412" }), ["6 digit pincode chahiye"]);
  assert.deepEqual(validateAddress({ ...good, pincode: "84122X" }), ["6 digit pincode chahiye"]);
});

test("a phone number is accepted however it was typed", () => {
  assert.deepEqual(validateAddress({ ...good, customer_phone: "+91 94159 11915" }), []);
  assert.deepEqual(validateAddress({ ...good, customer_phone: "094159-11915" }), []);
});

test("a phone number that is not one is refused", () => {
  assert.deepEqual(validateAddress({ ...good, customer_phone: "12345" }), ["10 digit phone number chahiye"]);
  assert.deepEqual(validateAddress({ ...good, customer_phone: null }), ["10 digit phone number chahiye"]);
});

test("every missing field is reported at once", () => {
  // Sending a shopkeeper back four times for four fields is its own failure.
  const problems = validateAddress({ id: "o1" });
  assert.equal(problems.length, 4);
});

// --- the mock carrier --------------------------------------------------------------------

test("the mock books a shipment and says so", async () => {
  const r = await mockAdapter.createShipment(good);
  assert.match(r.awb, /^MOCK/, "an AWB nobody could mistake for real");
  assert.equal(r.mock, true);
});

test("the mock refuses an address a real carrier would refuse", async () => {
  await assert.rejects(
    () => mockAdapter.createShipment({ ...good, pincode: "" }),
    (e) => e.status === 400 && /pincode/.test(e.message)
  );
});

// --- choosing the carrier ----------------------------------------------------------------

test("with nothing configured, the mock is what you get", () => {
  assert.equal(getAdapter({}).name, "mock");
});

test("a named carrier that is not installed is an error, not a fallback", () => {
  assert.throws(() => getAdapter({ SHIPPING_PROVIDER: "shiprocket" }), (e) => e.status === 503);
});

test("a carrier missing its credentials is an error, not a silent downgrade to mock", () => {
  // Falling back would hand the shop a fake AWB while it believed the parcel was booked.
  registerAdapter({
    name: "halfwired",
    isConfigured: (env) => !!(env && env.HALFWIRED_TOKEN),
    createShipment: async () => ({}),
    track: async () => ({}),
  });
  assert.throws(
    () => getAdapter({ SHIPPING_PROVIDER: "halfwired" }),
    (e) => e.status === 503 && /credentials/.test(e.message)
  );
  assert.equal(getAdapter({ SHIPPING_PROVIDER: "halfwired", HALFWIRED_TOKEN: "x" }).name, "halfwired");
});
