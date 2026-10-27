// yenstudy API + reminder cron. Single Lambda behind a Function URL (proxied by CloudFront at /api/*)
// and invoked every 5 minutes by EventBridge with {"task":"cron"}.
import { randomUUID, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';
import ICAL from 'ical.js';
import { DEFAULT_CONFIG, TZ } from './config.mjs';

const TABLE = process.env.TABLE;
const PASSWORD_HASH = process.env.PASSWORD_HASH; // "scrypt$<salt hex>$<hash hex>"
const CALENDAR_URL = process.env.CALENDAR_URL; // her Google "class" calendar's secret iCal address
const TOKEN_DAYS = 30;
const MAX_FAILS = 8; // sign-in attempts per IP per window
const MAX_FAILS_ALL = 100; // across all IPs, a backstop against spread-out guessing
const LOCK_MS = 15 * 60e3;
const MAX_BODY = 100_000;
const MAX_SUBS = 10;
// Only real Web Push services, so the server never POSTs to arbitrary URLs.
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

// ---------- time helpers (America/Denver) ----------
function tzOffsetMs(ts) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}
function localToUtc(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(guess);
  ts = guess - tzOffsetMs(ts);
  return ts;
}
function localDateStr(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DOW = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];

// ---------- data access ----------
const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item;
const put = (Item, extra = {}) => db.send(new PutCommand({ TableName: TABLE, Item, ...extra }));
const del = (pk, sk) => db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } }));
async function queryAll(pk) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk }, ExclusiveStartKey,
    }));
    items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const toSession = ({ pk, sk, ...rest }) => ({ id: sk, ...rest });

async function getConfig() {
  const item = await get('META', 'config');
  if (item) return item.config;
  await put({ pk: 'META', sk: 'config', config: DEFAULT_CONFIG });
  return DEFAULT_CONFIG;
}

// ---------- auto-logged classes ----------
// Classes are logged as they start. Without a calendar they come from the semester schedule in
// Settings. Once her Google calendar has been read successfully, it takes over from that moment
// (meta.calMark) and the Settings schedule is no longer used.
async function materializeClasses(config, now = Date.now(), { calendar = true } = {}) {
  const meta = (await get('META', 'materialize')) || { marks: {} };
  const ics = CALENDAR_URL && calendar ? await fetchCalendar(now) : null;
  if (meta.calMark == null) await materializeSchedule(config, meta.marks || {}, now);
  if (ics) {
    try {
      await materializeCalendar(config, ics, meta.calMark ?? now, now);
      meta.calMark = now;
    } catch (e) {
      console.error('calendar sync failed', e);
    }
  }
  await put({ pk: 'META', sk: 'materialize', ...meta });
}

// Write class sessions for every scheduled meeting that has started since that meeting's watermark
// (logged at the start of class, with its scheduled end time).
// Watermarks only move forward, so a class she deletes (skipped) is never recreated, and a
// meeting added late (e.g. next semester's schedule entered a week in) still backfills.
async function materializeSchedule(config, marks, now) {
  for (const sem of config.semesters) {
    const semStart = localToUtc(sem.start, '00:00');
    const semEnd = localToUtc(addDays(sem.end, 1), '00:00');
    if (now < semStart) continue;
    for (const m of sem.schedule || []) {
      const key = `${sem.id}/${m.id}`;
      const from = marks[key] ?? semStart;
      if (from >= semEnd || from >= now) continue;
      const lastDay = localDateStr(Math.min(now, semEnd - 1));
      for (let day = localDateStr(from); day <= lastDay; day = addDays(day, 1)) {
        if ((sem.noClass || []).includes(day)) continue;
        if (!m.days.includes(DOW[new Date(day + 'T12:00:00Z').getUTCDay()])) continue;
        const start = localToUtc(day, m.start);
        const end = localToUtc(day, m.end);
        if (start < from || start > now) continue;
        await putNew({ pk: 'S', sk: `class-${sem.id}-${m.id}-${day}`, course: m.course, category: 'class', start, end, auto: true });
      }
      marks[key] = Math.min(now, semEnd);
    }
  }
}

async function putNew(item) {
  try {
    await put(item, { ConditionExpression: 'attribute_not_exists(sk)' });
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
  }
}

