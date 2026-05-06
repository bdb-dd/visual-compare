-- LM prompts move from env config into the database. The constants file
-- remains the source of truth for "what does a fresh checkout do?" — it
-- seeds lm_prompt_defaults at startup. New sessions copy defaults into
-- lm_prompts so each session can be tuned without affecting others.
--
-- prompt_id is sha256(prompt_text), giving a stable cache key. Editing a
-- session's prompt naturally produces a cache miss for that session's
-- future LM verdicts; old cache rows under the old prompt_id stay valid
-- but go stale.

CREATE TABLE lm_prompt_defaults (
  invocation_reason TEXT PRIMARY KEY,
  prompt_text       TEXT NOT NULL,
  prompt_id         TEXT NOT NULL,
  source            TEXT NOT NULL CHECK(source IN ('seed', 'override')),
  updated_at        TEXT NOT NULL
);

CREATE TABLE lm_prompts (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  invocation_reason TEXT NOT NULL,
  prompt_text       TEXT NOT NULL,
  prompt_id         TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, invocation_reason)
);

CREATE INDEX idx_lm_prompts_session ON lm_prompts(session_id);
