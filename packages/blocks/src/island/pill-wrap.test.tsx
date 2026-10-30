// The pill surfaces truncate to a single line by default, which is what a
// fixed-height host (the web island's 62px suggestion shape) needs. The desktop
// island measures its content and grows the shape to fit it — so it opts into
// `wrap`, and truncation MUST be gone there, or the auto-grow has nothing to grow
// for and the feature is dead code.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPill } from "./context-pill.tsx";
import { IslandSuggestionChip } from "./suggestion-chip.tsx";

// `recording-pill` is deliberately absent here: it pulls in `@ryu/ui`, which this
// package's test runner cannot resolve. It takes the same `wrap` prop and the same
// truncate/break-words swap as the two below.

const LONG_SUGGESTION = {
	title: "Draft a reply to the Block71 thread about next week's onsite",
	body: "Three people are waiting on the agenda you promised on Monday",
};

describe("island pill wrapping", () => {
	test("suggestion chip truncates by default and wraps when asked", () => {
		const fixed = renderToStaticMarkup(
			<IslandSuggestionChip suggestion={LONG_SUGGESTION} />
		);
		expect(fixed).toContain("truncate");
		expect(fixed).not.toContain("break-words");

		const grown = renderToStaticMarkup(
			<IslandSuggestionChip suggestion={LONG_SUGGESTION} wrap />
		);
		expect(grown).not.toContain("truncate");
		expect(grown).toContain("break-words");
		// Both lines still render — wrapping changes the layout, not the content.
		expect(grown).toContain("Block71");
		expect(grown).toContain("agenda");
	});

	test("context pill drops its one-line cap when asked to wrap", () => {
		const context = {
			appName: "some extremely long window title",
			degraded: false,
			live: true,
		};
		const fixed = renderToStaticMarkup(<ContextPill context={context} />);
		expect(fixed).toContain("truncate");
		expect(fixed).toContain("max-w-36");

		const grown = renderToStaticMarkup(<ContextPill context={context} wrap />);
		expect(grown).not.toContain("truncate");
		expect(grown).not.toContain("max-w-36");
	});
});
