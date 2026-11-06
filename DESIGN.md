---
name: Enquiry to Paid
description: Enamel-on-tin sign painting for a WhatsApp quoting agent — a dark board ground, a cream rate board, and one gold instruction.
colors:
  enamel: "#0e3a86"
  enamel-deep: "#072558"
  enamel-lit: "#1a4ea8"
  board: "#f3e8d2"
  board-dim: "#d9c8a6"
  gold: "#f8b616"
  signal: "#e23b1d"
  signal-deep: "#9e2410"
  ink: "#0f0e08"
  faded: "#86a3d2"
typography:
  display:
    fontFamily: "Anton, Anton Fallback, Arial Narrow, sans-serif"
    fontSize: "clamp(2.5rem, 7.6vw, 5.5rem)"
    fontWeight: 400
    lineHeight: 0.9
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Anton, Anton Fallback, Arial Narrow, sans-serif"
    fontSize: "clamp(1.95rem, 5.2vw, 3.5rem)"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "-0.02em"
  devanagari:
    fontFamily: "Yatra One, Yatra One Fallback, serif"
    fontSize: "clamp(1.2rem, 3.4vw, 1.75rem)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "normal"
  title:
    fontFamily: "Anton, Anton Fallback, Arial Narrow, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.01em"
  body:
    fontFamily: "Mukta, Mukta Fallback, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Anton, Anton Fallback, Arial Narrow, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0.12em"
  arabic:
    fontFamily: "Cairo, Cairo Fallback, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  numeric:
    fontFamily: "Mukta, Mukta Fallback, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "'tnum' 1"
rounded:
  none: "0px"
  pill: "999px"
spacing:
  gutter: "1.25rem"
  panel-pad: "1.5rem"
  panel-pad-lg: "1.75rem"
  section-y: "5rem"
  section-y-lg: "6rem"
  container: "78rem"
components:
  button-primary:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "{rounded.none}"
    padding: "0.875rem 1.5rem"
  button-primary-disabled:
    backgroundColor: "{colors.board-dim}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "1rem 1.75rem"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0.625rem 1.25rem"
  button-outline-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.gold}"
  input-tel:
    backgroundColor: "{colors.enamel-deep}"
    textColor: "{colors.board}"
    rounded: "{rounded.none}"
    padding: "0.875rem 1rem"
  panel-board:
    backgroundColor: "{colors.board}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "{spacing.panel-pad-lg}"
  panel-dark:
    backgroundColor: "{colors.enamel-deep}"
    textColor: "{colors.board}"
    rounded: "{rounded.none}"
    padding: "{spacing.panel-pad}"
  chip-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.gold}"
    rounded: "{rounded.none}"
    padding: "0.25rem 0.75rem"
  trade-strip:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0.875rem 0"
---

# Design System: Enquiry to Paid

## Overview

**Creative North Star: "The Sign Painter's Board"**

Enamel on tin. The system is built from the hand-painted trade boards that hang above the businesses this product is sold to — banquet halls, studios, salons — and it behaves like paint rather than like glass. A dark enamel ground covers roughly 60% of any screen; a cream board panel carries the content that matters on roughly 30%; cadmium gold and vermilion are the signal, held to the remaining 10%. Light in this world is a single warm sodium-vapour pool from above, not a rim glow and not a gradient mesh. Depth comes from paint sitting proud of the ground: a gloss band across a panel's top edge, an offset cast shadow below it, and an inset ink-and-gold keyline where a real board carries its border.

Letterforms are the system's most load-bearing material. Display type is condensed caps with an ink shadow thrown down-right and a thin cream highlight up-left — the actual grammar a sign painter uses to make lettering stand off a wall. That treatment belongs to type and only to type; no block, panel, or button wears it. The page carries four scripts by design (Latin, Devanagari, Perso-Arabic, Malayalam) because the audience reads them, so type coverage is a structural requirement rather than a nicety.

The ground is user-selectable: six enamel grounds a real shop would stock, every one of them dark, because the cream lettering and the cream panels depend on a dark field to read. The palette switcher is part of the system, not a demo toy; every colour token including the signal-on-cream variant and the four ambient-light tints is redefined per ground. The build explicitly refuses the dark-SaaS treatment: no glass, no neon on charcoal, no violet gradient, no soft 12px radius everywhere.

