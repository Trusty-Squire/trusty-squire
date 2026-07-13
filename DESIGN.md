# Design System — Trusty Squire

> Read this before any visual or UI change to the webapp (`apps/web`).
> Fonts, color, spacing, motion, and component patterns are defined here.
> Don't deviate without explicit approval. Flag any code that diverges.

## Product Context
- **What this is:** Trusty Squire signs up and signs in to websites for developers working through coding agents. Generated credentials land in an encrypted vault instead of chat, source code, or `.env` files.
- **Who it's for:** Developers who live in the terminal (Claude Code, Cursor, Codex, Goose).
- **Space:** Developer infrastructure / secrets management.
- **Surfaces:** marketing landing (`/`), public getting-started (`/start`), auth (`/login`), the app (`/vault`, `/vault/new`, `/agents`). `/install` is the token-gated OAuth-binding wizard the CLI opens (centered auth-card), distinct from `/start`.

## Memorable Thing
**"Serious infrastructure for people who live in the terminal — calm, fast, exact."**
What someone remembers is the quiet precision: keys handled like a pro tool, not a consumer app. Every decision serves this.

## Aesthetic Direction
- **Lane:** Linear-leaning polished dark, industrial-utilitarian. Brutal simplicity + efficiency.
- **Decoration:** minimal. One indigo accent. A single soft radial glow behind the login mark, the vault header, and the marketing-landing hero *only* — everywhere else flat. The landing glow is **static** (no drift/loop animation); the rest of the landing (product surface, capabilities, CTA) is flat.
- **Mono-forward:** anything machine (API keys, hostnames, references, counts, timestamps) renders in mono. Sans is for chrome and labels only. This is the identity.
- **Anti-slop (never):** purple gradients, centered card in a void, rounded consumer bubbles, Inter as the UI font, 3-column icon grids, decorative blobs, generic repeated glyphs.

## Typography
- **UI / body:** **Geist** (`--font-sans`, via next/font). Clean neo-grotesque, dev-native, `tabular-nums`. Replaces Inter (the convergence trap). Body weight **450**, not 400 (light-on-dark compensation).
- **Mono:** **JetBrains Mono** (`--font-mono`). Carries every machine value. The hero font of the vault.
- **One-family discipline:** Geist in multiple weights for hierarchy; mono only where content is literally machine output.
- **Scale (5 sizes, ~major third, tight):**
  - `--t-xs 12px` (mono meta, captions) · `--t-sm 14px` (secondary UI) · `--t-base 16px` (body) · `--t-lg 20px` (lead) · `--t-xl 28px` (page titles) · `40px` reserved for auth/marketing only.
- **Tracking:** headings `-0.025em`; body `-0.006em`; mono meta `+0.02em`.
- **Light-on-dark compensation:** body weight 450, line-height 1.55, `+0.01em` on small text.

## Color
Layered near-blacks, hairline borders, one indigo accent used sparingly (focus rings, the single primary action, reveal/active).
```
--bg        #08080A   page
--surface   #0E0E11   raised-1 (inputs, chips)
--raised    #15151A   raised-2 (buttons, icon tiles, modals)
--line      rgba(255,255,255,.06)   hairline (rest)
--line2     rgba(255,255,255,.12)   hairline (hover/active)
--fg        #F4F4F6   primary text
--muted     #9A9AA4   secondary text
--faint     #5A5A63   tertiary / mono meta
--accent      #8B89FF   indigo (focus, reveal, links)
--accent-fill #5D5AF0   filled primary action
--err       #FF6B6B   destructive / error
--ok        #54D88B   success
--warn      #E0B15A   amber — advisory (stale rotation, pending), never alarming
```
**No gradient accents.** The accent is a flat color. Error/success/warn used only for state — and only ever as flat tokens (`--ok`/`--err`/`--warn`), no off-token shades.

## Spacing
- **Base:** 4px. Strict rhythm — no magic numbers (kill the old 7/9/62).
- **Scale:** `--s-1 4` `--s-2 8` `--s-3 12` `--s-4 16` `--s-6 24` `--s-8 32` `--s-12 48`.
- **Section rhythm** (marketing / getting-started only, above `--s-12`): `--s-16 64` `--s-20 80` `--s-24 96`. Section padding composes from these — no magic numbers.
- **Density:** compact. It's a tool.

## Layout
- **App:** left-anchored within `max-width: 760px`. Header on a hairline baseline; content in strict-rhythm lists, not cards.
- **Login:** two-column. Left = anchored auth column with a `border-right` hairline; right = a stage carrying a quiet statement + faint masked grid + glow. Never a centered card in a void.
- **Marketing landing:** editorial, not a SaaS template. Logo hero (the brand mark front-and-centre) → pulled-back headline → a single *static* product surface (one mono terminal still, no animated demo widgets) → a dense **hairline-ruled, numbered capabilities list** (`01 / automate` …, no illustration cards) → flat CTA → footer. Wide-but-disciplined (`max-width: 1080px`), one static hero glow, motion limited to a one-shot rise/reveal.
- **Getting-started (`/start`):** the public install page (landing nav + a narrow `max-width: 640px` column): logo, the `connect` command in a copy chip, a ruled supported-agents list, numbered next-steps. Flat. The landing "Install" CTA points here, not at npm.
- **Border radius:** `--r-sm 6` `--r-md 8` `--r-lg 10`, `999` for pills/avatars. Tighter than consumer.

## Components
- **Service icon (vault rows):** the service's **favicon** (resolved from the credential's `allowed_hosts` host via a favicon service), in a 28px hairline-square tile. **Lettermark fallback** (first letter, mono, muted) when there is no host or the favicon fails — never a generic key glyph.
- **Secret line:** masked `••••` in mono + lowercase `reveal`/`copy` links (accent). Revealed = the value in mono `--fg` + `copy`. Multi-field shows each named field.
- **Primary action:** outline by default (`+ Add key`), filled accent only for the single focal CTA. Quiet `Delete` pill that reddens on hover.
- **Keyboard rail:** optional footer hint (`R reveal · C copy · ⌘K search`) — the "fast" signal.

## Motion
- **Approach:** minimal-functional but present (this is where "efficient" is felt).
- **Easing:** enter `cubic-bezier(.2,.7,.2,1)`, hover/press `ease-out`.
- **Duration:** micro 80ms (copy confirm) · short 120–160ms (hover/press, reveal mask→value) · medium 250ms.
- **Optimistic:** delete collapses the row instantly.
- Respect `prefers-reduced-motion`.

## Plumbing
- Drop the half-used `@import "tailwindcss"` if no utilities are in use; commit to the CSS-variable token system. One styling model.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-30 | Initial system created | /design-consultation. Linear-leaning polished dark; Geist + JetBrains Mono; mono-forward vault; favicon service icons; left-anchored ruled login. Approved against rendered mockups. |
| 2026-05-31 | Landing + marketing overhaul | Editorial rebuild of `/` (retired the zig-zag feature cards + animated demo widgets → numbered hairline-ruled capabilities list + one static product surface + logo hero); one static hero glow (decoration exception); new public `/start` install page (landing "Install" repointed off npm); added `--warn` token + `--s-16/20/24` section rhythm; unified all off-token greens→`--ok`/ambers→`--warn`; shared `Shield` component (currentColor) replaces per-file inline SVGs. |
