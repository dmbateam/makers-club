# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A landing page for AI Makers Club — Alen's weekly workshop community. Originally generated from a Claude Design handoff bundle, now hand-iterated. Vanilla HTML + CSS with one tiny inline JS block. No build step, no framework, no tests.

## Related projects (sibling folders)

- `projects/makers-club-circle/` — Circle-only authoring + deliverables. Weekly brief HTML sources (post-`wk001`), the `render-brief` Playwright script, designer-supplied channel icons, Circle post banners, and future slides. **Never deployed anywhere**; outputs are PNGs that get pasted manually into Circle posts. Brief HTML files there reference `https://ai-makers.club/colors_and_type.css` so brand-token edits in this repo propagate on next render.
- This repo (`makers-club-page/`) hosts the **universal brand source** under `assets/logo/` (lockup, symbol, favicon, plus designer variants `ai-maker-club-logo-v3.*`, `ai-makers-club-full.*`, `amc-favicon.png`). Both projects pull from here. When updating brand assets, update them in this repo only.

## Active vs. legacy files

- **`index.html`** — the active landing page (was `index-mono.html`). All edits go here. The "join the club" CTA links to `https://d.mba/ai-makers-club` (checkout lives there now, not on this site).
- **`terms/`, `privacy/`, `refund/`** — legal pages required by Paddle's Website Approval. Linked in the footer of every page. Contact email is `support@d.mba`. Site is live at `ai-makers.club`.
- **`_redirects`** — Netlify redirects. Handles legacy `/index-mono*` URLs and 301s `/join` → `https://d.mba/ai-makers-club` for any old bookmarks.
- **`briefs/wkNNN.html`** — weekly brief pages, one per week (currently `wk001.html`). Each imports `../colors_and_type.css`.
- **`colors_and_type.css`** — design tokens (colors, type scale, spacing, borders). Imported by every page. Edit only on a brand change.
- **`assets/logo/`** — SVG logos from the bundle. Pages currently inline the lockup SVG rather than referencing these files.

## Local dev

YouTube embeds (the hero intro video) fail when the page is opened via `file://` because the Origin header is missing. Always serve over HTTP for preview:

```
python3 -m http.server --bind 127.0.0.1 8088
open -a "Google Chrome" "http://127.0.0.1:8088/"
```

`--bind 127.0.0.1` is mandatory — the harness blocks servers bound to all interfaces.

## Design system rules to follow

From the design bundle's README and the user's iteration. Stick to them when adding sections:

- **Type:** JetBrains Mono everywhere.
- **Casing:** sentence case / lowercase everywhere. Headings, buttons, nav. No Title Case.
- **Color:** three inks on cream paper (`--paper`, `--ink`, `--ink-2`) plus `--riso-red` as the *only* accent. Never introduce new hues for UI states.
- **Borders:** one style — `1.5px solid var(--ink)`, no radius. Same for cards, inputs, buttons.
- **No shadows.** Depth via the `.riso-offset` utility (4px misregistration) when needed.
- **No emoji.** Unicode box-drawing chars (`◆ ◇ ※ → ●`) are encouraged as iconography.
- **Motion:** default static. 120ms ease for state changes max.

## Copy rules

- **No em dashes.** Anywhere. Not in page copy, briefs, emails, social posts, alt text, or any other deliverable for this project. Replace with a period, comma, colon, parentheses, "→", or a new sentence. (En dashes for numeric ranges are fine.)

## Implementation hooks worth knowing

