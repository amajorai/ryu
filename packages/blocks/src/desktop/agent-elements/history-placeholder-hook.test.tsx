import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryPlaceholder } from "./agent-chat-helpers.tsx";

const CHAT_PAGE_CSS = resolve(
	import.meta.dir,
	"../../../../../apps/desktop/src/pages/ChatPage.css"
);

/**
 * The desktop chat page insets the loading transcript under its titlebar. Its
 * rule must target a stable hook, because the DOM localizer translates the
 * placeholder's aria-label in every non-English locale.
 */
test("the loading transcript carries the hook ChatPage.css selects", () => {
	const markup = renderToStaticMarkup(<HistoryPlaceholder />);
	expect(markup).toContain("<output");
	expect(markup).toContain('data-chat-loading=""');
	const css = readFileSync(CHAT_PAGE_CSS, "utf8");
	expect(css).toContain("output[data-chat-loading]");
	expect(css).not.toMatch(/\[aria-label\s*[~|^$*]?=/);
});
