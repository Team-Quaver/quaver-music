# Taste

- Communicates in Chinese (Simplified) when giving instructions. Confidence: 0.8
- For overflowing long text (e.g. descriptions), prefers an in-place scrollable area (fixed height, fade mask, thin scrollbar) over truncation with an expand/collapse toggle — explicitly rejected the existing "展开" button ("不要展开"). Confidence: 0.7
- When reporting a UI problem, asks for root-cause analysis first ("分析一下，为啥…") — wants the *why* explained before any code change, not an immediate patch. Confidence: 0.6
- Once a fix has been proposed and accepted ("修一下我看看行不行"), wants it applied directly with minimal ceremony — then the user self-verifies visually (e.g., refreshes the page) and iterates, rather than wanting lengthy post-change explanations. Confidence: 0.6
- Has a sharp eye for fine visual polish: notices and precisely describes subtle pixel-level defects (content sitting a few px low, outer padding feeling cramped while inter-row gap feels loose). Expect careful, quantified CSS diagnosis over guess-and-check tweaks. Confidence: 0.6