**Key Characteristics:**
- Dark enamel ground at ~60%, cream board at ~30%, gold and vermilion signal at ~10%
- Zero corner radius on every surface; squared edges, painted borders
- Painted letterform shadow and highlight on display type only
- One fixed sodium-vapour light pool; no per-element glow
- Six interchangeable dark grounds, each retinting the whole token set
- Tabular figures wherever money or clock time appears
- Motion is scarce: hero arrival, one cooling loop, one trade marquee

## Colors

Six shop-stocked enamel grounds, each pairing a dark field with the same cream board, a warm gold and a hot signal; the values below are the default Cobalt ground and every one of them is re-declared per ground.

### Primary
- **Cobalt Enamel** (`{colors.enamel}`): the page ground. Set on `body`, covers the majority of every viewport, and is the field all painted lettering sits on.
- **Deep Cobalt** (`{colors.enamel-deep}`): the recessed value. Dark panels, the phone input's well, the scrollbar track — anything that should read as cut into the ground rather than laid on it.
- **Lit Cobalt** (`{colors.enamel-lit}`): reserved for the ambient lift tint in the sodium pool. It is a light colour, not a surface colour.

### Secondary
- **Cadmium Gold** (`{colors.gold}`): the single instruction colour. Primary button fill, the trade strip's full-bleed band, the Devanagari line, the brush stroke under the price, the keyline's outer ring, selection highlight, caret, scrollbar thumb and focus ring. It is the colour of the one thing to do next.
- **Vermilion Signal** (`{colors.signal}`): cost and refusal. Used on the dark ground for "never answered", the form's error border and message, and the refusal badge's border and text. Never used as a large fill.
- **Brick Signal** (`{colors.signal-deep}`): the darkened signal for signal-coloured text set on the cream board, where bright vermilion fails 4.5:1. Same role, different ground.

### Neutral
- **Board Cream** (`{colors.board}`): the painted board. Cream panels, and all body copy set on the dark ground (commonly at 70–90% alpha for secondary and tertiary ranks).
- **Dimmed Board** (`{colors.board-dim}`): the one disabled-state value — a board that has not been painted yet. Disabled primary button fill.
- **Signwriter's Ink** (`{colors.ink}`): the near-black the lettering shadow is thrown in. All text on cream panels, the inner keyline ring, hard 2–3px painted borders, and the ink chips that carry gold type. Internal dividers are this colour at 15–30% alpha.
- **Faded Blue** (`{colors.faded}`): paint that has lost its light. The terminal colour of a cooling enquiry, and the low-contrast border/divider value on the dark ground (25–55% alpha).

### Named Rules

**The Dark Ground Rule.** Every ground in the system is dark. The cream board, the painted highlight, and the gold signal all depend on it; a light ground breaks all three at once. A new palette that is not dark is not a palette in this system.

**The One Instruction Rule.** Gold marks the single next action on a surface and the two places the brand speaks (the Devanagari line, the trade strip). If a screen has two gold calls to action, one of them is wrong.

**The Signal-On-Cream Rule.** Signal-coloured text on the cream board uses the brick variant, never the bright vermilion. Vermilion is for the dark ground only.

**The Light-Is-One-Lamp Rule.** Ambient light is one fixed sodium pool composed of three radial tints plus one foot-glow at the closing section. Individual elements do not glow, and no element gets its own halo.

## Typography

**Display Font:** Anton (with the next/font-generated Anton Fallback, then Arial Narrow)
**Devanagari Display:** Yatra One (with Yatra One Fallback, then serif)
**Body Font:** Mukta (with Mukta Fallback, then system-ui) — covers Latin and Devanagari
**Arabic Font:** Cairo (with Cairo Fallback, then system-ui)

**Character:** Anton at hoarding scale is the painted board shouting one line; Mukta underneath is plain, measured, and legible in daylight on a phone. The pairing is loud at the top and quiet in the body, with Yatra One carrying the Hindi line as a second voice rather than a translation.

