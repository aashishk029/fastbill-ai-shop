-- A webhook secret per shop, instead of one shared by all of them.
--
-- The online-order webhook authenticated with a single ONLINE_ORDER_SECRET and then took
-- shopId from the request body. With one shop that is fine. With two it is a cross-tenant
-- hole: every shop's website necessarily holds the same secret, so any of them could post
-- an order into any other shop's inventory just by naming a different shopId — draining
-- stock and raising invoices in a shop it has nothing to do with.
--
-- Giving each shop its own secret makes the secret prove which shop is calling, rather than
-- only proving the caller is one of ours.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(128);

-- Give every existing shop one now. Generating here rather than asking each owner to press
-- a button means no shop is left on the shared secret by forgetting, which is the state
-- this migration exists to end.
UPDATE shops
   SET webhook_secret = encode(gen_random_bytes(32), 'hex')
 WHERE webhook_secret IS NULL;

-- Copy the value for any shop that posts online orders into that site's environment as
-- FASTBILL_WEBHOOK_SECRET, then the shared ONLINE_ORDER_SECRET can be removed from the
-- backend host entirely.
SELECT id, name, webhook_secret FROM shops ORDER BY created_at;
