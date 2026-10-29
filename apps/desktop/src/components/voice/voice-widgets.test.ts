import { expect, test } from "bun:test";
import { extractVoiceWidgets } from "./voice-widgets.ts";

test("voice widgets retain inline static data and dashboard defaults", () => {
	const data = { value: 24, history: [20, 24], available: true };
	const text = `Temperature\n\`\`\`ryu-widget\n${JSON.stringify({ kind: "stat", title: "Temperature", config: { label: "Now" }, data })}\n\`\`\``;
	const widgets = extractVoiceWidgets(text);
	expect(widgets).toHaveLength(1);
	expect(widgets[0]?.value).toEqual(data);
	expect(widgets[0]?.widget.source).toEqual({ type: "static", data });
	expect(widgets[0]?.widget.layout).toEqual({ x: 0, y: 0, w: 4, h: 4 });
	expect(extractVoiceWidgets(text)).toEqual(widgets);
});

test("voice widgets skip invalid blocks and preserve later valid widget identities", () => {
	const text = [
		"{not json}",
		JSON.stringify({ kind: "unknown", data: 2 }),
		JSON.stringify({ kind: "stat", title: 3 }),
		JSON.stringify({
			kind: "text",
			data: null,
			layout: { x: 1, y: 2, w: 3, h: 4 },
		}),
	]
		.map((block) => `\`\`\`ryu-widget\n${block}\n\`\`\``)
		.join("\n");
	const widgets = extractVoiceWidgets(text);
	expect(widgets).toHaveLength(1);
	expect(widgets[0]?.id).toBe("voice-widget-3");
	expect(widgets[0]?.value).toBeNull();
	expect(widgets[0]?.widget.layout).toEqual({ x: 1, y: 2, w: 3, h: 4 });
});
