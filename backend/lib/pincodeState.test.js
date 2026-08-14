"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { stateFromPincode } = require("./pincodeState");

test("a delivery pincode resolves to its state and GST code", () => {
  assert.deepEqual(stateFromPincode("841226"), { state: "Bihar", stateCode: "10" });        // Siwan
  assert.deepEqual(stateFromPincode("560001"), { state: "Karnataka", stateCode: "29" });    // Bengaluru
  assert.deepEqual(stateFromPincode("110001"), { state: "Delhi", stateCode: "07" });
  assert.deepEqual(stateFromPincode("400001"), { state: "Maharashtra", stateCode: "27" });  // Mumbai
  assert.deepEqual(stateFromPincode("700001"), { state: "West Bengal", stateCode: "19" });  // Kolkata
});

test("a three-digit block wins over the two-digit range it sits inside", () => {
  // Uttarakhand inside Uttar Pradesh's range; Goa inside Maharashtra's; Chhattisgarh
  // inside Madhya Pradesh's. Getting these from the two-digit table would name the wrong
  // state on a tax invoice.
  assert.deepEqual(stateFromPincode("248001"), { state: "Uttarakhand", stateCode: "05" });  // Dehradun
  assert.deepEqual(stateFromPincode("403001"), { state: "Goa", stateCode: "30" });          // Panaji
  assert.deepEqual(stateFromPincode("492001"), { state: "Chhattisgarh", stateCode: "22" }); // Raipur
  assert.deepEqual(stateFromPincode("160017"), { state: "Chandigarh", stateCode: "04" });
  assert.deepEqual(stateFromPincode("226001"), { state: "Uttar Pradesh", stateCode: "09" });// Lucknow
});

test("the north-east block is split correctly", () => {
  assert.equal(stateFromPincode("793001").state, "Meghalaya");
  assert.equal(stateFromPincode("795001").state, "Manipur");
  assert.equal(stateFromPincode("799001").state, "Tripura");
  assert.equal(stateFromPincode("781001").state, "Assam");
});

test("a range that genuinely straddles a boundary returns nothing", () => {
  // Andhra Pradesh and Telangana were one state until 2014 and their 51–53 pincodes
  // interleave. A guess here would put the wrong state on a legal document; the caller
  // keeps its existing behaviour instead.
  assert.equal(stateFromPincode("515001"), null);
  assert.equal(stateFromPincode("520001"), null);
  assert.equal(stateFromPincode("533001"), null);
});

test("malformed input returns nothing rather than a guess", () => {
  for (const bad of ["", null, undefined, "8412", "84122X", "1234567", "abcdef"]) {
    assert.equal(stateFromPincode(bad), null, `${bad} should not resolve`);
  }
});

test("a pincode is read however it was typed", () => {
  assert.deepEqual(stateFromPincode(" 841226 "), { state: "Bihar", stateCode: "10" });
  assert.deepEqual(stateFromPincode("841-226"), { state: "Bihar", stateCode: "10" });
  assert.deepEqual(stateFromPincode(841226), { state: "Bihar", stateCode: "10" });
});

test("a field post office has no GST state, so it resolves to nothing", () => {
  assert.equal(stateFromPincode("900001"), null);
});