Font families are referenced in Tailwind's `@theme` by literal family name, not through next/font's `var(--font-*)` indirection. The variables are still declared on `<body>`, but the theme does not read them: that indirection silently fell back to system faces, so the literal names plus next/font's generated `* Fallback` families are the shipped source of truth. Do not "fix" this by routing `@theme` back through the CSS variables.

### Hierarchy
- **Display** (Anton 400, `clamp(2.5rem, 7.6vw, 5.5rem)`, line-height 0.9, tracking -0.025em, uppercase, balanced wrap): the hero headline only. Always carries the painted treatment.
- **Headline** (Anton 400, `clamp(1.95rem, 5.2vw, 3.5rem)`, line-height 0.95, tracking -0.02em, uppercase): every section `h2`, capped at 20–26ch. The closing call runs larger (`clamp(2.1rem, 6.4vw, 4.25rem)`, line-height 0.92) and one pricing statement runs as gold-painted display (`clamp(2.25rem, 7vw, 3.75rem)`).
- **Devanagari** (Yatra One 400, `clamp(1.2rem, 3.4vw, 1.75rem)`, tight leading, gold): the Hindi line that follows a display or closing headline. One per section at most.
- **Title** (Anton 400, 1.25–1.5rem, uppercase, tracking ~0.01–0.015em): panel and step headings on cream; definition terms in gold on the dark ground.
- **Body** (Mukta 400, 1.0625rem / 1.55; lead paragraphs step to 1.125rem at `sm`): all prose. Measure is capped explicitly, 42–54ch for lead copy and 62–72ch for footnotes and long list items.
- **Label** (Anton 400, 0.6875–0.875rem, uppercase, tracking 0.06em–0.18em): panel eyebrow lines, table headers, status badges, chips, trade-strip items. Tracking widens as the label gets smaller.
- **Numeric** (`font-variant-numeric: tabular-nums` plus `"tnum" 1`): every price, time, phone number and benchmark figure, in both Anton and Mukta contexts.

### Named Rules

**The Paint-Only-Letters Rule.** The painted ink shadow and cream highlight apply to type and nothing else. A panel, button, chip or image with a hard offset shadow is not this world — that is the costume version of it.

**The Script-Coverage Rule.** Latin and Devanagari run through Mukta; Devanagari display runs through Yatra One; Perso-Arabic runs through Cairo. A new surface adding a script must add the face, not let the browser substitute. Layout must tolerate RTL.

**The Measure Rule.** Prose carries an explicit max-width in `ch`. Nothing in this system runs full container width as a paragraph.

## Layout

A single centred column, `78rem` max, with a gutter of `max(1.25rem, env(safe-area-inset-left))` so the board never clips into a notch. Sections are stacked at `5rem` vertical padding, `6rem` from `sm` up; the hero opens tighter (`3.5rem` top) and the closing call breathes wider (`7rem` at `sm`). There is no navigation bar and no header chrome — the hoarding is the first thing.

Two-column sections use deliberately uneven splits at `lg` and collapse to one column below it: `1.08fr / 0.92fr` for the hero, `1.05fr / 0.95fr` for pricing, `1fr / 0.85fr` for the refusal. Gaps run `2.5rem` stacked, `3.5–4rem` side by side. Card grids go 1 → 2 → 4 columns (`sm`, `lg`). The internal rhythm inside a block is a repeating `1.25rem / 1.5rem / 1.75rem` step with `2.5–3rem` between a heading group and the structure under it.

The pipeline and comparison are one continuous board subdivided by painted keylines, not a row of separate cards — a real board gets divided, not multiplied. The wide comparison table keeps a `56rem` minimum and scrolls horizontally inside its panel rather than reflowing into stacked cards. The palette switcher is a fixed bottom panel (centred on mobile, right-aligned from `sm`) sitting above a safe-area-aware inset, and the footer reserves `8rem` of bottom padding so it never covers content.

### Named Rules

**The One Board Rule.** Related steps live on one panel divided by dashed ink keylines. Reach for a second panel only when the content is genuinely a different board.

**The Safe-Gutter Rule.** Horizontal padding and fixed-element insets are always `max(<value>, env(safe-area-inset-*))`. The audience is on a phone, one-handed.

