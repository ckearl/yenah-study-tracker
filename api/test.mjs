// Local test: stubs DynamoDB in memory and drives the handler.
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';
import { hashPassword } from './hash-password.mjs';
const vk = webpush.generateVAPIDKeys();
Object.assign(process.env, { CALENDAR_URL: 'https://calendar.example/basic.ics', TABLE: 't', PASSWORD_HASH: hashPassword('pw'), VAPID_SUBJECT: 'mailto:x@y.z', VAPID_PUBLIC: vk.publicKey, VAPID_PRIVATE: vk.privateKey });
const store = new Map();
const k = (key) => key.pk + '|' + key.sk;
DynamoDBDocumentClient.prototype.send = async function (cmd) {
  const n = cmd.constructor.name, i = cmd.input;
  if (n === 'GetCommand') return { Item: structuredClone(store.get(k(i.Key))) };
  if (n === 'PutCommand') {
    if (i.ConditionExpression && store.has(k(i.Item))) throw Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
    store.set(k(i.Item), structuredClone(i.Item)); return {};
  }
  if (n === 'DeleteCommand') { store.delete(k(i.Key)); return {}; }
  if (n === 'QueryCommand') return { Items: [...store.values()].filter((x) => x.pk === i.ExpressionAttributeValues[':p']) };
  if (n === 'UpdateCommand') { // supports the 'SET attr = :v' and 'ADD attr :n SET #name = :v' forms the API uses
    const add = /^ADD (\w+) (:\w+)/.exec(i.UpdateExpression);
    if (add) {
      const item = store.get(k(i.Key)) || { ...i.Key };
      item[add[1]] = (item[add[1]] || 0) + i.ExpressionAttributeValues[add[2]];
      store.set(k(i.Key), item); return { Attributes: { [add[1]]: item[add[1]] } };
    }
    const item = store.get(k(i.Key));
    if (!item) throw Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
    const [, attr, ph] = /SET (\w+) = (:\w+)/.exec(i.UpdateExpression);
    item[attr] = i.ExpressionAttributeValues[ph]; return {};
  }
  throw new Error(n);
};
// Google calendar feed: unreachable (null) until the calendar tests set it.
let ics = null, fetches = 0;
globalThis.fetch = async () => { fetches++; return ics ? { ok: true, status: 200, text: async () => ics } : { ok: false, status: 404, text: async () => '' }; };
const { handler, _test } = await import('./index.mjs');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };

// DST-aware conversion: Aug 20 10:00 MDT = 16:00Z; Dec 1 10:00 MST = 17:00Z
assert(new Date(_test.localToUtc('2026-08-20', '10:00')).toISOString() === '2026-08-20T16:00:00.000Z', 'MDT conversion');
assert(new Date(_test.localToUtc('2026-12-01', '10:00')).toISOString() === '2026-12-01T17:00:00.000Z', 'MST conversion');