// One fetch per minute at most, so the handful of requests a page load makes share it.
// Returns null if the calendar can't be read; classes then wait until it can (they backfill).
let calCache = { at: 0, text: null };
async function fetchCalendar(now) {
  if (calCache.text && now - calCache.at < 60e3) return calCache.text;
  try {
    const r = await fetch(CALENDAR_URL, { signal: AbortSignal.timeout(4000) });
    const text = r.ok ? await r.text() : null;
    if (!text?.includes('BEGIN:VCALENDAR')) throw new Error(`calendar fetch: HTTP ${r.status}`);
    calCache = { at: now, text };
    return text;
  } catch (e) {
    console.error(e.message);
    return null;
  }
}

const RECONCILE_MS = 24 * 3600e3;

// Log calendar classes that started since `from`. Classes from the last 24 hours that she hasn't
// edited follow later calendar changes: new times are copied over, and a class removed from the
// calendar is removed here too. A class she deletes stays deleted.
async function materializeCalendar(config, ics, from, now) {
  const since = Math.min(from, now - RECONCILE_MS);
  const meetings = calendarMeetings(ics, config.courses, since, now);
  const byId = new Map(meetings.map((m) => [m.sk, m]));
  for (const m of meetings) {
    if (m.start > from) await putNew({ pk: 'S', ...m, category: 'class', auto: true });
  }
  const recent = (await queryAll('S')).filter((x) => x.sk.startsWith('class-cal-') && !x.edited && x.start > now - RECONCILE_MS);
  for (const x of recent) {
    const m = byId.get(x.sk);
    if (!m) await del('S', x.sk);
    else if (m.start !== x.start || m.end !== x.end || m.course !== x.course) await put({ ...x, ...m });
  }
}

// Timed events whose title carries a course code (e.g. "LAW 505 (Torts)") and that start in [from, to].
function calendarMeetings(ics, courses, from, to) {
  const norm = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const codes = new Map(courses.filter((c) => c.code && !c.archived).map((c) => [norm(c.code), c.id]));
  const courseOf = (summary) => {
    for (const [, letters, num] of String(summary || '').matchAll(/([A-Za-z]{2,6})\s*(\d{3})/g)) {
      const id = codes.get(norm(letters + num));
      if (id) return id;
    }
  };
  const cal = new ICAL.Component(ICAL.parse(ics));
  for (const tz of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
  const vevents = cal.getAllSubcomponents('vevent');
  const out = [];
  for (const v of vevents) {
    if (v.hasProperty('recurrence-id')) continue;
    const uid = v.getFirstPropertyValue('uid');
    const ev = new ICAL.Event(v, { exceptions: vevents.filter((x) => x.hasProperty('recurrence-id') && x.getFirstPropertyValue('uid') === uid) });
    if (ev.startDate.isDate) continue; // all-day: breaks, deadlines
    const it = ev.iterator();
    // A moved occurrence keeps its original recurrence time, so look a week past `to` for ones moved earlier.
    for (let t; (t = it.next()) && t.toJSDate().getTime() <= to + 7 * 864e5;) {
      const d = ev.getOccurrenceDetails(t);
      const start = d.startDate.toJSDate().getTime(), end = d.endDate.toJSDate().getTime();
      const course = courseOf(d.item.summary);
      if (course && start >= from && start <= to && end > start && d.item.component.getFirstPropertyValue('status') !== 'CANCELLED') {
        const key = `${uid}/${ev.isRecurring() ? d.recurrenceId.toJSDate().getTime() : ''}`;
        out.push({ sk: `class-cal-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`, course, start, end });
      }
      if (!ev.isRecurring()) break;
    }
  }
  return out;
}

function cleanConfig(c) {
  const bad = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };
  const date = /^\d{4}-\d{2}-\d{2}$/, time = /^\d{2}:\d{2}$/;
  if (!Array.isArray(c?.courses) || !Array.isArray(c?.semesters)) bad('courses and semesters required');
  if (c.courses.length > 60 || c.semesters.length > 40 || (c.themes || []).length > 60 || (c.activities || []).length > 60) bad('too many items');
  const courses = c.courses.map((x) => ({
    id: String(x.id || randomUUID().slice(0, 8)), name: String(x.name || '').slice(0, 80) || bad('course name required'),
    short: String(x.short || x.name).slice(0, 20), code: x.code ? String(x.code).slice(0, 20) : undefined,
    archived: x.archived ? true : undefined,
  }));
  const ids = new Set(courses.map((x) => x.id));
  const semesters = c.semesters.map((s) => ({
    id: String(s.id || randomUUID().slice(0, 8)), name: String(s.name || '').slice(0, 40) || bad('semester name required'),
    start: date.test(s.start) ? s.start : bad('semester start date'), end: date.test(s.end) ? s.end : bad('semester end date'),
    noClass: (s.noClass || []).filter((d) => date.test(d)).slice(0, 100),
    schedule: (s.schedule || []).slice(0, 60).map((m) => ({
      id: String(m.id || randomUUID().slice(0, 8)),
      course: ids.has(m.course) ? m.course : bad('schedule references unknown class'),
      days: (m.days || []).filter((d) => DOW.includes(d)),
      start: time.test(m.start) ? m.start : bad('class start time'), end: time.test(m.end) ? m.end : bad('class end time'),
    })),
  }));
  const activities = [...new Set((c.activities || []).map((a) => String(a).trim().slice(0, 40)).filter(Boolean))];
  const hex = /^#[0-9a-f]{6}$/i;
  const BASES = ['blossom', 'seaside', 'matcha'];
  const themes = (c.themes || []).map((t) => ({
    id: String(t.id || randomUUID().slice(0, 8)), name: String(t.name || 'Custom').slice(0, 30),
    base: BASES.includes(t.base) ? t.base : 'blossom',
    colors: Object.fromEntries(Object.entries(t.colors || {}).filter(([k, v]) => ids.has(k) && hex.test(v))),
  }));
  const theme = [...BASES, ...themes.map((t) => t.id)].includes(c.theme) ? c.theme : 'blossom';
  const minutes = Math.round(Number(c.reminder?.minutes));
  const reminder = {
    enabled: c.reminder?.enabled !== false,
    minutes: Number.isFinite(minutes) ? Math.min(720, Math.max(15, minutes)) : 150,
  };
  return { courses, semesters, activities, themes, theme, reminder };
}

