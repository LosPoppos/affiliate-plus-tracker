const API = 'https://api.twitch.tv/helix';
const OAUTH = 'https://id.twitch.tv/oauth2';

const DEFAULT_TITLE = 'AFFILIATE PLUS erreichen!';
const DEFAULT_LABEL = 'Neue Abo-Punkte';
const DEFAULT_TARGET = 100;

function nowSec() { return Math.floor(Date.now() / 1000); }

function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers}
  });
}

function htmlRedirect(url) {
  return new Response(null, {status:302, headers:{Location:url}});
}

function randomString(bytes=24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2,'0')).join('');
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const match = raw.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function monthKeyFromDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth()+1).padStart(2,'0');
  return `${y}-${m}`;
}

function monthKeyNow() {
  return monthKeyFromDate(new Date());
}

function tierPoints(tier) {
  return ({'1000':1,'2000':2,'3000':6})[String(tier)] || 0;
}

function safeText(value, fallback, max) {
  const v = String(value ?? '').trim();
  return v ? v.slice(0,max) : fallback;
}

function safeInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function safeImageUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.toString().slice(0, 1000);
  } catch { return ''; }
}

async function encryptText(env, plaintext) {
  const keyBytes = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv,0); out.set(ct,iv.length);
  return btoa(String.fromCharCode(...out));
}

async function decryptText(env, encoded) {
  const raw = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const keyBytes = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const iv = raw.slice(0,12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, ct);
  return new TextDecoder().decode(pt);
}

async function twitchUser(env, accessToken) {
  const r = await fetch(`${API}/users`, {
    headers: {'Client-Id':env.TWITCH_CLIENT_ID, Authorization:`Bearer ${accessToken}`}
  });
  if (!r.ok) throw new Error('Twitch user lookup failed');
  const body = await r.json();
  return body.data?.[0] || null;
}

async function appAccessToken(env) {
  const cached = await env.DB.prepare(
    'SELECT value FROM app_tokens WHERE id = 1'
  ).first().catch(()=>null);

  if (cached) {
    try {
      const obj = JSON.parse(cached.value);
      if (obj.access_token && obj.expires_at > nowSec()+300) return obj.access_token;
    } catch {}
  }

  const url = new URL(`${OAUTH}/token`);
  url.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
  url.searchParams.set('client_secret', env.TWITCH_CLIENT_SECRET);
  url.searchParams.set('grant_type', 'client_credentials');

  const r = await fetch(url, {method:'POST'});
  if (!r.ok) throw new Error(`Twitch app token failed: ${r.status}`);
  const body = await r.json();
  const expiresAt = nowSec() + Number(body.expires_in || 0);
  const value = JSON.stringify({access_token:body.access_token, expires_at:expiresAt});
  // This table is created lazily so old installations can upgrade without a migration.
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS app_tokens (id INTEGER PRIMARY KEY, value TEXT NOT NULL)'
  ).run();
  await env.DB.prepare(
    'INSERT INTO app_tokens(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value'
  ).bind(value).run();
  return body.access_token;
}

async function refreshUserToken(env, channel) {
  const refreshToken = await decryptText(env, channel.refresh_token_enc);
  const url = new URL(`${OAUTH}/token`);
  url.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
  url.searchParams.set('client_secret', env.TWITCH_CLIENT_SECRET);
  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('refresh_token', refreshToken);

  const r = await fetch(url, {method:'POST'});
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const body = await r.json();
  const accessEnc = await encryptText(env, body.access_token);
  const refreshEnc = await encryptText(env, body.refresh_token || refreshToken);
  const expiresAt = nowSec() + Number(body.expires_in || 0);

  await env.DB.prepare(
    'UPDATE channels SET access_token_enc=?, refresh_token_enc=?, token_expires_at=?, needs_reauth=0, updated_at=? WHERE broadcaster_id=?'
  ).bind(accessEnc, refreshEnc, expiresAt, nowSec(), channel.broadcaster_id).run();

  return body.access_token;
}

