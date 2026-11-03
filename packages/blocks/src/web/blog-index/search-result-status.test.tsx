import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchResultStatus } from "./search-result-status.tsx";

function statusText(html: string): string | undefined {
	return html.match(/data-slot="search-status">([^<]*)</)?.[1];
}

describe("SearchResultStatus", () => {
	it("stays mounted and silent while nothing is searched", () => {
		const html = renderToStaticMarkup(
			<SearchResultStatus count={4} kind="posts" query="  " />
		);
		expect(html).toContain('aria-live="polite"');
		expect(statusText(html)).toBe("");
	});

	it("announces the post match count for a search", () => {
		expect(
			statusText(
				renderToStaticMarkup(
					<SearchResultStatus count={1} kind="posts" query=" gateway " />
				)
			)
		).toBe("1 post match &quot;gateway&quot;");
		expect(
			statusText(
				renderToStaticMarkup(
					<SearchResultStatus count={0} kind="posts" query="zzz" />
				)
			)
		).toBe("No posts match &quot;zzz&quot;");
	});

	it("announces release counts for the changelog", () => {
		expect(
			statusText(
				renderToStaticMarkup(
					<SearchResultStatus count={3} kind="releases" query="mcp" />
				)
			)
		).toBe("3 releases match &quot;mcp&quot;");
	});
});
