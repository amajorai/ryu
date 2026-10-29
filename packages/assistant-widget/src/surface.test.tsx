import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	RyuAssistantRecentChats,
	RyuAssistantWidgetFrame,
	RyuAssistantWidgetHeader,
} from "./surface.tsx";

describe("assistant widget surface primitives", () => {
	test("renders a semantic docked frame and shared header", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantWidgetFrame ariaLabel="Ask Ryu assistant" placement="docked">
				<RyuAssistantWidgetHeader
					actions={<button type="button">Settings</button>}
					onClose={() => undefined}
					title="New chat"
				/>
			</RyuAssistantWidgetFrame>
		);

		expect(html).toContain('data-ryu-assistant-widget="true"');
		// The website's Lenis smooth scroll must let wheel and touch scroll the panel natively.
		expect(html).toContain("data-lenis-prevent");
		expect(html).toContain('data-placement="docked"');
		expect(html).toContain('aria-label="Ask Ryu assistant"');
		expect(html).toContain("New chat");
		expect(html).toContain('aria-label="Close assistant"');
	});

	test("names non-docked assistant frames as regions", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantWidgetFrame ariaLabel="Ryu assistant" placement="floating">
				<p>Chat content</p>
			</RyuAssistantWidgetFrame>
		);

		expect(html).toContain('aria-label="Ryu assistant"');
		expect(html).toContain('role="region"');
	});

	test("limits recent chats to the compact surface's four-row handoff", () => {
		const html = renderToStaticMarkup(
			<RyuAssistantRecentChats
				items={Array.from({ length: 5 }, (_, index) => ({
					id: `chat-${index}`,
					meta: `${index + 1}m`,
					title: `Chat ${index + 1}`,
				}))}
				onSelect={() => undefined}
			/>
		);

		expect(html).toContain("Chat 4");
		expect(html).not.toContain("Chat 5");
	});
});