async function getUserAccessToken(env, channel) {
  if (channel.token_expires_at > nowSec()+120) {
    return await decryptText(env, channel.access_token_enc);
  }
  return await refreshUserToken(env, channel);
}

async function getSessionChannel(request, env) {
  const sid = getCookie(request, 'pp_session');
  if (!sid) return null;
  const row = await env.DB.prepare(
    'SELECT s.*, c.* FROM sessions s JOIN channels c ON c.broadcaster_id=s.broadcaster_id WHERE s.session_id=? AND s.expires_at>?'
  ).bind(sid, nowSec()).first();
  return row || null;
}

async function createSession(env, broadcasterId) {
  const sid = randomString(24);
  const created = nowSec();
  await env.DB.prepare(
    'INSERT INTO sessions(session_id,broadcaster_id,created_at,expires_at) VALUES(?,?,?,?)'
  ).bind(sid,broadcasterId,created,created+86400*30).run();
  return sid;
}

async function cleanup(env) {
  const n = nowSec();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(n),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(n),
    env.DB.prepare('DELETE FROM seen_events WHERE created_at<?').bind(n-86400*60)
  ]);
}

async function ensureCurrentMonth(env, broadcasterId) {
  const mk = monthKeyNow();
  await env.DB.prepare(
    'INSERT INTO monthly_points(broadcaster_id,month_key,points,updated_at) VALUES(?,?,0,?) ON CONFLICT(broadcaster_id,month_key) DO NOTHING'
  ).bind(broadcasterId,mk,nowSec()).run();
}

async function getCurrentPoints(env, broadcasterId) {
  await ensureCurrentMonth(env,broadcasterId);
  const mk = monthKeyNow();
  const row = await env.DB.prepare(
    'SELECT points FROM monthly_points WHERE broadcaster_id=? AND month_key=?'
  ).bind(broadcasterId,mk).first();
  return Number(row?.points || 0);
}

async function addPoints(env, broadcasterId, amount, eventTimestamp) {
  if (!amount) return;
  const mk = monthKeyFromDate(new Date(eventTimestamp || Date.now()));
  await env.DB.prepare(
    'INSERT INTO monthly_points(broadcaster_id,month_key,points,updated_at) VALUES(?,?,?,?) ON CONFLICT(broadcaster_id,month_key) DO UPDATE SET points=points+excluded.points,updated_at=excluded.updated_at'
  ).bind(broadcasterId,mk,amount,nowSec()).run();
}

async function findChannelById(env, id) {
  return await env.DB.prepare('SELECT * FROM channels WHERE broadcaster_id=?').bind(id).first();
}

async function findChannelByPublicKey(env, key) {
  return await env.DB.prepare('SELECT * FROM channels WHERE public_key=?').bind(key).first();
}

async function createSubscription(env, broadcasterId, type, version='1') {
  const token = await appAccessToken(env);

  const condition = { broadcaster_user_id: broadcasterId };
  if (type === 'channel.chat.notification') {
    // channel.chat.notification requires both broadcaster_user_id and the
    // user_id whose chat identity reads the channel. We use the broadcaster
    // as the chat user; the OAuth flow grants the required chat scopes.
    condition.user_id = broadcasterId;
  }

  const body = {
    type,
    version,
    condition,
    transport: {
      method:'webhook',
      callback: `${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/webhook/twitch`,
      secret: env.EVENTSUB_SECRET
    }
  };

  const r = await fetch(`${API}/eventsub/subscriptions`, {
    method:'POST',
    headers:{
      'Client-Id':env.TWITCH_CLIENT_ID,
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body)
  });

  const txt = await r.text();
  if (r.status === 409) {
    // Twitch returns 409 when an identical type+condition already exists.
    // This is a normal/idempotent state for reconnecting the same broadcaster.
    let body = {};
    try { body = JSON.parse(txt); } catch {}
    return {
      existing: true,
      id: body.id || body.subscription?.id || null,
      message: body.message || 'Subscription already exists'
    };
  }
  if (!r.ok) throw new Error(`EventSub ${type} failed: ${r.status} ${txt}`);
  return JSON.parse(txt);
}

