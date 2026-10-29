import { describe, expect, test } from "bun:test";
import type { WidgetAvailablePart } from "../types.ts";
import { isWidgetAvailablePart } from "./widget-stream-boundary.ts";

function publishedPart(): WidgetAvailablePart {
	return {
		type: "data-tool-widget-available",
		data: {
			approvedGrants: ["tool:call"],
			displayMode: "inline",
			initialWidgetState: null,
			instanceId: "instance-1",
			invoked: null,
			invoking: null,
			maxHeight: null,
			serverId: "sample-widget",
			templateUri: "ui://widget/sample.html",
			toolCallId: "call-1",
			toolInput: { name: "Ada" },
			toolName: "render",
			toolOutput: { greeting: "Hello Ada" },
			toolResponseMetadata: {},
			widget: {
				html: "<p>Hello Ada</p>",
				mimeType: "text/html+skybridge",
				csp: { resource_domains: [] },
			},
			widgetAccessible: true,
		},
	};
}

describe("widget stream host boundary", () => {
	test("accepts Core nullable stream fields and the open-app optional variant", () => {
		const part = publishedPart();
		expect(isWidgetAvailablePart(part)).toBe(true);
		const {
			invoking: _invoking,
			invoked: _invoked,
			maxHeight: _maxHeight,
			...openAppData
		} = part.data;
		const openApp = { ...part, data: { ...openAppData, conversationId: null } };
		expect(isWidgetAvailablePart(openApp)).toBe(true);
	});
	test("retains complete original references and unconstrained opaque cells", () => {
		const callback = () => "opaque";
		const part = publishedPart();
		part.data.toolInput = callback;
		part.data.toolOutput = new Map([["future", 1]]);
		part.data.toolResponseMetadata = Symbol("metadata");
		Object.assign(part, { futurePart: true });
		Object.assign(part.data, { futureData: { preserved: true } });
		expect(isWidgetAvailablePart(part)).toBe(true);
		expect(part.data.toolInput).toBe(callback);
		for (const height of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			part.data.maxHeight = height;
			expect(isWidgetAvailablePart(part)).toBe(true);
		}
	});
	test("refuses incomplete or malformed renderer fields", () => {
		for (const patch of [
			{ approvedGrants: "tool:call" },
			{ instanceId: null },
			{ invoked: 1 },
			{ maxHeight: "300" },
			{ displayMode: "other" },
			{ widgetAccessible: "true" },
			{ widget: { html: 1, mimeType: "text/html+skybridge" } },
			{
				widget: {
					html: "<p>x</p>",
					mimeType: "text/html+skybridge",
					csp: { resource_domains: [1] },
				},
			},
		]) {
			const part = publishedPart();
			Object.assign(part.data, patch);
			expect(isWidgetAvailablePart(part)).toBe(false);
		}
		const incomplete = publishedPart();
		const { toolInput, ...missingInput } = incomplete.data;
		expect(toolInput).toEqual({ name: "Ada" });
		expect(isWidgetAvailablePart({ ...incomplete, data: missingInput })).toBe(
			false
		);
		for (const value of [
			null,
			undefined,
			[],
			{ type: "data-tool-widget-available" },
		]) {
			expect(isWidgetAvailablePart(value)).toBe(false);
		}
	});
	test("throwing malformed payload reads cannot mount a widget", () => {
		const part = publishedPart();
		Object.defineProperty(part.data, "instanceId", {
			get() {
				throw new Error("malformed stream getter");
			},
		});
		expect(isWidgetAvailablePart(part)).toBe(false);
	});
});
