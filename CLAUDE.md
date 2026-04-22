# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A landing page for AI Makers Club — Alen's weekly workshop community. Originally generated from a Claude Design handoff bundle, now hand-iterated. Vanilla HTML + CSS with one tiny inline JS block. No build step, no framework, no tests.

## Active vs. legacy files

- **`index.html`** — the active landing page (was `index-mono.html`). All edits go here.
- **`index-serif.html`** — serif variant from the original design handoff (was `index.html`). Kept for reference; do not edit unless explicitly asked, and don't delete without confirming. Reachable at `/serif` via `_redirects`.
- **`join/index.html`** — `/join` route. Minimal page: nav + empty `#paddle-form` placeholder for the eventual Paddle embed.
- **`terms/`, `privacy/`, `refund/`** — legal pages required by Paddle's Website Approval. Linked in the footer of every page. Contact email is `hello@joinaimakers.club` (not yet provisioned — placeholder for the future custom domain).
- **`_redirects`** — Netlify redirects. Handles legacy `/index-mono*` URLs and exposes `/serif`.
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

- **Type:** JetBrains Mono everywhere on `index.html` and `briefs/`. Instrument Serif is only used in the legacy `index-serif.html`.
- **Casing:** sentence case / lowercase everywhere. Headings, buttons, nav. No Title Case.
- **Color:** three inks on cream paper (`--paper`, `--ink`, `--ink-2`) plus `--riso-red` as the *only* accent. Never introduce new hues for UI states.
- **Borders:** one style — `1.5px solid var(--ink)`, no radius. Same for cards, inputs, buttons.
- **No shadows.** Depth via the `.riso-offset` utility (4px misregistration) when needed.
- **No emoji.** Unicode box-drawing chars (`◆ ◇ ※ → ●`) are encouraged as iconography.
- **Motion:** default static. 120ms ease for state changes max.

## Implementation hooks worth knowing

- **Founding-cohort counter** — the join card on `index.html` has `<b class="spots-sold" data-sold="0">` and an ASCII bar (`<span class="bar-filled">` / `<span class="bar-empty">`). An inline script at the bottom of `index.html` fetches `/api/spots-sold` on load and syncs all three in sync.
- **Paddle integration** (Classic) — vendor `123372`, subscription plan `924249`. Inline checkout embedded in `join/index.html`. Webhook handler at `netlify/functions/paddle-webhook.mjs` listens for `subscription_created` / `subscription_cancelled` and writes to Netlify Blobs store `paddle-counter`, key `sold`. Reader at `netlify/functions/spots-sold.mjs`. **Required Netlify env var:** `PADDLE_PUBLIC_KEY` (full PEM, from *Paddle → Developer Tools → Public Key*). After deploy: register the webhook URL `https://<site>/api/paddle-webhook` in Paddle's *Alerts/Webhooks*.
- **Nav red mode** — the inline script at the bottom of `index.html` toggles `.nav--red` whenever any `.video-placeholder` element is visually behind the sticky nav. To trigger the same swap from a new full-bleed red section, give it the `.video-placeholder` class or extend the script's selector.
- **Anchor scroll offset** — `html { scroll-padding-top: 88px }` keeps section headings clear of the sticky nav when nav links are clicked.

## Things that look broken but aren't

- **Two index files in git** — `index.html` (mono, active) + `index-serif.html` (legacy, retained).
- **`data-cc-id` attributes** — leftovers from the Claude Design tool. Harmless; don't strip them out as a cleanup pass.
- **The hero "read the brief →" link** points to `briefs/wk001.html` — that path is correct (the original design's `templates/brief/...` path is dead and was replaced).
