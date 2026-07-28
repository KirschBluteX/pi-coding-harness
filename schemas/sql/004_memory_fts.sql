PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  version UNINDEXED,
  workspace_id UNINDEXED,
  goal_id UNINDEXED,
  kind UNINDEXED,
  tags,
  cjk_ngrams,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

COMMIT;
