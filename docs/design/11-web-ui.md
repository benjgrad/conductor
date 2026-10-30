# 11 · Web UI: tokens, breakpoint, phone layouts

The web app (`packages/web`) has one desktop layout and, below a phone breakpoint, a phone layout. This doc covers the design tokens, the breakpoint, what changes on a phone, and the touch rules. The review behind it, with before and after screenshots, is [docs/qa/ux-review/README.md](../qa/ux-review/README.md) (the "Mobile-friendly UX" ticket, which replaced UX-12).

## Tokens

`packages/web/src/styles.css :root` holds every token. Colours follow `prefers-color-scheme` (a dark block re-sets them), so components never need their own dark rules.

| Group | Tokens | Values |
|---|---|---|
| Spacing | `--space-1` … `--space-6` | 4 / 8 / 12 / 16 / 24 / 32 px |
| Type | `--text-xs/sm/base/md/lg/xl` | 11 / 12 / 14 / 15 / 18 / 20 px |
| Radius | `--radius-sm/md/lg/pill` | 4 / 6 / 10 / 999 px |
| Shadow | `--shadow-1` (floating pill), `--shadow-2` (menus) | |
| Layers | `--z-sticky` 5, `--z-menu` 20, `--z-sheet` 40 | |
| Touch | `--tap` | 44 px (WCAG 2.5.5) |
| Colour | `--bg --panel --text --muted --border --border-strong --accent --on-accent` and the status pairs (`--warn`/`--warn-bg`, `--ask`/`--ask-bg`, `--ok`, `--diff-*`, `--user-*`, `--tool`, `--code-*`) | |

Contrast rules:
- `--muted` text meets AA (4.5:1) on `--bg` and on `--ask-bg`.
- Text on an `--accent` fill uses `--on-accent`: white in light mode, `--bg` in dark mode, where white on the lighter accent is only 2.65:1.
- Field edges use `--border-strong` (about 3:1, WCAG 1.4.11). `--border` is for dividers and cards.

Only the rules this design touched use the spacing, type and radius tokens so far. Moving the rest of the CSS onto them is a follow-up.

## Breakpoint

`MOBILE_QUERY = '(max-width: 699.98px)'` (`components/useMediaQuery.ts`).
- **JS** uses `useIsMobile()`, which returns false without `matchMedia`, so jsdom tests render the desktop layout unless they call `mockViewport(width)` from `src/test/match-media.ts`.
- **CSS** uses the same `@media (max-width: 699.98px)`.
- **Desktop is unchanged** above the breakpoint, apart from the token colour fixes and the top bar, which is sticky at every width. `useElementHeightVar` sets `--topbar-h` on `<html>` from the bar's measured height (it is taller on a coarse pointer), so the sticky desktop session panel sits 12 px below the bar. The CSS falls back to 49 px.
- Tablets (700 px and up) get the desktop layout, plus the touch sizes on a coarse pointer.

While the phone layout is on, `useVisualViewportHeight` sets `--vvh` on `<html>` from `visualViewport.height`. Full-screen surfaces use `height: var(--vvh, 100dvh)`, so they end above the on-screen keyboard. `100vh` is always paired with a `100dvh` override.

## Phone layout

| Surface | Phone behaviour |
|---|---|
| Top bar | UX-11's compact mode: `App`'s `compact` prop defaults to `useIsMobile()`, and the prop still overrides it. The title becomes the logo mark; the text "Conductor" stays as the heading's accessible name. Add a machine and Help move into the account menu (`AccountMenu extraItems`). The bar is sticky (as it is at every width) and padded by `env(safe-area-inset-top)`. |
| Board | One column at a time, chosen in a `role=tablist` switcher that scrolls sideways (title and count per column; the active tab is scrolled into view). It opens on Needs input when that column has cards, else the first non-empty column, until the user picks one. A horizontal swipe (more than 50 px, and 1.5× more sideways than vertical) moves to the next or previous column. The board is `touch-action: pan-y`, so vertical scrolling is never blocked. |
| Detail panel | `DetailPanel fullScreen`: fixed over the whole screen with safe-area padding. The board isn't laid out behind it. A 44 px Back button ("Back to board") replaces `×`, the tabs share the width, and the composer is pinned at the bottom of `--vvh`. |
| Create ticket | `CreateTicketForm sheet`: a full-screen modal dialog ("New ticket", with Close, and Escape also closes it). The fields are stacked, Kind is two segmented buttons (the radios stay for keyboard and screen readers), Priority has a numeric keypad, and the footer is sticky. The footer holds Create ticket and, while it is disabled, what's still needed. The editor's max height is half of `--vvh`, with a narrower BlockNote gutter. |
| Machines, Admin | Tables scroll inside their own box (`display: block; overflow-x: auto; position: relative`), never the page. |
| Workflow | A "best on a larger screen" note; the diagram already scrolls in its own box. |

`index.html` sets `viewport-fit=cover` and `interactive-widget=resizes-content`, and has a `theme-color` meta for each scheme.

## Touch rules

In `@media (pointer: coarse), (max-width: 699.98px)`:
- Buttons, nav links, tabs, menu items, inputs and selects are at least `--tap` tall. The card's title and preview buttons are excluded: they are text inside a tappable card.
- The panel's Back and Close buttons, and the sheet's Close, are at least `--tap` wide.
- The Kind labels are 44 px rows, and the composer's send button is 44 × 44.

On a phone, every `input`, `select` and `textarea` is 16 px, because iOS Safari zooms into any field smaller than that.

There must be no horizontal page scroll at 360 px. `scripts/ui-screenshots.js` checks it in `metrics.json` (`horizontalOverflow`).

## Not covered

- Browser Back doesn't close the panel or the sheet.
- The iOS keyboard, `dvh` and standalone mode can't be verified in Chromium emulation; they need a real phone.
- BlockNote on touch is unverified. The Plain markdown toggle is the fallback.