async function closeActive(note) {
  const active = await get('META', 'active');
  if (!active) return null;
  const end = Date.now();
  const n = note !== undefined ? note : active.note;
  // Ignore accidental taps shorter than 15 seconds.
  if (end - active.start >= 15e3) {
    await put({
      pk: 'S', sk: randomUUID(), course: active.course, category: active.category,
      label: active.label, start: active.start, end, note: n || undefined,
    });
  }
  await del('META', 'active');
  return active;
}

async function state() {
  const config = await getConfig();
  await materializeClasses(config);
  const [active, sessions] = await Promise.all([get('META', 'active'), queryAll('S')]);
  return {
    active: active ? { course: active.course, category: active.category, label: active.label, start: active.start, note: active.note } : null,
    sessions: sessions.map(toSession),
    config,
    vapidPublicKey: process.env.VAPID_PUBLIC,
    now: Date.now(),
  };
}

function cleanSession(b) {
  const start = Number(b.start), end = Number(b.end);
  if (!b.course || !b.category || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw Object.assign(new Error('course, category, start < end required'), { status: 400 });
  }
  return {
    course: String(b.course), category: String(b.category), label: b.label ? String(b.label).slice(0, 60) : undefined,
    start, end, note: b.note ? String(b.note).slice(0, 500) : undefined,
  };
}

// ---------- reminders ----------
async function sendToAll(payload) {
  const subs = await queryAll('SUB');
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 1800 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await del('SUB', s.sk);
      else console.error('push failed', e.statusCode, e.body);
    }
  }));
  return subs.length;
}

