import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageContextChips } from "./page-context.tsx";

const noop = () => undefined;

describe("PageContextChips", () => {
	test("keeps page and selection context opt-in with a review control", () => {
		const html = renderToStaticMarkup(
			<PageContextChips
				context={{
					selection: "Selected words",
					text: "Readable page text",
					title: "Install Ryu",
					url: "https://docs.example/install",
				}}
				includePage
				includeSelection={false}
				onIncludePageChange={noop}
				onIncludeSelectionChange={noop}
			/>
		);

		expect(html).toContain("Webpage context");
		expect(html).toContain("Install Ryu");
		expect(html).toContain('aria-label="Review page text"');
		expect(html).toContain('aria-label="Remove page text from context"');
		expect(html).toContain("Add selected text");
		expect(html).not.toContain("Selected words");
	});

	test("renders nothing when the page offers no context", () => {
		const html = renderToStaticMarkup(
			<PageContextChips
				context={{ selection: null, text: "", title: "", url: "" }}
				includePage={false}
				includeSelection={false}
				onIncludePageChange={noop}
				onIncludeSelectionChange={noop}
			/>
		);

		expect(html).toBe("");
	});
});
