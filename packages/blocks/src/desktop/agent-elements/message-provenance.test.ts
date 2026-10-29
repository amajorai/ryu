import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { widgetMessageProvenanceKey } from "./types.ts";

function message(metadata?: UIMessage["metadata"]): UIMessage {
	return { id: "message", role: "user", parts: [], metadata };
}

describe("widget message provenance", () => {
	it("keeps the same widget instance in one run", () => {
		expect(
			widgetMessageProvenanceKey(
				message({
					source: "widget",
					origin_server: "calendar",
					widget_instance_id: "instance-1",
				})
			)
		).toBe(
			widgetMessageProvenanceKey(
				message({
					source: "widget",
					origin_server: "calendar",
					widget_instance_id: "instance-1",
				})
			)
		);
	});

	it("changes at widget-to-human and widget-to-widget boundaries", () => {
		const widget = message({
			source: "widget",
			origin_server: "calendar",
			widget_instance_id: "instance-1",
		});
		const otherWidget = message({
			source: "widget",
			origin_server: "calendar",
			widget_instance_id: "instance-2",
		});

		expect(widgetMessageProvenanceKey(widget)).not.toBe(
			widgetMessageProvenanceKey(message())
		);
		expect(widgetMessageProvenanceKey(widget)).not.toBe(
			widgetMessageProvenanceKey(otherWidget)
		);
	});
});
