CREATE TABLE IF NOT EXISTS clicks (
    id TEXT PRIMARY KEY,
    invite_link TEXT UNIQUE NOT NULL,
    fbclid TEXT,
    fbp TEXT,
    fbc TEXT,
    client_ip TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS join_requests (
    update_id INTEGER PRIMARY KEY,
    invite_link TEXT,
    click_id TEXT,
    requested_at INTEGER NOT NULL,
    event_id TEXT UNIQUE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clicks_invite
ON clicks(invite_link);

CREATE INDEX IF NOT EXISTS idx_requests_click
ON join_requests(click_id);

CREATE TABLE IF NOT EXISTS meta_outbox (
    event_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    delivered_at INTEGER
);
