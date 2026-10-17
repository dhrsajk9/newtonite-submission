-- 003_open_items_unassigned.sql
--
-- Rule: OPEN means "nobody has taken this yet". As soon as someone owns an item
-- (by claiming it or being assigned) it moves to IN_PROGRESS.
-- This keeps "is this available to claim?" a single, unambiguous check.

-- Fix any existing rows first, so this migration is safe on a database that
-- already holds data.
UPDATE work_items SET assignee_id = NULL WHERE status = 'OPEN' AND assignee_id IS NOT NULL;

ALTER TABLE work_items
  ADD CONSTRAINT open_items_are_unassigned CHECK (status <> 'OPEN' OR assignee_id IS NULL);
