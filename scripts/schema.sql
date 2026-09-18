CREATE TABLE IF NOT EXISTS coding_tasks (
 id varchar(16) PRIMARY KEY, sender text NOT NULL, instruction text NOT NULL,
 status text NOT NULL CHECK (status IN ('queued','running','awaiting_preview','ready','approved','merged','rejected','failed')),
 branch text NOT NULL UNIQUE, base_branch text, base_sha text, head_sha text,
 pr_number integer, pr_url text, preview_url text, summary text, approved_sha text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS whatsapp_events (
 message_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
 id bigserial PRIMARY KEY, event_key text NOT NULL UNIQUE, sender text NOT NULL,
 body text NOT NULL, attempts integer NOT NULL DEFAULT 0, delivered_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coding_tasks_queue ON coding_tasks(status, updated_at);
CREATE INDEX IF NOT EXISTS whatsapp_outbox_pending ON whatsapp_outbox(next_attempt_at) WHERE delivered_at IS NULL;
