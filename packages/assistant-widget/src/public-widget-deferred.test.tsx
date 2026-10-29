// The chat session is a separate chunk. This file runs isolated (`bun test
// --isolate`), so the loader starts idle here.
import { describe, expect, test } from "bun:test";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { assistantSessionLoadStatus } from "./deferred-session.tsx";
import { RyuAssistantWidget } from "./public-widget.tsx";

describe("RyuAssistantWidget code splitting", () => {
	test("a closed launcher does not load the chat session", () => {
		const html = renderToStaticMarkup(<RyuAssistantWidget />);

		expect(html).toContain('aria-label="Open Ask Ryu"');
		expect(assistantSessionLoadStatus()).toBe("idle");
	});

	test("streaming SSR of an inline panel resolves the deferred session", async () => {
		const stream = await renderToReadableStream(
			<RyuAssistantWidget
				initialMode="node"
				inline
				openOnMount
				showLauncher={false}
			/>
		);
		await stream.allReady;
		const html = await new Response(stream).text();

		expect(html).toContain("New chat");
		expect(html).toContain('data-testid="assistant-runtime-setup"');
		expect(assistantSessionLoadStatus()).toBe("fulfilled");
	});
});
