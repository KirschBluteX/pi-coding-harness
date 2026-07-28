PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_claims_fts USING fts5(
  claim_id UNINDEXED,
  version UNINDEXED,
  workspace_id UNINDEXED,
  scope_goal_id UNINDEXED,
  channel UNINDEXED,
  tags,
  cjk_ngrams,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

COMMIT;
