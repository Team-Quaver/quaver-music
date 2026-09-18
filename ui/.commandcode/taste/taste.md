# Taste

- Communicates in Simplified Chinese; prefers replies written in Chinese. Confidence: 0.8
- Prefers diagnosis before edits: when reporting a problem, expects the agent to investigate root cause first and explicitly hold off on changing code ("先调查，先别改") until the user picks the fix approach. Confidence: 0.8
- Expects icons in a set/navigation row to look visually consistent in actual rendered size (optical ink size), not just share the same viewBox/size attribute. Confidence: 0.6
- Treats vendored CSS (e.g., verse component styles) as read-only: fixes/overrides go in the project's own stylesheet (verse-app.css, loaded last) rather than editing vendor files. Confidence: 0.6
