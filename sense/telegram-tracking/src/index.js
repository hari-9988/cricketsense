
const ALLOWED_ORIGIN = "https://cricketsense.site";

function corsHeaders(origin) {
return {
"Access-Control-Allow-Origin":
origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type",
"Vary": "Origin"
};
}

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
return new Response(JSON.stringify(data), {
status,
headers: {
...corsHeaders(origin),
"Content-Type": "application/json"
}
});
}

async function telegram(method, env, params = {}) {
const response = await fetch(
`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
{
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(params)
}
);

const result = await response.json();

if (!response.ok || !result.ok) {
throw new Error(result.description || "Telegram API error");
}

return result.result;
}

async function createInvite(request, env) {
const body = await request.json();

const id = crypto.randomUUID();
const now = Math.floor(Date.now() / 1000);

const invite = await telegram("createChatInviteLink", env, {
chat_id: env.TELEGRAM_CHAT_ID,
name: `sense-${id.slice(0, 8)}`,
expire_date: now + 86400,
creates_join_request: true
});

const inviteLink = invite.invite_link;

await env.DB.prepare(`
INSERT INTO clicks (
id,
invite_link,
fbclid,
fbp,
fbc,
client_ip,
user_agent,
created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).bind(
id,
inviteLink,
body.fbclid || null,
body.fbp || null,
body.fbc || null,
request.headers.get("CF-Connecting-IP"),
request.headers.get("User-Agent"),
now
).run();

return json({
success: true,
invite_link: inviteLink
});
}

async function handleTelegramWebhook(request, env, ctx) {
const secret = request.headers.get(
"X-Telegram-Bot-Api-Secret-Token"
);

if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
return new Response("Unauthorized", { status: 401 });
}

const update = await request.json();
const join = update.chat_join_request;

if (!join) {
return json({ ok: true });
}

if (String(join.chat.id) !== String(env.TELEGRAM_CHAT_ID)) {
return json({ ok: true });
}

const inviteLink = join.invite_link?.invite_link;

if (!inviteLink) {
return json({ ok: true });
}

const click = await env.DB.prepare(`
SELECT *
FROM clicks
WHERE invite_link = ?
LIMIT 1
`).bind(inviteLink).first();

const eventId = crypto.randomUUID();
const requestedAt = join.date;

const inserted = await env.DB.prepare(`
INSERT OR IGNORE INTO join_requests (
update_id,
invite_link,
click_id,
requested_at,
event_id
)
VALUES (?, ?, ?, ?, ?)
`).bind(
update.update_id,
inviteLink,
click?.id || null,
requestedAt,
eventId
).run();

if (!inserted.meta.changes) {
return json({ ok: true, duplicate: true });
}

if (click) {
const userData = {};

if (click.fbp) userData.fbp = click.fbp;
if (click.fbc) userData.fbc = click.fbc;

if (click.client_ip) {
userData.client_ip_address = click.client_ip;
}

if (click.user_agent) {
userData.client_user_agent = click.user_agent;
}

const payload = {
data: [{
event_name: "Lead",
event_time: requestedAt,
event_id: eventId,
action_source: "website",
event_source_url: env.LANDING_PAGE_URL,
user_data: userData
}]
test_event_code:"TEST27752"
};

await env.DB.prepare(`
INSERT OR IGNORE INTO meta_outbox (
event_id,
payload_json,
attempts,
next_attempt_at,
delivered_at
)
VALUES (?, ?, 0, ?, NULL)
`).bind(
eventId,
JSON.stringify(payload),
Math.floor(Date.now() / 1000)
).run();

ctx.waitUntil(flushOutbox(env));
}

return json({ ok: true });
}

async function flushOutbox(env) {
const now = Math.floor(Date.now() / 1000);

const pending = await env.DB.prepare(`
SELECT event_id, payload_json, attempts
FROM meta_outbox
WHERE delivered_at IS NULL
AND next_attempt_at <= ?
ORDER BY next_attempt_at ASC
LIMIT 20
`).bind(now).all();

for (const item of pending.results) {
try {
const response = await fetch(
`https://graph.facebook.com/${env.META_API_VERSION}/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
{
method: "POST",
headers: { "Content-Type": "application/json" },
body: item.payload_json
}
);

const result = await response.json();

if (!response.ok || result.error) {
throw new Error("Meta API delivery failed");
}

await env.DB.prepare(`
UPDATE meta_outbox
SET delivered_at = ?
WHERE event_id = ?
`).bind(now, item.event_id).run();

} catch (error) {
const attempts = item.attempts + 1;
const delay = Math.min(3600, 30 * Math.pow(2, attempts));

await env.DB.prepare(`
UPDATE meta_outbox
SET attempts = ?,
next_attempt_at = ?
WHERE event_id = ?
`).bind(
attempts,
now + delay,
item.event_id
).run();
}
}
}

export default {
async fetch(request, env, ctx) {
const url = new URL(request.url);
const origin = request.headers.get("Origin") || "";

if (request.method === "OPTIONS") {
return new Response(null, {
status: 204,
headers: corsHeaders(origin)
});
}

try {
if (url.pathname === "/health" && request.method === "GET") {
return json({ status: "ok" }, 200, origin);
}

if (url.pathname === "/create-invite" && request.method === "POST") {
if (origin !== ALLOWED_ORIGIN) {
return json({ error: "Forbidden origin" }, 403, origin);
}

return await createInvite(request, env);
}

if (
url.pathname === "/telegram-webhook" &&
request.method === "POST"
) {
return await handleTelegramWebhook(request, env, ctx);
}

return json({ error: "Not found" }, 404, origin);

} catch (error) {
console.error("Worker error:", error.message);
return json({ error: "Internal server error" }, 500, origin);
}
},

async scheduled(event, env, ctx) {
ctx.waitUntil(flushOutbox(env));
}
};
