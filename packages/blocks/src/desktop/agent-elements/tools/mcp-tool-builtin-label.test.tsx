import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { McpTool } from "./mcp-tool.tsx";
import { mcpToolLabel, parseMcpToolType } from "./tool-mcp-name.ts";

const JA = {
	"List Resources": "リソースを一覧表示",
	"Read Resource": "リソースを読み込む",
};

test("the built-in resource tools translate; a server's tools keep their names", () => {
	const tl = (source: string) => JA[source as keyof typeof JA] ?? source;
	const list = parseMcpToolType("tool-ListMcpResources");
	const read = parseMcpToolType("tool-ReadMcpResourceTool");
	const server = parseMcpToolType("tool-mcp-github.list_issues");
	if (!(list && read && server)) {
		throw new Error("the MCP part types parse");
	}
	expect(mcpToolLabel(list, tl)).toBe("リソースを一覧表示");
	expect(mcpToolLabel(read, tl)).toBe("リソースを読み込む");
	expect(mcpToolLabel(server, tl)).toBe("List Issues");
});

test("a Japanese chat names the finished built-in tool in Japanese", () => {
	const info = parseMcpToolType("tool-ListMcpResources");
	if (!info) {
		throw new Error("the built-in part type parses");
	}
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="ja"
			manageDocument={false}
			overlays={{ ja: JA }}
		>
			<McpTool
				mcpInfo={info}
				part={{
					input: {},
					output: "[]",
					state: "output-available",
					type: "tool-ListMcpResources",
				}}
			/>
		</I18nProvider>
	);
	expect(html).toContain("リソースを一覧表示");
	expect(html).not.toContain("List Resources");
});
