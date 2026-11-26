---
name: Handy Calls Dev
description: Terra's replies as margin notes on the live transcript, in the Mac notch and the Terra panel.
colors:
  highlighter: "#f28cbb"
  handy-pink: "#f28cbb"
  handy-pink-light: "#faa2ca"
  shell-black: "#000000"
  shell-hover: "#232224"
  shell-rule: "#3a383b"
  paper: "#f1f0ed"
  paper-quiet: "#a9a6a2"
  phase-quiet: "#bbb7b3"
  slip: "#f4f4f2"
  ink: "#1b1b1d"
  ink-soft: "#3f3e42"
  ink-quiet: "#6e6c70"
  rule: "#d9d7d3"
  handy-text-light: "#0f0f0f"
  handy-surface-light: "#fbfbfb"
  handy-text-dark: "#fbfbfb"
  handy-surface-dark: "#2c2b29"
typography:
  headline:
    fontFamily: "Figtree, -apple-system, sans-serif"
    fontSize: "21px"
    fontWeight: 550
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Figtree, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  note:
    fontFamily: "Figtree, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.45
  note-panel:
    fontFamily: "Figtree, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.5
  body:
    fontFamily: "Figtree, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.65
  cite:
    fontFamily: "Figtree, -apple-system, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
  meta:
    fontFamily: "Figtree, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.01em"
    fontFeature: "\"tnum\" 1"
rounded:
  stroke: "2px"
  control: "6px"
  button: "8px"
  sheet: "12px"
  pill: "18px"
  shell: "18px"
  shell-open: "24px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  gutter: "16px"
  note-gap: "18px"
  slip-inset: "28px"
components:
  notch-shell:
    backgroundColor: "{colors.shell-black}"
    textColor: "{colors.paper}"
    rounded: "{rounded.shell}"
    padding: "0 8px 4px"
  notch-slip:
    backgroundColor: "{colors.slip}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "12px 14px 12px 28px"
  terra-panel:
    backgroundColor: "{colors.handy-surface-dark}"
    textColor: "{colors.handy-text-dark}"
    rounded: "{rounded.sheet}"
    padding: "16px 18px"
    width: "440px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.paper-quiet}"
    typography: "{typography.meta}"
    padding: "3px 0"
  button-quiet-hover:
    textColor: "{colors.paper}"
  button-pill:
    backgroundColor: "transparent"
    rounded: "{rounded.pill}"
    padding: "5px 12px"
  button-pill-hover:
    backgroundColor: "color-mix(in srgb, #f28cbb 15%, transparent)"
  button-commit:
    backgroundColor: "{colors.handy-pink}"
    textColor: "#2a1a22"
    rounded: "{rounded.button}"
    padding: "9px 11px"
  button-commit-hover:
    backgroundColor: "#f4a1c7"
  input-underline:
    backgroundColor: "transparent"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    padding: "7px 0"
  terra-mark:
    backgroundColor: "{colors.highlighter}"
    rounded: "{rounded.stroke}"
    width: "14px"
    height: "5px"
---

# Design System: Handy Calls Dev

## Overview

**Creative North Star: "The Margin Note"**

Terra does not chat. Each reply is a note written in the margin of the live transcript: one short line of ink, a single hairline rule at its left, the transcript words it rests on marked underneath with a stroke of Handy-pink highlighter, and the time it was written. The notch holds that note on a pale slip inside the black hardware shell; the Terra panel in the Handy window lays the same notes down one after another on the app surface, ruled the same way, with no box around any of them.

The system is quiet and dense in the way a well-kept notebook is. Graphite ink on a cool pale sheet in light contexts, pale ink on black in the notch and dark theme. Weight carries emphasis instead of size or color, so the note itself is the only medium-weight line on screen. Pink is the brand anchor and the only chroma, and it behaves like a pen: it marks, ticks and meters. It does not fill surfaces.

The world refuses chat bubbles, avatars as identity, and dashboard cards. Terra's identity is a short pink stroke, not a face.

**Key Characteristics:**
- One note, its cited words highlighted beneath it, its time. Nothing else competes.
- One 1px hairline margin rule per note; no per-reply boxes.
- Handy pink only as highlighter band, live tick, activity meter, caret and the single consent commit button.
- Figtree throughout; tabular numerals for times; weight, not size, for emphasis.
- Motion is one gesture: the highlighter drawing in under the cited quote.

## Colors

A near-monochrome graphite-and-paper palette with one chromatic voice, Handy pink, used as ink rather than fill.

### Primary
- **Highlighter Pink** (highlighter): the band drawn under cited transcript words on the slip, the live tick before the newest notch line, the activity meter bars, Terra's mark, the notch focus ring and caret, and the underline of a focused ask field in the notch.
- **Handy Pink** (handy-pink): the upstream brand accent (dark-theme logo primary). In the panel it is mixed down into the highlighter band (62% on light, 26% wash on dark), the caret, the button hover wash (15%), the focus ring on dark, and solid only on the consent commit button.
- **Handy Pink Light** (handy-pink-light): the light-theme logo primary; the panel's pink resolves to it when Handy runs light.

