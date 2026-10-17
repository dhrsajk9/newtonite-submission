-- 004_overdue_index.sql
-- Supports the dashboard's "Overdue" queue: active items past their due date.
-- A partial index only contains active rows, so it stays small as closed work piles up.
CREATE INDEX work_items_active_due_idx ON work_items (team_id, due_at)
  WHERE status IN ('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL') AND due_at IS NOT NULL;
