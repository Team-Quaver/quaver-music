# UI / Frontend Taste

- Ghost/secondary (outline-style) buttons should always show a faint hairline border (light line color) rather than appearing borderless. Confidence: 0.7
- Prefers a single focus indicator on inputs/search boxes: keep the inner accent border highlight and remove any outer outline so there is no doubled focus ring. Confidence: 0.7
- Never ship native `<select>` elements: all dropdowns should be custom CSS-drawn (button + floating menu, reusing the project's v-menu pattern), because native `<option>` popups ignore page CSS and break theme fonts/colors. Confidence: 0.8
