import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { loadAssistantSession } from "./deferred-session.tsx";
import { RyuAssistantWidget } from "./public-widget.tsx";
import { ASSISTANT_GLASS_CHROME, ASSISTANT_GLASS_FILL } from "./skin.ts";

// The panel is code-split; once its chunk settles, use() renders it synchronously.
beforeAll(async () => {
	await loadAssistantSession();
});

describe("RyuAssistantWidget theme", () => {
	test("wears Desktop's themed Ask Ryu glass instead of forcing dark mode", () => {
		const markup = renderToStaticMarkup(
			<RyuAssistantWidget inline openOnMount showLauncher={false} />
		);

		expect(markup).toContain(ASSISTANT_GLASS_FILL);
		expect(markup).toContain(ASSISTANT_GLASS_CHROME);
		expect(markup).not.toContain('class="dark ');
		expect(markup).not.toContain("bg-background");
		expect(markup).toContain("New chat");
	});
});