let token = 'x'.repeat(43);
const call = (method, path, body, tok = token) => handler({ rawPath: path, requestContext: { http: { method } }, headers: { authorization: `Bearer ${tok}` }, body: body && JSON.stringify(body) }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));
assert((await call('GET', '/api/state')).status === 401, 'rejects unknown token');
assert((await call('POST', '/api/login', { password: 'nope' })).status === 401, 'rejects wrong password');
const li = await call('POST', '/api/login', { password: 'pw', device: 'iPhone · Safari' });
assert(li.status === 200 && li.token && li.expires - Date.now() > 29 * 86400e3, 'login issues 30-day token');
token = li.token;
const dv = await call('GET', '/api/devices');
assert(dv.devices.length === 1 && dv.devices[0].current && dv.devices[0].device === 'iPhone · Safari', 'device saved');
assert((await call('POST', '/api/subscribe', { subscription: { endpoint: 'https://169.254.169.254/x', keys: { p256dh: 'a', auth: 'b' } } })).status === 400, 'rejects non-push endpoint');
assert((await call('POST', '/api/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'a', auth: 'b' } } })).status === 200, 'accepts Apple push endpoint');

// Freeze "now" at Sat Oct 17 2026 noon Denver
const realNow = Date.now; Date.now = () => _test.localToUtc('2026-10-17', '12:00');
let s = await call('GET', '/api/state');
const cls = s.sessions.filter((x) => x.auto);
// Count expected: weekdays Aug20..Oct16 minus Sep 7
const counts = {}; cls.forEach((x) => counts[x.course] = (counts[x.course] || 0) + 1);
console.log(counts);
assert(!cls.some((x) => x.id.endsWith('2026-09-07')), 'Labor Day skipped');
assert(cls.some((x) => x.id === 'class-fall-2026-m-lrw-2026-08-20'), 'first day Thu LR&W present');
assert(!cls.some((x) => x.id === 'class-fall-2026-m-torts-2026-08-20'), 'no Torts on a Thursday');

// Delete a skipped class; it must not come back
await call('DELETE', '/api/sessions/class-fall-2026-m-torts-2026-10-14');
s = await call('GET', '/api/state');
assert(!s.sessions.some((x) => x.id === 'class-fall-2026-m-torts-2026-10-14'), 'deleted class stays deleted');

// Add a new class with schedule mid-semester → backfills
const cfg = s.config;
cfg.courses.push({ name: 'Moot Court', short: 'Moot', color: '#ff9900', id: 'moot' });
cfg.semesters[0].schedule.push({ course: 'moot', days: ['F'], start: '13:00', end: '14:00' });
s = await call('PUT', '/api/config', cfg);
assert(s.sessions.filter((x) => x.course === 'moot').length === 9, 'new meeting backfilled (Fridays Aug21..Oct16 = 9)');

// A class is logged as soon as it starts, with its scheduled end
Date.now = () => _test.localToUtc('2026-10-19', '09:05');
s = await call('GET', '/api/state');
const live = s.sessions.find((x) => x.id === 'class-fall-2026-m-torts-2026-10-19');
assert(live && live.end === _test.localToUtc('2026-10-19', '10:30'), 'in-progress class logged at start');
assert(!s.sessions.some((x) => x.id === 'class-fall-2026-m-contracts-2026-10-19'), 'later class not logged yet');
await call('DELETE', '/api/sessions/class-fall-2026-m-torts-2026-10-19');
Date.now = () => _test.localToUtc('2026-10-19', '12:00');
s = await call('GET', '/api/state');
assert(!s.sessions.some((x) => x.id === 'class-fall-2026-m-torts-2026-10-19'), 'class deleted mid-class stays deleted');

// Timer: start, switch, pause
Date.now = () => _test.localToUtc('2026-10-17', '13:00');
s = await call('POST', '/api/start', { course: 'torts', category: 'study' });
assert(s.active?.course === 'torts', 'started');
Date.now = () => _test.localToUtc('2026-10-17', '16:00');
const r = await handler({ task: 'cron' });
assert(r.reminded === true, 'cron reminds after 3h');
assert((await handler({ task: 'cron' })).reminded === false, 'only one reminder per run');

s = await call('POST', '/api/pause', { note: 'ch 4' });
const last = s.sessions.find((x) => x.category === 'study');
assert(!s.active && last && last.end - last.start === 3 * 3600e3 && last.note === 'ch 4', 'pause saves session with note');
// Reminder setting: off → no push; custom time respected
let cfg2 = (await call('GET', '/api/state')).config;
cfg2.reminder = { enabled: false, minutes: 60 };
await call('PUT', '/api/config', cfg2);
Date.now = () => _test.localToUtc('2026-10-17', '18:00');
await call('POST', '/api/start', { course: 'torts', category: 'study' });
Date.now = () => _test.localToUtc('2026-10-17', '21:00');
assert((await handler({ task: 'cron' })).reminded === false, 'no reminder when turned off');
cfg2.reminder = { enabled: true, minutes: 60 };
await call('PUT', '/api/config', cfg2);
Date.now = () => _test.localToUtc('2026-10-17', '18:55');
assert((await handler({ task: 'cron' })).reminded === false, 'not before custom time (55m)');
Date.now = () => _test.localToUtc('2026-10-17', '19:01');
assert((await handler({ task: 'cron' })).reminded === true, 'fires at custom time (61m)');
cfg2.reminder = { enabled: true, minutes: 5 };
assert((await call('PUT', '/api/config', cfg2)).config.reminder.minutes === 15, 'minimum 15 minutes enforced');
// Google calendar takes over from the Settings schedule
const tortsEvent = ({ exdates = [], override } = {}) => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:America/Denver
BEGIN:DAYLIGHT
TZOFFSETFROM:-0700
TZOFFSETTO:-0600
TZNAME:MDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0600
TZOFFSETTO:-0700
TZNAME:MST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:torts@google.com
DTSTART;TZID=America/Denver:20261019T100000
DTEND;TZID=America/Denver:20261019T115000
RRULE:FREQ=WEEKLY;UNTIL=20261205T065959Z;BYDAY=MO,WE
${exdates.map((d) => `EXDATE;TZID=America/Denver:${d}T100000\n`).join('')}SUMMARY:LAW 505 (Torts)
END:VEVENT
${override ? `BEGIN:VEVENT
UID:torts@google.com
RECURRENCE-ID;TZID=America/Denver:${override.day}T100000
DTSTART;TZID=America/Denver:${override.day}T${override.start}00
DTEND;TZID=America/Denver:${override.day}T${override.end}00
SUMMARY:LAW 505 (Torts)
END:VEVENT
` : ''}BEGIN:VEVENT
UID:final@google.com
DTSTART;TZID=America/Denver:20261026T130000
DTEND;TZID=America/Denver:20261026T140000
SUMMARY:TORTS FINAL review
END:VEVENT
BEGIN:VEVENT
UID:break@google.com
DTSTART;VALUE=DATE:20261026
DTEND;VALUE=DATE:20261027
SUMMARY:no class
END:VEVENT
END:VCALENDAR`;
const at = (day, hhmm) => { Date.now = () => _test.localToUtc(day, hhmm); return call('GET', '/api/state'); };
const torts = (ss, day) => ss.sessions.filter((x) => x.course === 'torts' && x.category === 'class' && _test.localDateStr(x.start) === day);
assert(fetches > 0 && !store.get('META|materialize').calMark, 'unreachable calendar: Settings schedule still used');
ics = tortsEvent();
s = await at('2026-10-26', '08:30');
assert(store.get('META|materialize').calMark === _test.localToUtc('2026-10-26', '08:30'), 'calendar takes over once read');
assert(s.sessions.some((x) => x.id === 'class-fall-2026-m-lrw-2026-10-26'), 'classes before the switch came from Settings');
s = await at('2026-10-26', '10:05');
let t = torts(s, '2026-10-26');
assert(t.length === 1 && t[0].id.startsWith('class-cal-') && t[0].end === _test.localToUtc('2026-10-26', '11:50'), 'calendar class logged at start');
assert(!s.sessions.some((x) => x.id === 'class-fall-2026-m-contracts-2026-10-26' || x.id === 'class-fall-2026-m-torts-2026-10-26'), 'Settings schedule no longer used');
assert(!s.sessions.some((x) => _test.localDateStr(x.start) === '2026-10-26' && x.start === _test.localToUtc('2026-10-26', '13:00')), 'events without a course code ignored');
ics = tortsEvent({ override: { day: '20261026', start: '1000', end: '1100' } });
s = await at('2026-10-26', '10:30');
t = torts(s, '2026-10-26');
assert(t.length === 1 && t[0].end === _test.localToUtc('2026-10-26', '11:00'), 'shortened in the calendar → duration updated');
await call('PUT', `/api/sessions/${t[0].id}`, { ...t[0], end: _test.localToUtc('2026-10-26', '10:45') });
ics = tortsEvent({ override: { day: '20261026', start: '1000', end: '1130' } });
s = await at('2026-10-26', '12:00');
assert(torts(s, '2026-10-26')[0].end === _test.localToUtc('2026-10-26', '10:45'), 'her own edit wins over the calendar');
ics = tortsEvent({ exdates: ['20261028'] });
s = await at('2026-10-28', '12:00');
assert(torts(s, '2026-10-28').length === 0, 'cancelled in the calendar → not logged');
s = await at('2026-11-02', '10:05');
await call('DELETE', `/api/sessions/${torts(s, '2026-11-02')[0].id}`);
s = await at('2026-11-02', '10:20');
assert(torts(s, '2026-11-02').length === 0, 'deleted calendar class stays deleted');
s = await at('2026-11-04', '10:05');
assert(torts(s, '2026-11-04').length === 1, 'Nov 4 logged');
ics = tortsEvent({ exdates: ['20261028', '20261104'] });
s = await at('2026-11-04', '10:30');
assert(torts(s, '2026-11-04').length === 0, 'cancelled after it started → removed');
ics = null;
s = await at('2026-11-09', '09:00');
ics = tortsEvent({ exdates: ['20261028', '20261104'] });
s = await at('2026-11-09', '12:00');
assert(torts(s, '2026-11-09').length === 1 && !s.sessions.some((x) => x.id.startsWith('class-fall-2026-') && x.start > _test.localToUtc('2026-10-26', '08:30')), 'calendar outage: backfills from calendar, not Settings');
const n = fetches; await handler({ task: 'cron' });
assert(fetches === n, 'reminder cron never reads the calendar');
// Expired token is rejected
const tokItem = [...store.values()].find((x) => x.pk === 'TOKEN');
tokItem.expires = Date.now() - 1;
assert((await call('GET', '/api/state')).status === 401, 'expired token rejected');
Date.now = realNow;
// Lockout after repeated wrong passwords
// Lockout is per viewer IP (the last X-Forwarded-For hop before CloudFront's own address)
const loginFrom = (xff, password) => handler({ rawPath: '/api/login', requestContext: { http: { method: 'POST', sourceIp: '130.176.1.1' } }, headers: { 'x-forwarded-for': xff }, body: JSON.stringify({ password }) }).then((r) => r.statusCode);
assert((await Promise.all(Array.from({ length: 12 }, () => loginFrom('9.9.9.9', 'bad')))).filter((c) => c === 401).length === 8, 'parallel attempts: only 8 checked');
assert(await loginFrom('9.9.9.9, 130.176.1.1', 'pw') === 429, 'locks out after 8 failures');
assert(await loginFrom('1.2.3.4, 9.9.9.9', 'pw') === 429, 'spoofed X-Forwarded-For prefix does not escape the lock');
assert(await loginFrom('5.6.7.8', 'pw') === 200, 'another IP can still sign in');
for (let i = 0; i < 7; i++) await loginFrom('5.6.7.8', 'bad');
assert(await loginFrom('5.6.7.8', 'pw') === 200 && await loginFrom('5.6.7.8', 'bad') === 401, 'successful sign-in resets that IP\'s count');
Date.now = () => realNow() + 16 * 60e3;
assert(await loginFrom('9.9.9.9', 'pw') === 200, 'lock lifts after 15 minutes');
for (let i = 0; i < 100; i++) await loginFrom(`10.0.${i >> 8}.${i & 255}`, 'bad');
assert(await loginFrom('7.7.7.7', 'pw') === 429, 'backstop: 100 failures across all IPs locks sign-in');
Date.now = realNow;
