# Orbit interface guidelines

Orbit uses a compact neutral CRM interface with thin outline icons, restrained elevation, and light/dark themes. Keep the existing information hierarchy stable when changing implementations.

## Layout

- Desktop navigation is 240px wide. Page titlebars are 56px high.
- Dense index pages use a centered content region; wide tables, calendar views, and pipeline boards may use the available width.
- Search and filters share a compact utility row. Avoid repeating the route title in the body.
- Mobile layouts collapse navigation and let table areas scroll independently without widening the page.
- Preserve visible dialog actions when forms exceed the viewport height.

## Surfaces and type

- Use semantic custom properties from `src/styles.css`; both themes must support the same components.
- Keep neutral surfaces, clear primary/secondary text, subtle borders, and small rounded corners.
- Use original, concise shadow rules for elevation. Do not copy style definitions from a noncommercial reference implementation.
- Use tabular numerals for changing numeric data and retain font smoothing.

## Icons and controls

- Use the exports in `src/components/icons.tsx`, backed by Lucide. New icons must come from that permissively licensed library or include documented compatible provenance.
- The default icon viewport includes padding to match the compact 20px control footprint. Stroke weight and dimensions can be overridden with standard SVG props.
- Icon-only controls need an accessible label on the control. Decorative icons should stay out of the accessibility tree.
- Keep keyboard operation, focus visibility, disabled states, modal focus containment, and reduced-motion support.

## Verification

Compare dense tables and dialogs on desktop/mobile in both themes. Exercise select menus, modal close/save actions, workspace switching, and empty states. A source/license replacement should preserve user workflows and page geometry even when the artwork changes slightly.
