# Trusty Squire — Design System

The design language for the Trusty Squire web app. This is the source of
truth: every component pulls from the tokens below (defined once in
`src/app/globals.css`). For a live visual audit, run `/design-review`.

## Direction

**Ruthless simplicity and speed**, in the Linear / Obsidian idiom: dark-first,
monochrome, one accent, crisp sans, tight spacing, no ornament. The product is
a precise tool — it should feel like one.

The "Trusty Squire" name carries a medieval theme. The rebrand keeps a *hint*
of it, deliberately confined to **two places only**:

1. **The logo** — a minimal geometric shield (single-weight outline, no fill).
2. **The voice** — a dry, terse "squire" register in copy.

Everything else is neutral. No parchment, no gold, no heraldry, no serif. If a
medieval flourish wants to appear anywhere else, the answer is no.

## Color

Dark-first. Near-black canvas, layered greys, one accent. The accent is wine —
it is both a restrained Linear-style accent and the quiet medieval nod, so it
does double duty and nothing else needs to.

| Token | Value | Role |
|---|---|---|
| `--color-bg` | `#0d0d10` | canvas |
| `--color-surface` | `#161619` | cards, panels, inputs |
| `--color-surface-raised` | `#1e1e23` | hover / elevated surfaces |
| `--color-border` | `rgba(255,255,255,0.08)` | hairline rules |
| `--color-border-strong` | `rgba(255,255,255,0.14)` | input / hover borders |
| `--color-text` | `#ededef` | primary text, headings |
| `--color-text-soft` | `rgba(237,237,239,0.64)` | secondary text |
| `--color-text-muted` | `rgba(237,237,239,0.40)` | tertiary text, placeholders |
| `--color-accent` | `#cf3a52` | links, focus, key figures, accents |
| `--color-accent-hover` | `#e0566c` | accent hover |
| `--color-accent-deep` | `#8a1a30` | filled primary-button base |
| `--color-accent-contrast` | `#ffffff` | text on a filled accent button |

**Accent discipline.** The accent appears on: links, the primary button, focus
rings, error text, the logo `{ }`, and at most one focal figure per view (e.g.
the dashboard spend number). It never colors headings or body text.

## Typography

One family, end to end: **Inter** (self-hosted via `next/font`). The ornamental
serif is gone — a single crisp sans is the Linear/Obsidian signature.

- **Headings** (`h1`–`h4`): Inter, weight 600, `letter-spacing: -0.02em`,
  color `--color-text`. Not accent-colored.
- **Body**: Inter, weight 400, `--color-text` / `--color-text-soft`.
- **Mono** (`--font-mono`): `ui-monospace` stack — code, the logo glyph.

## Logo

A minimal monochrome shield: the shield path as a single-weight outline
(`--color-text`, no fill), with the `{ }` mono glyph in `--color-accent`
centered inside. No inner double-line, no fill, two colors. The shield carries
the medieval hint; the `{ }` carries the developer identity.

Standalone icons (`public/logo.svg`, `favicon.svg`, the rasterized PNGs) add a
full-bleed `#0d0d10` background tile — a fill-less outline would vanish on a
light tab strip or home screen. Regenerate the PNGs with
`pnpm exec tsx scripts/rasterize-icons.ts` after any logo change.

## Shape & spacing

- Radii, tight: cards `rounded-lg` (8px), buttons/inputs `rounded-md` (6px).
- Borders do the work that fills used to — panels are delineated by a hairline
  `--color-border`, not a heavy background.
- Tailwind's default spacing scale; generous whitespace, no decoration.

## Voice

Terse, concrete, confident — Linear's register — with a dry squire underlayer
for charm. Lead with what the user gets. Cut filler. Keep the word "squire" as
the charm ("Your squire handles the rest.", "Every action your squire takes
lands here."); never inflate it into whimsy.
