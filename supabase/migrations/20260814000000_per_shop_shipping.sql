-- Courier configuration per shop, instead of one for the whole platform.
--
-- SHIPPING_PROVIDER was a single environment variable, so every shop on the platform would
-- have booked through one courier account: one set of credentials, one pickup address, one
-- bill. A shop's courier account is its own commercial relationship — its rates, its
-- pickup, its liability — and it cannot be shared any more than its bank account can.
--
-- shipping_config holds whatever the chosen adapter needs (an API token, a pickup location
-- id). It is a credential store, so it is never returned by the shop routes; only the
-- shipping code reads it.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS shipping_provider VARCHAR(40);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS shipping_config JSONB DEFAULT '{}'::jsonb;

-- No default provider on purpose. A shop with nothing set falls through to the mock, which
-- announces itself loudly, rather than silently booking against somebody else's account.
