# CREBAIN Interface Brand

_Status: inherited from the existing product UI_

CREBAIN uses an austere, workstation-dense tactical interface. It is deliberately
not a generic shadcn theme: the application is a full-viewport Three.js workspace
with compact movable panels, German-first labels, and restrained status color.

## Palette

- Canvas: `#0a0a0a`
- Panel: `#0c0c0c`
- Raised panel/header: `#101010` to `#141414`
- Hairline border: `#1a1a1a`; interactive border: `#303030` to `#505050`
- Primary text: `#c0c0c0` to `#d0d0d0`
- Secondary text: `#808080` to `#a0a0a0`
- Muted text: `#505050` to `#707070`
- Healthy/ready: `#3a6b4a`
- Warning/provisional: `#9b8a5a`
- Destructive/error: `#8b4a4a`
- Informational action: `#5a8a9b`

Color communicates state; it is not decorative. Every status also needs a text
label, and focus indicators must remain visible against the dark surfaces.

## Typography and density

- Use the existing monospace product face for operational UI and tabular values.
- Keep headings uppercase with measured letter spacing.
- Preserve the `--ui-scale` system and em-based panel sizing.
- Dense information is appropriate, but interactive targets remain at least 40 px
  and critical status/error copy must meet readable contrast.

## Shape and motion

- Square corners, thin borders, and flat surfaces are the default.
- Avoid decorative gradients, glass effects, oversized cards, and pill-shaped
  controls.
- Motion should explain state changes, stay brief, and honor reduced-motion
  preferences. Loading, selection, and destructive actions need explicit states.

## Voice

The interface is terse, factual, and German-first. Capability labels must describe
observed runtime state, never assumed readiness. Experimental, unavailable, and
partially restored states are named directly rather than softened into success.
