-- Custom SQL migration file, put your code below! --
-- 1) The six new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines', 'deliveries',
      'delivery_lines'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- 2) The shipping address of an order and of a delivery is an address of THAT customer:
--    customer_id is in the key, so the address of another customer cannot be named. When the
--    customer's form removes the address later, only shipping_address_id becomes NULL: the text on
--    the document stays. A plain ON DELETE SET NULL would also clear customer_id (NOT NULL, so the
--    customer's save would fail). The column list needs Postgres 15 or later, and Drizzle cannot
--    write it, so these two foreign keys live here and not in the schema.
ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_shipping_address_fk
  FOREIGN KEY (tenant_id, customer_id, shipping_address_id)
  REFERENCES party_addresses (tenant_id, party_id, id)
  ON DELETE SET NULL (shipping_address_id);

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_shipping_address_fk
  FOREIGN KEY (tenant_id, customer_id, shipping_address_id)
  REFERENCES party_addresses (tenant_id, party_id, id)
  ON DELETE SET NULL (shipping_address_id);

-- 3) A quotation can be changed or deleted only while it is open. An answered one (accepted or
--    declined) keeps what it offered; only its status may move back to open (a declined one
--    reopened, or an accepted one whose draft order was deleted). The row is compared as JSON
--    without the columns that may change, so a column added later is frozen too, without
--    anyone remembering to list it here.
CREATE FUNCTION quotations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'open' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IN ('open', OLD.status)
     AND to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by']
         = to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'quotation % was answered and cannot be changed or deleted', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'quotations_answered_immutable';
END $$;

CREATE TRIGGER quotations_guard
  BEFORE UPDATE OR DELETE ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotations_guard();

-- The lines: only while the quotation is open. When an open quotation is deleted its lines go by
-- ON DELETE CASCADE; the header is gone by then, so the lookup finds nothing and lets them go.
CREATE FUNCTION quotation_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM quotations
         WHERE tenant_id = OLD.tenant_id AND id = OLD.quotation_id AND status <> 'open'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM quotations
         WHERE tenant_id = NEW.tenant_id AND id = NEW.quotation_id AND status <> 'open')) THEN
    RAISE EXCEPTION 'the lines of an answered quotation cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_lines_answered_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER quotation_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION quotation_lines_guard();

-- 4) A sales order goes draft → confirmed → delivered, closed or cancelled, and a confirmed one may
--    go back to draft. Nothing else:
--    - a draft is changed freely; it is deleted only while it has no number (once confirmed, the
--      customer may have its number: it is cancelled instead, so SO numbers have no gaps);
--    - a confirmed order keeps what was agreed. Only its status moves (confirmed_at and
--      confirmed_by go with it: a reopen clears them);
--    - delivered, closed and cancelled are final.
--    In every state the shipping address id may become NULL, when the customer's address is
--    removed (section 2's ON DELETE SET NULL).
CREATE FUNCTION sales_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.number IS NOT NULL THEN
      RAISE EXCEPTION 'sales order % has a number and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_orders_numbered_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'confirmed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmed'
     AND to_jsonb(NEW) - ARRAY['status', 'confirmed_at', 'confirmed_by', 'shipping_address_id',
                               'version', 'updated_at', 'updated_by']
         = to_jsonb(OLD) - ARRAY['status', 'confirmed_at', 'confirmed_by', 'shipping_address_id',
                                 'version', 'updated_at', 'updated_by'] THEN
    RETURN NEW;
  END IF;
  IF NEW.shipping_address_id IS NULL
     AND to_jsonb(NEW) - 'shipping_address_id' = to_jsonb(OLD) - 'shipping_address_id' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sales order % is % and cannot be changed this way', OLD.id, OLD.status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_orders_confirmed_immutable';
END $$;

CREATE TRIGGER sales_orders_guard
  BEFORE UPDATE OR DELETE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION sales_orders_guard();

-- The lines: free while the order is a draft. While it is confirmed, a line may only have its
-- delivered_quantity changed (by a delivery's posting), with nothing else. Once delivered, closed
-- or cancelled: frozen. When a draft is deleted, its lines cascade as above.
CREATE FUNCTION sales_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status
      FROM sales_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
    -- NULL: no such order — the foreign key gives that error
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines cannot be added to a sales order that is not a draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM sales_orders WHERE tenant_id = OLD.tenant_id AND id = OLD.order_id;
  IF v_status IS NULL OR v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF v_status = 'confirmed' AND TG_OP = 'UPDATE'
     AND to_jsonb(NEW) - 'delivered_quantity' = to_jsonb(OLD) - 'delivered_quantity' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a confirmed sales order cannot be changed, except what was delivered'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
END $$;

CREATE TRIGGER sales_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION sales_order_lines_guard();

-- 5) A posted delivery and its lines never change, like a posted stock adjustment (0022): what
--    left the warehouse left. The one change allowed is section 2's: its shipping address id
--    becomes NULL when the customer's address is removed (the text on the challan stays).
CREATE FUNCTION deliveries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted'
     AND NOT (TG_OP = 'UPDATE' AND NEW.shipping_address_id IS NULL
              AND to_jsonb(NEW) - 'shipping_address_id' = to_jsonb(OLD) - 'shipping_address_id') THEN
    RAISE EXCEPTION 'delivery % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deliveries_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER deliveries_guard
  BEFORE UPDATE OR DELETE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION deliveries_guard();

CREATE FUNCTION delivery_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM deliveries
         WHERE tenant_id = OLD.tenant_id AND id = OLD.delivery_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM deliveries
         WHERE tenant_id = NEW.tenant_id AND id = NEW.delivery_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted delivery cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'delivery_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON delivery_lines
  FOR EACH ROW EXECUTE FUNCTION delivery_lines_guard();
