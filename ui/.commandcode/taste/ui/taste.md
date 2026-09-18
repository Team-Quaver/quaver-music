# UI / Frontend Taste

- Ghost/secondary (outline-style) buttons should always show a faint hairline border (light line color) rather than appearing borderless. Confidence: 0.7
- Prefers a single focus indicator on inputs/search boxes: keep the inner accent border highlight and remove any outer outline so there is no doubled focus ring. Confidence: 0.7
- User-facing hint/microcopy should be plain and non-technical: strip implementation jargon (e.g. "CSS font-family 列表", "内置默认栈") in favor of everyday phrasing that describes what the user sees and does. Confidence: 0.7
- Clear/dismiss buttons inside inputs should stay hidden by default and only appear on focus when the field actually has content (progressive disclosure, not always-visible chrome). Confidence: 0.6
- Never ship native `<select>` elements: all dropdowns should be custom CSS-drawn (button + floating menu, reusing the project's v-menu pattern), because native `<option>` popups ignore page CSS and break theme fonts/colors. Confidence: 0.8
- When an upstream/vendored asset (e.g. an icon path copied from a design-system bundle) deviates from the project's own visual conventions, prefers conforming it to the project's design language — redraw the path to the shared grid/ink-size/centering convention with a comment documenting the deviation — over keeping upstream fidelity or patching size ad-hoc at the call site. Confidence: 0.6
- Dividers/separators should be plain full-width (通栏) hairlines: no horizontal margin/padding or indentation to align with adjacent content — a simple unfussy line. Confidence: 0.7