### Neutral
- **Shell Black** (shell-black): the notch shell. It matches the hardware notch and is never tinted.
- **Shell Hover** (shell-hover): the only hover fill on the shell, behind the small collapse and close controls.
- **Shell Rule** (shell-rule): the resting underline of the notch ask field.
- **Paper** (paper): pale ink on the shell: the peek line, the ask field text, footer controls on hover.
- **Paper Quiet** (paper-quiet): secondary ink on the shell: the top bar, placeholders, resting footer controls, and the tick of a note written from earlier context.
- **Phase Quiet** (phase-quiet): the phase word beside Terra's meter in the notch header.
- **Slip** (slip): the pale sheet inside the expanded notch that carries the note.
- **Ink** (ink): the note on the slip, and the focus ring on the slip, where pink is too faint.
- **Ink Soft** (ink-soft): the cited quote and the empty-state line on the slip.
- **Ink Quiet** (ink-quiet): the meta line (kind, time, freshness) and the sources toggle on the slip.
- **Rule** (rule): the slip's margin hairline and the sources toggle underline.
- **Handy Text / Surface, light and dark** (handy-text-light, handy-surface-light, handy-text-dark, handy-surface-dark): the panel and consent sheet inherit the app theme from theme.css. Their rules and quiet text are mixes of the current text color (rule 16%, quiet 64% to 82%), so they follow light and dark without new hexes.

### Named Rules
**The Highlighter Rule.** Pink marks words and states; it never fills a surface. The one exception is the consent commit button, because starting to share is the single action that must be unmistakable.