function fmtDur(ms) {
  const m = Math.floor(ms / 60e3);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// Older configs have no reminder setting: default to on at 2.5 hours.
const reminderOf = (config) => ({ enabled: config.reminder?.enabled !== false, minutes: config.reminder?.minutes ?? 150 });

async function cron() {
  const config = await getConfig();
  await materializeClasses(config, Date.now(), { calendar: false }); // the calendar is only read when she opens the app
  const active = await get('META', 'active');
  if (!active) return { reminded: false };
  const now = Date.now();
  const elapsed = now - active.start;
  const { enabled, minutes } = reminderOf(config);
  if (!enabled || elapsed < minutes * 60e3) return { reminded: false };
  if (active.lastReminded) return { reminded: false }; // one reminder per stopwatch run
  const name = config.courses.find((c) => c.id === active.course)?.short ?? active.course;
  const what = active.category === 'other' ? (active.label || 'Other') : active.category[0].toUpperCase() + active.category.slice(1);
  await sendToAll({
    title: `${name} · ${what} still running`,
    body: `It's been ${fmtDur(elapsed)} without a break. Tap to pause if you're done.`,
    url: '/#timer',
  });
  await db.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: 'META', sk: 'active' },
    UpdateExpression: 'SET lastReminded = :n', ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':n': now },
  })).catch(() => {});
  return { reminded: true };
}

// ---------- auth ----------
function checkPassword(pw) {
  const [, salt, hash] = (PASSWORD_HASH || '').split('$');
  if (!salt || !hash || typeof pw !== 'string') return false;
  const want = Buffer.from(hash, 'hex');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), want.length);
  return timingSafeEqual(got, want);
}
const tokenId = (token) => createHash('sha256').update(token).digest('hex');

// The viewer's IP. CloudFront appends it to X-Forwarded-For (after anything the client sent), and the
// Function URL may append CloudFront's own address, which is requestContext.http.sourceIp.
function clientIp(event) {
  const src = event.requestContext?.http?.sourceIp || 'unknown';
  const hops = String(event.headers?.['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  while (hops.length && hops.at(-1) === src) hops.pop();
  return hops.at(-1) || src;
}

// Count an attempt atomically before checking the password, so parallel requests can't
// slip extra guesses past the limit. Fixed 15-minute windows; items expire by TTL.
async function countAttempt(key, now) {
  const window = Math.floor(now / LOCK_MS);
  const r = await db.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: 'LOCK', sk: `${key}#${window}` },
    UpdateExpression: 'ADD fails :one SET #ttl = :ttl',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':one': 1, ':ttl': Math.floor(((window + 1) * LOCK_MS) / 1000) + 3600 },
    ReturnValues: 'UPDATED_NEW',
  }));
  return { fails: r.Attributes.fails, sk: `${key}#${window}`, retryMs: (window + 1) * LOCK_MS - now };
}

async function login(body, ip) {
  const now = Date.now();
  const tooMany = ({ retryMs }) => json(429, { error: `Too many tries. Try again in ${Math.ceil(retryMs / 60e3)} min.` });
  const mine = await countAttempt(`ip:${ip}`, now);
  if (mine.fails > MAX_FAILS) return tooMany(mine);
  // Only attempts within an IP's own limit count toward the backstop, so one IP can't trip it alone.
  const all = await countAttempt('all', now);
  if (all.fails > MAX_FAILS_ALL) return tooMany(all);
  if (!checkPassword(body.password)) return json(401, { error: 'Wrong password' });
  await del('LOCK', mine.sk); // her typos before a successful sign-in don't count against her later
  const token = randomBytes(32).toString('base64url');
  const expires = now + TOKEN_DAYS * 86400e3;
  await put({
    pk: 'TOKEN', sk: tokenId(token), device: String(body.device || 'Unknown device').slice(0, 80),
    created: now, lastSeen: now, expires, ttl: Math.floor(expires / 1000),
  });
  return json(200, { token, expires });
}

async function authenticate(headers) {
  const m = /^Bearer (\S{20,100})$/.exec(headers?.authorization || '');
  if (!m) return null;
  const id = tokenId(m[1]);
  const t = await get('TOKEN', id);
  if (!t || t.expires < Date.now()) return null;
  if (Date.now() - t.lastSeen > 3600e3) await put({ ...t, lastSeen: Date.now() });
  return t;
}

// ---------- HTTP ----------
const json = (status, body) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

