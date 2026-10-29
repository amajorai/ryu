import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageToolsPopover } from "./page-tools.tsx";
import type { WebMcpPageTool } from "./webmcp.ts";

const tool = {
	id: "https://docs.example\u0000read_page\u00000",
	annotations: { readOnlyHint: true, untrustedContentHint: true },
	description: "Read the current page.",
	inputSchema: {
		additionalProperties: false,
		properties: {
			path: { description: "A site path", type: "string" },
		},
		type: "object",
	},
	name: "read_page",
	origin: "https://docs.example",
	title: "Read a page",
} satisfies WebMcpPageTool;

describe("PageToolsPopover", () => {
	test("renders an explicit, accessible page-tool affordance", () => {
		const html = renderToStaticMarkup(
			<PageToolsPopover
				onExecute={async () => "ok"}
				onResult={() => undefined}
				tools={[tool]}
			/>
		);

		expect(html).toContain('aria-label="Page tools (1)"');
		expect(html).toContain("Page tools");
	});
});
