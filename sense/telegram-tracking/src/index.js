const ALLOWED_ORIGIN = "https://cricketsense.site";

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  });
}

async function telegram(method, env, params = {}) {
  const response = await fetch(
    'https://api.telegram.org/bot${env.BOT_TOKEN}/${method}',
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error("Telegram API request failed");
  }

  return result.result;
}

async function createInvite(request, env) {
  const body = await request.json();

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Create a unique private-channel join-request link
  const invite = await telegram("createChatInviteLink", env, {
    chat_id: env.TELEGRAM_CHAT_ID,
    name: "CS_" + id.slice(0, 20),
    expire_date: now + 86400,
    creates_join_request: true
  });

  await env.DB.prepare(`
    INSERT INTO clicks (
      id, invite_link, fbclid, fbp, fbc,
      client_ip, user_agent, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    invite.invite_link,
    body.fbclid || null,
    body.fbp || null,
    body.fbc || null,
    request.headers.get("CF-Connecting-IP"),
    request.headers.get("User-Agent"),
    now
  ).run();

  return json({
    success: true,
    invite_link: invite.invite_link
  });
}

async function handleTelegramWebhook(request, env, ctx) {
  const secret = request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token"
  );

  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const update = await request.json();

  const join = update.chat_join_request;

  if (!join) {
    return json({ ok: true });
  }

  // Only process the configured private channel
  if (String(join.chat.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return json({ ok: true });
  }

  const updateId = update.update_id;
  const inviteLink = join.invite_link?.invite_link || null;
  const requestedAt = join.date;

  const eventId = "tg_join_" + updateId;

  // Find the original landing-page visitor
  const click = inviteLink
    ? await env.DB.prepare(`
        SELECT id, fbp, fbc, client_ip, user_agent
        FROM clicks
        WHERE invite_link = ?
      `).bind(inviteLink).first()
    : null;

  // Record each Telegram request only once
  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO join_requests (
      update_id, invite_link, click_id,
      requested_at, event_id
    )
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    updateId,
    inviteLink,
    click?.id || null,
    requestedAt,
    eventId
  ).run();

  if (!inserted.meta.changes) {
    return json({ ok: true, duplicate: true });
  }

  // Only attributed requests are sent to Meta
  if (click && (click.fbp  click.fbc 
      (click.client_ip && click.user_agent))) {

    const eventPayload = {
      data: [{
        event_name: "Lead",
        event_time: requestedAt,
        event_id: eventId,
        action_source: "website",
        event_source_url: env.LANDING_PAGE_URL,
        user_data: {
          ...(click.fbp ? { fbp: click.fbp } : {}),
          ...(click.fbc ? { fbc: click.fbc } : {}),
          ...(click.client_ip
            ? { client_ip_address: click.client_ip } : {}),
          ...(click.user_agent
            ? { client_user_agent: click.user_agent } : {})
        },
        custom_data: {
          content_name: "Telegram Join Request",
          content_category: "Cricket Channel"
        }
      }]
    };

    // Store event before sending, so failures can be retried
    await env.DB.prepare(`
      INSERT OR IGNORE INTO meta_outbox (
