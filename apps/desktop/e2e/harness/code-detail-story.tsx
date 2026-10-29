// Standalone browser story for the "Detail level applies to code blocks" knob —
// the REAL `Markdown` component rendering a long fenced block, once under each
// value of `expandCodeBlocks`.
//
// This exists because the cap is a CSS selector aimed at DOM we do not own. The
// fenced block is rendered by `@streamdown/code`, so the rule in agent-ui.css
// matches on that plugin's `data-streamdown` parts; nothing in the type system or
// the build says whether those parts are still named that, still nested that way,
// or whether the element carrying the cap is the one that actually scrolls the
// code. Only a real render answers it — and the failure mode if the selector
// misses is silent (the block just renders full height, exactly as before).
//
// Both variants mount the same content so a diff between them is attributable to
// the pref alone.
//
// HARNESS LIMIT: this asserts the box geometry (capped and scrollable vs. not).
// Syntax highlighting and the copy button are the plugin's, not ours.

import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { createRoot } from "react-dom/client";
import { Markdown } from "../../components/agent-elements/markdown.tsx";
import "../../src/index.css";

/** Long enough that no cap value could accommodate it. */
const LONG_FENCE = ["```ts"]
	.concat(
		Array.from({ length: 300 }, (_, i) => `const line${i} = ${i}; // padding`)
	)
	.concat(["```"])
	.join("\n");

const CONTENT = `Here is the change:\n\n${LONG_FENCE}\n\nThat is all.`;

function Variant({
	expandCodeBlocks,
	testId,
}: {
	expandCodeBlocks: boolean;
	testId: string;
}) {
	return (
		<ChatDisplayPrefsProvider value={{ expandCodeBlocks }}>
			<div className="w-[520px] border border-border p-3" data-testid={testId}>
				<Markdown content={CONTENT} />
			</div>
		</ChatDisplayPrefsProvider>
	);
}

function Story() {
	return (
		<div className="flex items-start gap-6 bg-background p-4">
			<Variant expandCodeBlocks={false} testId="capped" />
			<Variant expandCodeBlocks={true} testId="full" />
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