async function ensureEventSubs(env, broadcasterId) {
  const token = await appAccessToken(env);
  const callback = `${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/webhook/twitch`;

  const r = await fetch(`${API}/eventsub/subscriptions?status=enabled`, {
    headers:{
      'Client-Id':env.TWITCH_CLIENT_ID,
      Authorization:`Bearer ${token}`
    }
  });

  const body = r.ok ? await r.json() : {data:[]};
  const existing = body.data || [];

  // Use one canonical stream for Plus Points. Its payload contains
  // is_prime/is_gift for subscriptions and resubscriptions, plus dedicated
  // paid-upgrade notices for Prime/Gift -> paid recurring subscriptions.
  const type = 'channel.chat.notification';
  const found = existing.some(s =>
    s.type === type &&
    s.status === 'enabled' &&
    s.condition?.broadcaster_user_id === broadcasterId &&
    s.condition?.user_id === broadcasterId &&
    s.transport?.callback === callback
  );

  if (!found) return [await createSubscription(env,broadcasterId,type)];
  return [];
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function twitchSubscriptionTier(env, channel, userId) {
  const access = await getUserAccessToken(env, channel);
  const url = `${API}/subscriptions?broadcaster_id=${encodeURIComponent(channel.broadcaster_id)}&user_id=${encodeURIComponent(userId)}`;

  // A gift-paid-upgrade event can arrive very close to the moment at which the
  // subscription record changes from gift=true to gift=false. Retry briefly so
  // we do not accidentally credit a gifted sub.
  for (const delay of [0, 750, 2000]) {
    if (delay) await sleep(delay);

    const r = await fetch(url, {
      headers:{
        'Client-Id':env.TWITCH_CLIENT_ID,
        Authorization:`Bearer ${access}`
      }
    });
    if (!r.ok) continue;

    const body = await r.json();
    const sub = body.data?.[0];
    if (!sub) continue;
    if (sub.is_gift === true) continue;

    return sub.tier || null;
  }

  return null;
}

async function processCliTestEvent(env, channel, type, event, eventTimestamp) {
  // The Twitch CLI can generate channel.subscribe and
  // channel.subscription.message mock webhook payloads. We deliberately keep
  // these test-only by requiring ?test=1 on the webhook URL, so a real
  // subscription event cannot accidentally be double-counted.
  if (type === 'channel.subscribe') {
    // Twitch's current CLI `subscribe` trigger is a standard paid Tier 1
    // subscription and the payload exposes is_gift. Gift subscriptions do not
    // generate Plus Points.
    if (!event || event.is_gift === true) return;
    await addPoints(
      env,
      channel.broadcaster_id,
      tierPoints(event.tier),
      eventTimestamp
    );
    return;
  }

  if (type === 'channel.subscription.message') {
    // This is a resubscription event. One event represents the current renewal;
    // do not multiply by duration_months.
    if (!event) return;
    await addPoints(
      env,
      channel.broadcaster_id,
      tierPoints(event.tier),
      eventTimestamp
    );
  }
}

async function processChatNotification(env, channel, event, eventTimestamp) {
  if (!event || !event.notice_type) return;

  // A shared-chat notice can originate from another broadcaster. It must not
  // be credited to the broadcaster tracked by this overlay.
  if (String(event.notice_type).startsWith('shared_chat_')) return;

  const notice = event.notice_type;

  // New subscription. Prime and gift subscriptions are explicitly excluded
  // from Plus Points. A multi-month purchase contributes only once now;
  // subsequent monthly renewals arrive as their own future events.
  if (notice === 'sub' && event.sub) {
    const isPrime = event.sub.is_prime === true;
    const isGift = event.sub.is_gift === true;
    if (isPrime || isGift) return;

    const tier = event.sub.sub_tier ?? event.sub.sub_plan;
    await addPoints(env, channel.broadcaster_id, tierPoints(tier), eventTimestamp);
    return;
  }

  // Paid recurring renewal. Again, count the actual purchase/renewal event,
  // not every month of a pre-paid multi-month term in advance.
  if (notice === 'resub' && event.resub) {
    const isPrime = event.resub.is_prime === true;
    const isGift = event.resub.is_gift === true;
    if (isPrime || isGift) return;

    const tier = event.resub.sub_tier ?? event.resub.sub_plan;
    await addPoints(env, channel.broadcaster_id, tierPoints(tier), eventTimestamp);
    return;
  }

  // A Prime subscription earns no Plus Points until its paid recurring period
  // actually begins. Twitch exposes the paid-upgrade tier here.
  if (notice === 'prime_paid_upgrade' && event.prime_paid_upgrade) {
    const tier = event.prime_paid_upgrade.sub_tier ?? event.prime_paid_upgrade.sub_plan;
    await addPoints(env, channel.broadcaster_id, tierPoints(tier), eventTimestamp);
    return;
  }

  // A gifted subscription earns no Plus Points. When the gifted term ends and
  // paid recurring billing starts, Twitch emits gift_paid_upgrade. The notice
  // does not include the new tier, so use the broadcaster-subscriptions API.
  if (notice === 'gift_paid_upgrade') {
    const userId = event.chatter_user_id || event.user_id;
    if (!userId) return;

    const tier = await twitchSubscriptionTier(env, channel, userId);
    await addPoints(env, channel.broadcaster_id, tierPoints(tier), eventTimestamp);
  }
}

async function verifyTwitchSignature(request, rawBody, env) {
  const msgId = request.headers.get('Twitch-Eventsub-Message-Id') || '';
  const timestamp = request.headers.get('Twitch-Eventsub-Message-Timestamp') || '';
  const signature = request.headers.get('Twitch-Eventsub-Message-Signature') || '';
  if (!msgId || !timestamp || !signature) return false;

  const secretBytes = new TextEncoder().encode(env.EVENTSUB_SECRET);
  const key = await crypto.subtle.importKey('raw', secretBytes, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const data = new TextEncoder().encode(msgId + timestamp + rawBody);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  // Twitch expects the HMAC-SHA256 digest encoded as lowercase hexadecimal,
  // prefixed with "sha256=", not Base64.
  const digestHex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  const expected = 'sha256=' + digestHex;

  if (expected.length !== signature.length) return false;

  // Constant-time byte comparison to avoid timing differences.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

function serveAsset(request, env) {
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      await cleanup(env);
    } catch {}

    if (url.pathname === '/auth/start') {
      const state = randomString(24);
      await env.DB.prepare(
        'INSERT INTO oauth_states(state,created_at,expires_at) VALUES(?,?,?)'
      ).bind(state,nowSec(),nowSec()+600).run();

      const auth = new URL(`${OAUTH}/authorize`);
      auth.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
      auth.searchParams.set('redirect_uri', `${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/auth/callback`);
      auth.searchParams.set('response_type','code');
      auth.searchParams.set('scope',[
        'channel:read:subscriptions',
        'user:read:chat',
        'user:bot',
        'channel:bot'
      ].join(' '));
      auth.searchParams.set('state', state);
      return htmlRedirect(auth.toString());
    }

    if (url.pathname === '/auth/callback') {
      const err = url.searchParams.get('error');
      if (err) return htmlRedirect(`/?error=${encodeURIComponent(err)}&error_description=${encodeURIComponent(url.searchParams.get('error_description')||'')}`);

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const stateRow = state ? await env.DB.prepare('SELECT * FROM oauth_states WHERE state=? AND expires_at>?').bind(state,nowSec()).first() : null;
      if (!code || !stateRow) {
        return htmlRedirect('/?error=invalid_oauth_state');
      }
      await env.DB.prepare('DELETE FROM oauth_states WHERE state=?').bind(state).run();

      const tokenUrl = new URL(`${OAUTH}/token`);
      tokenUrl.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
      tokenUrl.searchParams.set('client_secret', env.TWITCH_CLIENT_SECRET);
      tokenUrl.searchParams.set('code',code);
      tokenUrl.searchParams.set('grant_type','authorization_code');
      tokenUrl.searchParams.set('redirect_uri',`${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/auth/callback`);

      const tr = await fetch(tokenUrl,{method:'POST'});
      const tb = await tr.json().catch(()=>({}));
      if (!tr.ok || !tb.access_token) return htmlRedirect('/?error=twitch_token_exchange_failed');

      const user = await twitchUser(env,tb.access_token);
      if (!user) return htmlRedirect('/?error=twitch_user_failed');

      const accessEnc = await encryptText(env,tb.access_token);
      const refreshEnc = await encryptText(env,tb.refresh_token);
      const publicKey = randomString(18);
      // preserve an existing public key/config where possible
      const existing = await findChannelById(env,user.id);
      const created = nowSec();
      await env.DB.prepare(`
        INSERT INTO channels(
          broadcaster_id,login,display_name,public_key,title,label,target,icon_url,
          needs_reauth,access_token_enc,refresh_token_enc,token_expires_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?)
        ON CONFLICT(broadcaster_id) DO UPDATE SET
          login=excluded.login,
          display_name=excluded.display_name,
          access_token_enc=excluded.access_token_enc,
          refresh_token_enc=excluded.refresh_token_enc,
          token_expires_at=excluded.token_expires_at,
          needs_reauth=0,
          updated_at=excluded.updated_at
      `).bind(
        user.id,user.login,user.display_name,
        existing?.public_key || publicKey,
        existing?.title || DEFAULT_TITLE,
        existing?.label || DEFAULT_LABEL,
        existing?.target || DEFAULT_TARGET,
        existing?.icon_url || '',
        accessEnc,refreshEnc,nowSec()+Number(tb.expires_in||0),created,created
      ).run();

      let eventSubError = '';
      try {
        await ensureEventSubs(env,user.id);
      } catch (e) {
        eventSubError = String(e?.message || e);
      }
      if (eventSubError) {
        return htmlRedirect(`/?error=eventsub_setup_failed&error_description=${encodeURIComponent(eventSubError)}`);
      }

      const sid = await createSession(env,user.id);
      const headers = new Headers({Location:'/setup'});
      headers.append('Set-Cookie',cookie('pp_session',sid,86400*30));
      return new Response(null,{status:302,headers});
    }

    if (url.pathname === '/api/me') {
      const c = await getSessionChannel(request,env);
      if (!c) return json({authenticated:false},401);
      const points = await getCurrentPoints(env,c.broadcaster_id);
      return json({
        authenticated:true,
        login:c.login,
        displayName:c.display_name,
        config:{
          title:c.title,label:c.label,target:c.target,iconUrl:c.icon_url,points
        },
        publicKey:c.public_key
      });
    }

    if (url.pathname === '/api/config' && request.method === 'POST') {
      const c = await getSessionChannel(request,env);
      if (!c) return json({message:'Nicht angemeldet.'},401);

      let body;
      try { body = await request.json(); } catch { return json({message:'Ungültige Anfrage.'},400); }

      const title = safeText(body.title,DEFAULT_TITLE,80);
      const label = safeText(body.label,DEFAULT_LABEL,40);
      const target = safeInt(body.target,DEFAULT_TARGET,1,9999);
      const iconUrl = safeImageUrl(body.iconUrl);
      const currentPoints = await getCurrentPoints(env,c.broadcaster_id);

      // Only seed the current month when explicitly supplied and when the source has not accumulated anything yet.
      const requestedInitial = safeInt(body.initialPoints,currentPoints,0,9999);
      const existingMonth = await env.DB.prepare(
        'SELECT points FROM monthly_points WHERE broadcaster_id=? AND month_key=?'
      ).bind(c.broadcaster_id,monthKeyNow()).first();

      if (existingMonth && Number(existingMonth.points) === 0 && requestedInitial > 0) {
        await env.DB.prepare(
          'UPDATE monthly_points SET points=?,updated_at=? WHERE broadcaster_id=? AND month_key=?'
        ).bind(requestedInitial,nowSec(),c.broadcaster_id,monthKeyNow()).run();
      }

      await env.DB.prepare(
        'UPDATE channels SET title=?,label=?,target=?,icon_url=?,updated_at=? WHERE broadcaster_id=?'
      ).bind(title,label,target,iconUrl,nowSec(),c.broadcaster_id).run();

      return json({
        ok:true,
        overlayUrl:`${env.PUBLIC_BASE_URL.replace(/\/$/,'')}/o/${c.public_key}`
      });
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      const sid = getCookie(request,'pp_session');
      if (sid) await env.DB.prepare('DELETE FROM sessions WHERE session_id=?').bind(sid).run();
      return new Response(null,{status:204,headers:{'Set-Cookie':clearCookie('pp_session')}});
    }

    if (url.pathname === '/api/test-info') {
      return json({
        ok: true,
        message: 'Use Twitch CLI against /webhook/twitch?test=1 with the EVENTSUB_SECRET to simulate subscribe or subscribe-message events.'
      });
    }

    if (url.pathname.startsWith('/api/overlay/')) {
      const key = url.pathname.split('/').pop();
      const c = await findChannelByPublicKey(env,key);
      if (!c) return json({message:'Overlay nicht gefunden.'},404);
      const points = await getCurrentPoints(env,c.broadcaster_id);
      return json({
        title:c.title,
        label:c.label,
        target:Number(c.target),
        points,
        iconUrl:c.icon_url || ''
      });
    }

    if (url.pathname === '/webhook/twitch' && request.method === 'POST') {
      const raw = await request.text();
      if (!(await verifyTwitchSignature(request,raw,env))) return new Response('invalid signature',{status:403});

      const messageType = request.headers.get('Twitch-Eventsub-Message-Type') || '';
      const messageId = request.headers.get('Twitch-Eventsub-Message-Id') || '';

      if (messageType === 'webhook_callback_verification') {
        let payload; try { payload = JSON.parse(raw); } catch { return new Response('bad',{status:400}); }
        return new Response(payload.challenge || '',{status:200,headers:{'Content-Type':'text/plain'}});
      }

      if (messageType === 'revocation') {
        try {
          const payload = JSON.parse(raw);
          const broadcasterId = payload.subscription?.condition?.broadcaster_user_id;
          if (broadcasterId) await env.DB.prepare('UPDATE channels SET needs_reauth=1,updated_at=? WHERE broadcaster_id=?').bind(nowSec(),broadcasterId).run();
        } catch {}
        return new Response('',{status:204});
      }

      if (messageType === 'notification') {
        try {
          const payload = JSON.parse(raw);
          if (messageId) {
            const duplicate = await env.DB.prepare('SELECT event_id FROM seen_events WHERE event_id=?').bind(messageId).first();
            if (duplicate) return new Response('',{status:204});
            await env.DB.prepare('INSERT INTO seen_events(event_id,created_at) VALUES(?,?)').bind(messageId,nowSec()).run();
          }

          const broadcasterId = payload.subscription?.condition?.broadcaster_user_id;
          if (!broadcasterId) return new Response('',{status:204});
          const channel = await findChannelById(env,broadcasterId);
          if (!channel) return new Response('',{status:204});

          const type = payload.subscription?.type;
          const event = payload.event;
          const eventTs = request.headers.get('Twitch-Eventsub-Message-Timestamp') || new Date().toISOString();

          if (type === 'channel.chat.notification') {
            await processChatNotification(env,channel,event,eventTs);
          } else if (
            url.searchParams.get('test') === '1' &&
            (type === 'channel.subscribe' || type === 'channel.subscription.message')
          ) {
            await processCliTestEvent(env,channel,type,event,eventTs);
          }
        } catch (e) {
          console.log('webhook processing failed',e.message);
        }
        return new Response('',{status:204});
      }
      return new Response('',{status:204});
    }

    // Route /setup to the HTML app.
    if (url.pathname === '/setup' || url.pathname === '/setup/') {
      return env.ASSETS.fetch(new Request(new URL('/index.html',request.url),request));
    }
    if (url.pathname.startsWith('/o/')) {
      return env.ASSETS.fetch(new Request(new URL('/overlay.html',request.url),request));
    }

    return serveAsset(request,env);
  }
};