- **Founding-cohort counter (currently locked in sold-out state)** — `index.html` ships in sold-out form: counter is hardcoded to 33/33 in HTML, the `/api/spots-sold` poll is *removed* from the inline script, the h2 is struck-through, the join section shows a `waitlist-form` instead of the `join the club` button, and a `SOLD OUT` sticker is pinned to both the join card and the hero ASCII aside. The `/api/spots-sold` endpoint and `paddle-counter` Blobs store are still wired up — the Paddle webhook still increments/decrements `sold` on every event — but the live page no longer reads from them. To reopen for round 2: revert the join section markup (un-strike h2, restore original `date-stamp` content + `join the club` button + finep), remove the hero aside sticker, restore the polling script in the inline JS, and strip the sold-out CSS block.
- **Waitlist signup** — sold-out join section's form posts to `/api/waitlist` (handler: `netlify/functions/waitlist.mjs`). Function does **create-then-tag** in Kit: first creates-or-finds the subscriber via `POST /v4/subscribers` (idempotent: 201 new, 200 existing), then applies the `waitlist-makers-club` tag (hardcoded ID `19218441`). On success, sends a confirmation email via Resend (template: `netlify/functions/emails/waitlist.html`). All steps non-blocking — Resend failure doesn't break the user flow.
- **Paddle integration** (Classic) — vendor `123372`, subscription plan `924249`. Checkout hosted on `d.mba/ai-makers-club` (off this site); webhook is server-to-server so origin of checkout doesn't matter. Webhook URL registered in Paddle: `https://ai-makers.club/api/paddle-webhook`. Handler: `netlify/functions/paddle-webhook.mjs` listens for `subscription_created` / `subscription_cancelled`, writes to Netlify Blobs store `paddle-counter`, key `sold`. Reader: `netlify/functions/spots-sold.mjs`. Welcome email via Resend, template at `netlify/functions/emails/welcome.html`.
- **Paddle webhook gotchas — every one of these has burned us once:**
  - **Vendor-wide events.** Paddle Classic webhooks fire for *every* product on the vendor account (AMC, d.MBA Coaching, Academy, Newsletter). The function filters on `subscription_plan_id === AMC_PLAN_ID` (`'924249'`). Side effect: Paddle's "Send test alert" uses fake plan ID `5` and now hits the filter — to test the counter path, either do a real purchase or temporarily set `AMC_PLAN_ID = '5'` (don't deploy that).
  - **Node 20 pin** in `netlify.toml`. On Node 22, ESM provides a native `__dirname` that collides with the shim Netlify's bundler injects when the function uses `fileURLToPath(import.meta.url)` (we read the welcome.html template at module init). Symptom: `SyntaxError: Identifier '__dirname' has already been declared`, 100% of webhook deliveries return 500, every customer is silently un-fulfilled. Don't bump Node without rewriting the template loader first.
  - **Required env vars** — set in Netlify dashboard *and* mirrored in `.env`: `PADDLE_PUBLIC_KEY` (full PEM; the dashboard UI may collapse to one line, `normalizePem()` reconstructs it), `RESEND_API_KEY`, `RESEND_FROM=alen@verification.d.mba` (note subdomain — bare `d.mba` is **not** verified on Resend; sending from it returns 403 and the welcome email vanishes silently because the function catches the error to avoid Paddle retry storms), `KIT_API_KEY` (Kit v4 API key — used by `tagInKit()` in the webhook for `customer-makers-club` tag ID `19209626`, and by `/api/waitlist` for `waitlist-makers-club` tag ID `19218441`).
  - **Vendor self-purchase risk filter.** Paddle declines purchases when buyer fingerprint matches the vendor account (same IP / email / device). To test end-to-end: mobile data + alternate email. Generic "we are unable to take payment" message, no detail in dashboard — Paddle support has the real reason in their internal logs.
  - **Per-event toggles in Paddle.** Each alert type (`subscription_created`, `subscription_cancelled`, `subscription_payment_succeeded`, etc.) has an *individual* on/off toggle in Paddle's Alerts settings. The webhook URL list is separate from these toggles — you can have the URL registered correctly and still receive nothing because the alert type itself is off. If the counter and Kit tag stop updating but the webhook function is healthy (curl returns 403 invalid-signature), check those toggles before debugging anything else.
  - **Kit's tag-only endpoint 404s for new emails.** `POST /v4/tags/{tag_id}/subscribers` returns `404 Not Found` if the email isn't already in Kit — it does **not** auto-create the subscriber. Both `tagInKit()` (in webhook) and `/api/waitlist` use the create-then-tag pattern: `POST /v4/subscribers` first (idempotent), then the tag endpoint. The customer-makers-club tag silently broke for every new buyer until we discovered this — never call the tag endpoint without a create call before it.
- **Reset the seats counter** — data lives in Netlify Blobs, not HTML. Zero it with `npx netlify-cli blobs:delete paddle-counter sold` (first-time: `netlify login`, then `netlify link --id a871a5de-6ca2-4a14-9a02-44ed9e4ba26f`). No redeploy needed; 30s edge cache.
- **Nav red mode** — the inline script at the bottom of `index.html` toggles `.nav--red` whenever any `.video-placeholder` element is visually behind the sticky nav. To trigger the same swap from a new full-bleed red section, give it the `.video-placeholder` class or extend the script's selector.
- **Anchor scroll offset** — `html { scroll-padding-top: 88px }` keeps section headings clear of the sticky nav when nav links are clicked.
- **Netlify deploy budget** — free plan is 300 build minutes/month, and each deploy here consumes ~15 minutes (functions install + cold build). That caps us at ~20 deploys/month. Batch edits before pushing; avoid push-per-typo. If a deploy cycle approaches the limit mid-month, pause non-urgent changes until the monthly reset.
- **Deploy workflow** — default to local dev for all iteration: `npx netlify dev` serves the site + functions + Blobs simulation at `localhost:8888`, zero build minutes. Commit locally as you go, but **do not push to `main` unless Alen explicitly says "deploy"** (or similar). Every push is a ~15-min build credit; batch them.

## Things that look broken but aren't

- **`data-cc-id` attributes** — leftovers from the Claude Design tool. Harmless; don't strip them out as a cleanup pass.
- **The hero "read the brief →" link** points to `briefs/wk001.html` — that path is correct (the original design's `templates/brief/...` path is dead and was replaced).
