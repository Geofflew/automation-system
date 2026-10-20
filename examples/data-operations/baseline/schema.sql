-- What the app's tables are meant to look like. Re-runnable: CREATE TABLE IF NOT EXISTS, then
-- every column added since the table first shipped as ADD COLUMN IF NOT EXISTS. On an empty
-- schema this builds everything. On a schema a copy tool already made, every statement that
-- names an existing table or column is skipped, constraints and defaults included (part 3).
CREATE TABLE IF NOT EXISTS work_orders (
  id int PRIMARY KEY,
  title text NOT NULL
);
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS revision int NOT NULL DEFAULT 0;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'open';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS opened_on date NOT NULL DEFAULT DATE '2026-03-02';

CREATE TABLE IF NOT EXISTS usage_events (
  id int PRIMARY KEY,
  kind text NOT NULL
);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS batch text NOT NULL DEFAULT 'single';

-- Every update bumps the revision, so a writer can say "only if nobody changed it since I read it".
CREATE OR REPLACE FUNCTION bump_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER work_orders_bump BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION bump_revision();