## Elevation & Depth

Hybrid, and physical rather than atmospheric: paint sits proud of tin. Every raised surface combines three cues — a 1–2px white inset along the top edge (the wet highlight), a gloss gradient band falling off by 38–40% of the panel's height, and a soft offset cast shadow below. Nothing floats, nothing blurs its backdrop, and there is no backdrop-filter anywhere in the system. The one ambient effect is the fixed sodium pool behind all content at `z-index: 0`, with the page body lifted to `z-index: 10` above it.

### Shadow Vocabulary
- **Cream panel** (`box-shadow: 0 2px 0 rgba(255,255,255,0.35) inset, 0 14px 28px -10px rgba(5,18,44,0.55), 0 3px 7px -3px rgba(5,18,44,0.4)`): the painted board laid on the ground. Paired with a 176° white-to-transparent gloss gradient over the cream fill.
- **Dark panel** (`box-shadow: 0 1px 0 rgba(255,255,255,0.14) inset, 0 14px 30px -12px rgba(3,12,32,0.7)`): the recessed deep-enamel variant, same construction at lower gloss.
- **Keyline** (`box-shadow: 0 0 0 2px var(--color-ink) inset, 0 0 0 7px var(--color-gold) inset`): the inset ink-then-gold double border a real board carries. Applied to the hero rate board, the refusal panel, and the sent-state panel — the three surfaces that are literally boards.
- **Button lift** (`box-shadow: 0 12px 24px -10px rgba(4,14,38,0.65–0.7)`): under the gold primary action only; removed entirely when disabled.
- **Focus ring** (`outline: 3px solid var(--color-gold); outline-offset: 3px`): global, on the gold token, so it retints with the ground.

### Named Rules

**The No-Glass Rule.** No backdrop blur, no translucent frosted surfaces, no neon rim light. Depth is gloss, highlight and cast shadow — the properties of wet enamel.

**The Keyline-Means-Board Rule.** The inset ink-and-gold keyline marks a surface that represents an actual painted board. A generic content panel gets the gloss and the cast shadow without it.

## Shapes

Zero radius, everywhere, on every surface: panels, buttons, inputs, chips, badges, swatches, table cells. The only curve in the system is the scrollbar thumb's pill (`999px`). Form language is rectangular and hand-cut.

Borders carry structure where radius would normally do the work. Heavy painted edges are 2–3px solid ink or cream (`border-y-[3px]` on the trade strip, `border-[3px]` on the phone input, `border-2` on the outline button and the active swatch). Internal subdivisions are either a dashed ink line at 25–30% alpha (inside cream panels) or a solid faded-blue line at 25% alpha (on the dark ground). The primary action sits on a cream panel's bottom edge above a solid 2px ink rule — the edge of the board is where the instruction goes.

Chat bubbles are squared blocks tinted off the surrounding surface (`ink/8` on cream, `board/10` and `gold/18` on dark), capped at 92–94% width and alternated left/right by sender. Icon geometry is squared too: authored SVG at a consistent 1.75–2.25px stroke with `stroke-linecap: square`, no rounded caps.

### Named Rules

**The Zero-Radius Rule.** Nothing in this system has rounded corners. A radius on a panel, button, chip or avatar reads as a web app and breaks the material.

**The Border-Does-The-Work Rule.** Separation comes from a painted rule — 2–3px solid for structure, dashed ink for internal division — not from radius, not from a drop shadow between siblings.

## Components

### Buttons
- **Shape:** squared, no radius (`0px`).
- **Primary:** gold fill, ink text, Anton uppercase at 1.125rem with 0.015em tracking, `0.875rem 1.5rem` padding (the closing-form variant runs `1rem 1.75rem`), an authored brush icon at `1.25rem` on the trailing edge, and the button-lift shadow.
- **Hover / Focus:** translates up 2px over 200ms `ease-out`; returns flat on `:active`. Focus uses the global 3px gold ring at 3px offset. No colour change on hover — the paint does not change colour, the board tilts.
- **Disabled:** dimmed-board fill, ink text at 80%, shadow and lift both removed, `not-allowed` cursor.
- **Outline:** 2px ink border on cream, ink Anton caps at 0.875rem/0.06em tracking, transparent fill; on hover the fill inverts to ink with gold text. Used for the secondary "start over" action.

