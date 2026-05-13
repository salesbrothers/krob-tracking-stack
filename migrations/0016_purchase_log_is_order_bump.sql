-- Add explicit is_order_bump flag to purchase_log.
-- Previously OB detection relied on trk = '', which conflates actual order bumps
-- with main products that have no attribution (empty checkout_source).
ALTER TABLE purchase_log ADD COLUMN is_order_bump INTEGER NOT NULL DEFAULT 0;