async function route(method, path, body, me) {
  if (method === 'GET' && path === '/api/state') return json(200, await state());

  if (method === 'POST' && path === '/api/start') {
    if (!body.course || !body.category) return json(400, { error: 'course and category required' });
    await closeActive();
    await put({
      pk: 'META', sk: 'active', course: String(body.course), category: String(body.category),
      label: body.label ? String(body.label).slice(0, 60) : undefined, start: Date.now(),
    });
    return json(200, await state());
  }
  if (method === 'POST' && path === '/api/pause') {
    await closeActive(body.note);
    return json(200, await state());
  }
  if (method === 'POST' && path === '/api/active') {
    // Change category/label/note of the running timer without restarting it.
    const active = await get('META', 'active');
    if (!active) return json(409, { error: 'nothing running' });
    for (const k of ['category', 'label', 'note']) if (k in body) active[k] = body[k] ? String(body[k]).slice(0, 500) : undefined;
    await put(active);
    return json(200, await state());
  }
  if (method === 'POST' && path === '/api/sessions') {
    await put({ pk: 'S', sk: randomUUID(), ...cleanSession(body) });
    return json(200, await state());
  }
  const m = path.match(/^\/api\/sessions\/([\w-]+)$/);
  if (m && method === 'PUT') {
    const existing = await get('S', m[1]);
    if (!existing) return json(404, { error: 'not found' });
    // An auto class she edits is hers now: calendar changes no longer touch it.
    await put({ pk: 'S', sk: m[1], ...cleanSession(body), auto: existing.auto, edited: existing.auto || undefined });
    return json(200, await state());
  }
  if (m && method === 'DELETE') {
    await del('S', m[1]);
    return json(200, await state());
  }
  if (method === 'PUT' && path === '/api/config') {
    await put({ pk: 'META', sk: 'config', config: cleanConfig(body) });
    return json(200, await state());
  }
  if (method === 'POST' && path === '/api/subscribe') {
    const sub = body.subscription;
    let host;
    try { const u = new URL(sub?.endpoint); host = u.protocol === 'https:' && u.hostname; } catch { host = null; }
    if (!host || !PUSH_HOSTS.some((re) => re.test(host)) || !sub.keys?.p256dh || !sub.keys?.auth) {
      return json(400, { error: 'unsupported push subscription' });
    }
    const clean = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
    const sk = createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 32);
    await put({ pk: 'SUB', sk, subscription: clean, created: Date.now(), device: me.device });
    const subs = (await queryAll('SUB')).sort((a, b) => b.created - a.created);
    await Promise.all(subs.slice(MAX_SUBS).map((x) => del('SUB', x.sk)));
    return json(200, { ok: true });
  }
  if (method === 'GET' && path === '/api/devices') {
    const list = (await queryAll('TOKEN')).filter((t) => t.expires > Date.now()).sort((a, b) => b.lastSeen - a.lastSeen);
    return json(200, { devices: list.map((t) => ({ id: t.sk, device: t.device, created: t.created, lastSeen: t.lastSeen, expires: t.expires, current: t.sk === me.sk })) });
  }
  const dm = path.match(/^\/api\/devices\/([0-9a-f]{64})$/);
  if (dm && method === 'DELETE') {
    await del('TOKEN', dm[1]);
    return json(200, { ok: true });
  }
  if (method === 'POST' && path === '/api/logout') {
    await del('TOKEN', me.sk);
    return json(200, { ok: true });
  }
  if (method === 'POST' && path === '/api/test-push') {
    const n = await sendToAll({ title: 'Reminders are on ✓', body: `You'll get a nudge if a timer runs ${fmtDur(reminderOf(await getConfig()).minutes * 60e3)} straight.`, url: '/' });
    return json(200, { sent: n });
  }
  return json(404, { error: 'not found' });
}

export async function handler(event) {
  if (event.task === 'cron') return cron();
  try {
    const method = event.requestContext?.http?.method;
    const path = event.rawPath;
    if ((event.body?.length || 0) > MAX_BODY) return json(413, { error: 'request too large' });
    let body = {};
    if (event.body) body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
    if (body === null || typeof body !== 'object') return json(400, { error: 'bad body' });
    if (method === 'POST' && path === '/api/login') return await login(body, clientIp(event));
    const me = await authenticate(event.headers);
    if (!me) return json(401, { error: 'Please sign in' });
    return await route(method, path, body, me);
  } catch (e) {
    console.error(e);
    return json(e.status || 500, { error: e.message });
  }
}

export const _test = { localToUtc, localDateStr, materializeClasses, calendarMeetings };