### Chips and Badges
- **Ink chip:** solid ink block with gold Anton caps at 0.6875–0.875rem, 0.1–0.12em tracking, `0.25rem 0.75rem` padding. Marks an assertion the system stands behind ("quoted from your rules", "done").
- **Outline signal chip:** 2px vermilion border with vermilion text, transparent fill. Marks a refusal.
- **Outline neutral chip:** 2px cream border at 45% alpha with cream text at 80%. Marks future work.
- **Language pill:** 2px faded-blue border at 55% alpha, cream text at 85%, each item set in the font for its own script.

### Cards / Containers
- **Corner Style:** squared (`0px`).
- **Background:** cream board for content the reader is meant to act on; deep enamel for content that is losing or has lost its value.
- **Shadow Strategy:** the cream-panel or dark-panel stack from Elevation & Depth; the keyline added only on surfaces that are literal boards.
- **Border:** none on the outside — the shadow and gloss separate it. Internal divisions use dashed ink at 25–30%.
- **Internal Padding:** `1.25rem` at the smallest, `1.5rem` standard, `1.75rem` at `sm` and above.

### Inputs / Fields
- **Style:** 3px cream border at 70% alpha over a deep-enamel well, cream text at 1.125rem, tabular figures, squared corners, `0.875rem 1rem` padding. Placeholder is cream at 65%. The field is a slot cut into the ground, not a raised card.
- **Focus:** global 3px gold outline at 3px offset; gold caret.
- **Error:** border swaps to vermilion, `aria-invalid` set, and a vermilion message is wired via `aria-describedby`. The error clears on the next keystroke.

### Signature Component: The Rate Board
The hero's right-hand panel is the system's thesis in one object: a cream board with the keyline, an eyebrow label in ink Anton caps at 0.18em tracking, the inbound enquiry as a squared tinted bubble above a dashed rule, then the price at `clamp(2.4rem, 8vw, 3.9rem)` in tabular Anton with a smaller-set rupee mark and an authored brush stroke in gold laid under it. Below the price, a line-item definition list in tabular figures separated by hairline ink rules; below that, the ink chip plus the elapsed time; and on the bottom edge, above a solid 2px ink rule, the primary action. Worked-example disclosure sits last, in ink at 65%.

The underline is `src/components/site/brush-stroke.tsx` — an authored two-path filled contour, heaviest where the brush lands and tapering where the bristles lift, with `preserveAspectRatio="none"` so it stretches to the number's width. It is a filled contour, not a stroked line, because a stroked line is a ruler and this world has none. It is not a highlighter component.

### Signature Component: The Trade Strip
A full-bleed gold band with 3px ink rules top and bottom, carrying trade names in ink Anton caps at 0.06em tracking, each followed by a small vermilion star. It scrolls on a 34s linear marquee with zero gap and pauses on hover. It is the one place gold covers a large area, and it works because it is a band rather than a surface.

### Signature Component: The Cooling Enquiry
Dark panels whose timestamp animates from gold with a warm 18px glow to faded blue over 5.5s on an alternating infinite loop, staggered 0.5s per card via inline `animation-delay`. Under `prefers-reduced-motion: reduce` the animation is removed and the timestamp is simply set to faded blue — the meaning survives without the motion. The same media query reduces the sodium pool to its single warm radial.

### Signature Component: The Palette Switcher
A fixed cream panel at the bottom of the viewport holding an Anton caps toggle and six squared `2rem` swatches. Each swatch shows its ground as the fill with a `0.5rem` gold bar along the bottom edge; the active one gets a 2px ink border plus an offset cream outline ring 5px outside itself, and all six lift 2px on hover. Choice writes `data-palette` on `<html>`, persists to `localStorage`, and is re-applied by an inline boot script before first paint so the page never flashes the default ground. Each swatch carries a visually hidden name and note.

