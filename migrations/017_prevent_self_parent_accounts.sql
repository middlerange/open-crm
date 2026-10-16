UPDATE accounts SET parent_account_id = NULL WHERE parent_account_id = id;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_parent_not_self_check
  CHECK (parent_account_id IS NULL OR parent_account_id <> id);
