-- Custom SQL migration file, put your code below! --
-- Step 28a.6 (the user's choice, 2026-11-23): the tracking page shows a parcel's steps in the
-- order they happened. Two steps often share one courier second (Steadfast's times have no
-- fraction, and 28a.3 clamps a time from before the booking to the booking's moment), so the
-- tracking page breaks the tie by when the step reached us, as the ERP's order page does. 0078 gave
-- omnivo_shop only the columns the page showed then; it needs received_at too, to sort by it.
-- A time, not a secret: it says when the courier's news arrived, nothing about the shopper.
GRANT SELECT (received_at) ON storefront_shipment_events TO omnivo_shop;