**The Black Shell Rule.** The notch shell is pure black (#000) to disappear into the hardware. Depth inside it comes from the pale slip, not from greys or gradients.

**The Ink Focus Rule.** Focus is drawn in pink on dark ground and in ink on light ground. Pink on the pale slip fails contrast.

## Typography

**Display Font:** none; the system has no display role.
**Body Font:** Figtree (with -apple-system, sans-serif)

**Character:** One humanist sans at small sizes, emphasis carried by weight steps (400, 500, 550, 600). It reads like a tidy hand rather than a headline.

### Hierarchy
- **Headline** (550, 21px, 1.2, -0.02em): the consent sheet's question only.
- **Title** (600, 15px): the panel heading; the notch header name at 600, 13px.
- **Note** (500, 15px, 1.45): the reply on the notch slip. `text-wrap: pretty`.
- **Note, panel** (500, 14px, 1.5): each reply in the panel.
- **Body** (400, 13px, 1.65 in the panel): the peek line, ask fields, consent copy.
- **Cite** (400, 12.5px, 1.6): the quoted transcript words, in ink soft on the slip.
- **Meta** (400, 11px, 0.01em, tabular numerals): the time, freshness and source status line; the question echo above a panel reply; privacy and status lines.

### Named Rules
**The Weight Carries It Rule.** The note is the only 500-weight line in its view. Do not raise emphasis with size, color or uppercase.

**The Tabular Time Rule.** Every time stamp uses tabular numerals so a column of notes reads cleanly.

## Layout

The notch is a three-column header sized to the hardware: name and Terra's mark right-aligned to the left of the camera, phase and meter to its right, with camera width, header height and surface width supplied at runtime. Collapsed, only the mark and meter show; peek adds one nowrap line of paper ink led by the live tick, ellipsized. Expanded, a fixed 288px detail region holds a top bar, the slip (scrolling, 12px top and bottom, 28px left inset so the note clears the 16px margin rule), the ask field and a footer row.

The panel is a single column, at most 440px wide, capped at the viewport height minus 200px, with the reply list scrolling in the middle and header and ask field pinned. Replies sit 18px apart, each indented 16px from its margin rule. Below 400px the panel padding drops to 14px and the footer stacks.

The spacing rhythm is 4, 8, 12, 16, with 18px between notes and the 16px gutter as the margin. Notes are separated by space and their own rule, never by dividers between them; a single top hairline separates earlier history from live notes.

## Elevation & Depth

The system is flat. Depth is tonal: a pale slip inside a black shell, a theme surface inside the window. The only shadow is a soft ambient drop under the floating consent sheet, which overlays the window and needs separation from it.

### Shadow Vocabulary
- **Consent lift** (`box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.28)`): the consent sheet only.

### Named Rules
**The Flat Note Rule.** Notes, slips and the panel carry no shadow. A lifted note would read as a card.

## Shapes

Corners soften with scale: 2px on strokes (the tick, Terra's mark, meter bars), 6px on small shell controls, 8px on the consent buttons, 12px on sheets (the slip, the panel, the consent sheet), 18px on the collapsed shell's lower corners, opening to 24px when expanded. Panel action buttons are 18px pills with a 1px hairline outline. The signature line is the 1px vertical margin rule, inset 16px on the slip and flush at each panel note's left edge. Fields are underlines, not boxes.

## Components

### Buttons
- **Quiet text controls (notch footer, sources toggle):** transparent, no border, meta size, paper quiet on the shell or ink quiet on the slip; hover moves to full paper or full ink. The sources toggle carries a rule-colored underline offset 3px.
- **Shell icon controls:** lucide icons at 16px (collapse, close) and 17px (send), 4px padding, 6px radius, transparent; hover fills shell hover. Send turns highlighter pink on hover.
- **Panel pills:** transparent with a hairline outline (current color at 26%), 18px radius, 5px 12px, 11px text; hover washes in 15% Handy pink. Disabled drops to 55% opacity.
- **Commit (consent only):** solid Handy pink, deep plum text (#2a1a22), 600 weight, 8px radius; hover lightens to an 82% tint of the theme pink (#f4a1c7 on dark), computed with color-mix rather than a second hex. The notch highlighter is the dark-theme pink token, since the shell is always black.
- **Focus:** 2px outline, highlighter on the shell, ink on the slip, accent ink (text color on light, pink on dark) in the panel at 3px offset.

### Inputs / Fields
- **Style:** an underline only. In the notch, a shell rule hairline under transparent paper text with a pink caret; in the panel, current color at 28%.
- **Focus:** the notch underline turns highlighter pink; the panel underline thickens to 2px in accent ink. No outline box.

### Margin Note (signature)
The reply unit in both surfaces. On the slip: meta line in ink quiet, the note at note weight, then the cited quote in ink soft with each cited span marked by the highlighter band (0.62em tall, sitting at 92% of the line, clone-decorated across wraps, 2px side padding). The band draws in left to right over 260ms on `cubic-bezier(0.16, 1, 0.3, 1)` after a 120ms delay, and is static under reduced motion. Further sources stay folded behind a quiet toggle. In the panel: question echo in meta, the note at note-panel weight, time in meta, first quote highlighted; on dark the band becomes a 26% wash behind the whole span with a 3px radius.

### Terra's Mark and Live Tick
Terra is identified by a 14 by 5px highlighter stroke (2px radius), never an avatar. The peek line's 12 by 4px tick is the same stroke: pink for the newest note, paper quiet for a note written from earlier context. Three 3px meter bars beside the phase word pulse at 1.2s while Terra thinks and flatten grey when stopped.

### Rating Row
Built in `src/components/calls/RatingRow.tsx` and `rating.css`. A quiet row after the cited quote, inside the notch slip and inside each live panel note: Useful (thumbs up), Wrong or unhelpful (thumbs down), and Terra missed something just now (flag). The flag marks a moment, not a reply, so in the panel only the newest note offers it. The row shows only while Terra is following live.
- lucide icons at 14px, stroke 1.75, each in a 28px hit area, transparent, no border, no emoji.
- Resting color is quiet ink (ink quiet on the slip, the panel's 64% quiet text); hover and selected move to full ink.
- Selected state (`aria-pressed`) sits on an 18 by 6px highlighter band under the icon (the 26% wash on dark).
- Each control carries an i18n aria-label. In the panel the selectors are two classes deep so the pill outline other panel buttons get does not apply.
- While a mark is saving, controls use `aria-disabled`, not `disabled`, so keyboard focus stays put and the notch does not collapse. A refused or failed mark shows "Mark not saved" in small ink beside the row.

## Do's and Don'ts

### Do:
- **Do** give every reply one 1px hairline margin rule and 16px of gutter, and separate replies by space (18px), not by boxes.
- **Do** mark cited transcript words with the highlighter band (0.62em at 92%), drawn in over 260ms in the notch and static under reduced motion.
- **Do** carry emphasis with weight (500 for the note) and keep times in tabular numerals.
- **Do** draw focus in ink on the pale slip and in pink on dark ground.
- **Do** use lucide line icons with an aria-label for icon-only controls.
- **Do** keep the notch shell pure black (#000) and let the slip carry the note.

### Don't:
- **Don't** render replies as chat bubbles, or put a box, card or shadow around an individual reply.
- **Don't** use an avatar or face as Terra's identity; use the pink mark.
- **Don't** fill surfaces or large areas with pink; the consent commit button is the only solid pink fill.
- **Don't** use emoji or glyph characters as icons.
- **Don't** add a display face or uppercase labels; Figtree at small sizes carries the whole system.
- **Don't** add motion beyond the highlighter draw-in, the shell's open and close, the peek reveal and the thinking meter.
