import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RyuAssistantMorph } from "./morph.tsx";

describe("RyuAssistantMorph", () => {
	test("renders a compact accessible trigger before opening", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantMorph
				contentHeight={620}
				trigger={<span data-testid="island-mark">Ryu</span>}
				triggerLabel="Open Ask Ryu"
			>
				<p>Assistant content</p>
			</RyuAssistantMorph>
		);

		expect(html).toContain('aria-label="Open Ask Ryu"');
		expect(html).toContain('data-testid="island-mark"');
		expect(html).not.toContain("Assistant content");
	});

	test("renders its content when controlled open", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantMorph
				contentHeight={620}
				dialogLabel="Ask Ryu"
				isOpen
				triggerLabel="Ask Ryu"
			>
				<p>Assistant content</p>
			</RyuAssistantMorph>
		);

		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-label="Ask Ryu"');
		expect(html).toContain("Assistant content");
	});
});