### Browser Surfaces
Selection is gold on ink. Caret is gold. The scrollbar is 11px with a deep-enamel track and a gold pill thumb inset by a 3px deep-enamel border; `scrollbar-color` and `scrollbar-width: thin` cover Firefox. All of these read from palette tokens, so they retint with the ground. Browser chrome is part of the board.

### Motion, as built
- Hero arrival only: a staggered blur-fade on each hero element (`0.05s` through `0.72s`, offsets 6–18px, blur 4–10px). No other section has an entrance.
- One looping animation in the system: the cooling timestamp.
- One continuous animation: the trade marquee.
- State transitions are 150–200ms `ease-out`, and are either a 2px lift or a colour swap.

**The One-Arrival Rule.** Entrance animation happens once, on the hero. Sections below do not fade in as you scroll. A page where every section arrives is a page that never settles.

## Do's and Don'ts

### Do:
- **Do** keep the ground dark, the cream board at roughly 30% of the surface, and gold plus vermilion inside roughly 10%.
- **Do** use the painted shadow-and-highlight treatment on display and headline type, and only there.
- **Do** set every surface at zero radius and let 2–3px painted borders and dashed ink rules do the separating.
- **Do** use the brick signal variant for signal-coloured text on the cream board, and bright vermilion only on the dark ground.
- **Do** put the primary action on the bottom edge of the board that carries the number, above a solid 2px ink rule.
- **Do** set every price, time, phone number and benchmark figure in tabular figures.
- **Do** cap prose measure in `ch` and set each language's text in the font that covers its script.
- **Do** read every colour, including browser-chrome colours, from the palette tokens so a new ground retints the whole surface.
- **Do** give any new looping or revealing animation a `prefers-reduced-motion` branch that preserves the meaning statically.
- **Do** draw new icons as authored SVG at 1.75–2.25px stroke with square caps.

### Don't:
- **Don't** introduce a light ground. The cream board, the painted highlight and the gold signal all fail on one.
- **Don't** put a radius on anything. No panel, button, chip, input or avatar.
- **Don't** give a panel, button or image a hard offset shadow — that treatment belongs to letterforms. Panels get gloss plus a soft cast shadow.
- **Don't** add backdrop blur, frosted glass, neon rim light, or a violet gradient. The build exists to refuse the dark-SaaS page.
- **Don't** put two gold calls to action on one surface.
- **Don't** use bright vermilion as a large fill, or as text on cream.
- **Don't** add a per-section entrance animation, a per-element glow, or a second ambient light source.
- **Don't** ship an icon from a library or a Unicode glyph where an icon belongs; the icon set is authored SVG.
- **Don't** route the `@theme` font families back through next/font's `var(--font-*)` variables — that indirection silently fell back to system faces.
- **Don't** add a system display face or a generic sans as a display fallback beyond the chain already set.
- **Don't** split a sequence of related steps into separate cards when one divided board will carry them.

### Known inconsistencies in this build

Recorded as defects, not as rules:

- **`signal-deep` has no utility.** The token is declared only inside the `:root[data-palette=…]` blocks and never in `@theme`, so Tailwind generates no `text-signal-deep` or `bg-signal-deep` class. The pipeline's "today" lines, the comparison's cross marks, and the status section's "now" badge and "nothing to log into" chip therefore ship with no colour applied and inherit instead. The token's intent is correct and is recorded above; the wiring is not. Fix by adding `--color-signal-deep` to the `@theme` block, not by changing the usages.
- **One hard-coded green.** The comparison's affirmative tick uses a literal `#1b6b3a`, which is outside the palette and does not retint with the ground. It is the only colour in the build that escapes the token set; it is not a system token and should not be copied.
- **Vestigial shadcn token block.** The default shadcn/Radix neutral scale (`--background`, `--primary`, `--chart-*`, `--sidebar-*`, both light and `.dark`) is still declared in `globals.css` and still referenced by the `@theme inline` block, but no shipped surface uses it. It is dead weight, not a second system; do not design against it.
- **Duplicated colour declarations.** The enamel tokens are declared twice — once in the `@theme` block and again in the default `:root` palette block. The palette block is the effective source of truth for the Cobalt ground; the `@theme` copy exists so Tailwind generates the utilities.
