import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RyuAssistantWidgetIframe } from "./iframe.tsx";

describe("RyuAssistantWidgetIframe", () => {
	test("keeps the hosted surface sandboxed by default", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantWidgetIframe
				height={620}
				src="https://assistant.example.test/embed"
				title="Support assistant"
			/>
		);

		expect(html).toContain('sandbox="allow-scripts"');
		expect(html).toContain('referrerPolicy="strict-origin-when-cross-origin"');
		expect(html).toContain('src="https://assistant.example.test/embed"');
		expect(html).toContain('title="Support assistant"');
		expect(html).toContain("height:620px");
	});
});
