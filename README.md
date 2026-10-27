# Yenah's Study Tracker

A clock-in/clock-out tracker for law school study time, built for a phone: <https://yenstudy.ckearl.com>

- **Two taps to log time:** tap an activity (Class / Study / Read / Other) on a class card, then tap **Start**. Tap **Pause** to clock out. Pausing saves the session; starting again begins a new one.
- **Class time is logged automatically** as each class starts. If she skips a class, she deletes that "auto" entry in History and it won't come back.
  - **From her Google class calendar**, read each time she opens the app. Events whose title has a class's code (e.g. `LAW 505 (Torts)`) count; cancelled or shortened classes follow the calendar. For 24 hours after a class starts, calendar changes still update it, unless she edited it in History.
  - **Fallback:** until the calendar has been read once (or with no `CALENDAR_URL`), the semester schedule in Settings is used, skipping holidays from the school's academic calendar.
- **Everything is editable in the app:** classes, semesters, class times, holidays, "Other" activity options, and color schemes (3 presets plus unlimited custom ones, each with light and dark versions).
- **Reminder:** one push notification if a timer runs without a pause for 2.5 hours (adjustable from 30 min to 8 hours, or turned off, in Settings → Reminders).
- **Sign-in:** a password, remembered for 30 days on each device. Signed-in devices are listed in Settings.

## Layout

| Path | What |
| --- | --- |
| `web/` | Static PWA (vanilla JS/CSS): `index.html`, `app.js`, `styles.css`, `sw.js` |
| `api/index.mjs` | One Lambda: JSON API at `/api/*` + the reminder cron (`{"task":"cron"}`) |
| `api/config.mjs` | Seed config (classes, Fall 2026 / Winter 2027 calendar) written on first run |
| `infra/deploy.sh` | Idempotent AWS deploy |

## AWS (us-west-2, all free tier)

- DynamoDB table `yenstudy` (provisioned 5/5, single-table: `S` sessions, `META` config/active timer, `TOKEN` logins, `SUB` push subscriptions)
- Lambda `yenstudy-api` (Node 22, arm64) behind a Function URL
- S3 `yenstudy-ckearl-web` → CloudFront (`/api/*` routed to the Lambda) → Route53 `yenstudy.ckearl.com`
- EventBridge rule `yenstudy-reminders`: invokes the Lambda every 5 min to check for a stopwatch past 2.5 h (no notification unless one is)

## Develop

```sh
cd api && npm install
node test.mjs          # API tests against an in-memory table
node dev.mjs           # http://localhost:8787, password "dev"
```

## Deploy

```sh
infra/deploy.sh                         # update code + site
PASSWORD='new password' infra/deploy.sh # change the password
CALENDAR_URL='https://…/basic.ics' infra/deploy.sh # set the class calendar
```

The calendar address is the class calendar's **Secret address in iCal format** (Google Calendar → Settings → the calendar → Integrate calendar).

Secrets (password hash, VAPID keys) are kept in `infra/.secrets.env`, which is gitignored. The first deploy needs `PASSWORD=...` and `VAPID_EMAIL=...` set.

### IAM permissions for the reminder cron

The deploying IAM user needs these permissions to create that background check:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["events:PutRule", "events:PutTargets", "events:DescribeRule"],
    "Resource": "arn:aws:events:us-west-2:<ACCOUNT_ID>:rule/yenstudy-*"
  }]
}
```

## iPhone setup (for reminders)

1. Open the site in Safari → **Share** → **Add to Home Screen**.
2. Open **Study** from the Home Screen and sign in.
3. Tap **Turn on** in the reminders banner (or go to Settings → Reminders) and allow notifications.
