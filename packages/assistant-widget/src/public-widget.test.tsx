import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RyuAssistantChat } from "./chat.tsx";
import { loadAssistantSession } from "./deferred-session.tsx";
import { RyuAssistantWidget } from "./public-widget.tsx";

// The panel is code-split; once its chunk settles, use() renders it synchronously.
beforeAll(async () => {
	await loadAssistantSession();
});

test("public reply image policy reaches the production shared transcript", () => {
	const html = renderToStaticMarkup(
		<RyuAssistantChat
			allowResponseImages={false}
			messages={[
				{
					id: "local-answer",
					role: "assistant",
					parts: [
						{
							type: "text",
							text: "**Local answer** ![Synthetic image](http://127.0.0.1:5257/probe?question=synthetic) See @<note.constructor> and @<note.__proto__>.",
						},
					],
				},
			]}
			onSend={() => {}}
			onStop={() => {}}
			placement="inline"
			status="ready"
		/>
	);
	expect(html).not.toContain("<img");
	expect(html).not.toContain('as="image"');
	expect(html).toContain("Synthetic image");
	expect(html).toContain("note.constructor");
	expect(html).toContain("note.__proto__");
	expect(html).toContain("<textarea");
});

describe("RyuAssistantWidget", () => {
	test("uses the shared Island morph as its launcher", () => {
		const html = renderToStaticMarkup(<RyuAssistantWidget />);

		expect(html).toContain('aria-label="Open Ask Ryu"');
		expect(html).toContain('aria-live="polite"');
		expect(html).not.toContain("Ryu local assistant");
		expect(html).not.toContain("Loading Ask Ryu");
	});

	test("matches Desktop's floating header: title, settings, no mode tabs", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantWidget
				initialMode="node"
				inline
				openOnMount
				showLauncher={false}
			/>
		);

		expect(html).toContain("New chat");
		expect(html).toContain('aria-label="Assistant settings"');
		expect(html).not.toContain('aria-label="Assistant mode"');
		expect(html).not.toContain("Choose a runtime");
	});

	test("shows the Powered by Ryu badge only when the host asks for it", () => {
		const props = {
			initialMode: "guest",
			inline: true,
			openOnMount: true,
			showLauncher: false,
		} as const;
		expect(
			renderToStaticMarkup(<RyuAssistantWidget {...props} />)
		).not.toContain("data-ryu-powered-by");
		const branded = renderToStaticMarkup(
			<RyuAssistantWidget {...props} poweredByRyu />
		);
		expect(branded).toContain('data-ryu-powered-by="assistant-widget"');
		expect(branded).toContain("utm_source=assistant-widget");
	});

	test("asks for runtime setup inside the composer card", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantWidget
				initialMode="node"
				inline
				openOnMount
				showLauncher={false}
			/>
		);

		const composerStart = html.indexOf('data-chat-composer-transition="true"');
		expect(composerStart).toBeGreaterThan(-1);
		const composer = html.slice(composerStart);
		expect(composer).toContain('data-testid="assistant-runtime-setup"');
		expect(composer).toContain("Core address");
		expect(composer).toContain('aria-label="Ryu Core address"');
		expect(composer).toContain('aria-label="Ryu Core access token"');
	});

	test("keeps page context off the screened guest path", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantWidget
				initialMode="guest"
				inline
				openOnMount
				showLauncher={false}
			/>
		);

		expect(html).toContain("Prompts go through Ryu&#x27;s hosted gateway");
		expect(html).not.toContain("OpenCode");
		expect(html).toContain('placeholder="Send a message"');
		expect(html).not.toContain('data-testid="assistant-runtime-setup"');
		expect(html).not.toContain('data-testid="assistant-page-context"');
	});
});
