import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
	artifactFromInput,
	hostArtifactTransportSchema,
} from "../tools/artifact-tool.ts";
import {
	normalizeAssistantToolParts,
	normalizeUiMessageToolParts,
} from "./tool-part-normalizer.ts";

test("live public SDK tool input retains opaque values and part identity", () => {
	const callback = () => "native callback";
	const payload = {
		callback,
		date: new Date(123),
		map: new Map([["native", 42]]),
		token: Symbol("native"),
		large: 1n,
	};
	const part: UIMessage["parts"][number] = {
		type: "tool-native",
		toolCallId: "native",
		state: "input-available",
		input: payload,
	};
	const parts: UIMessage["parts"] = [part];
	expect(normalizeUiMessageToolParts(parts)).toBe(parts);
	expect(normalizeUiMessageToolParts(parts)[0]).toBe(part);
	expect(normalizeAssistantToolParts(parts)).toBe(parts);
	expect(part.input).toBe(payload);
	expect(payload.callback).toBe(callback);
});

test("structured tool JSON parsing remains separate from raw SDK admission", () => {
	const callback = () => "native callback";
	const input = { callback };
	const unchanged = {
		type: "tool-native",
		input,
		output: "not JSON",
		result: "null",
	};
	expect(normalizeAssistantToolParts([unchanged])[0]).toBe(unchanged);
	const source = { type: "tool-native", input: '{"native":42}', output: input };
	const normalized = normalizeAssistantToolParts([source])[0];
	expect(normalized).toEqual({
		type: "tool-native",
		input: { native: 42 },
		output: input,
	});
	expect(source.input).toBe('{"native":42}');
});

test("live artifact selection retains payload identity without reading deferred fields", () => {
	const failure = new Error("deferred optional artifact field");
	let reads = 0;
	const payload = {
		kind: "html",
		content: "<p>native</p>",
		get actions() {
			reads++;
			throw failure;
		},
	};
	expect(artifactFromInput({ artifact: payload })).toBe(payload);
	expect(reads).toBe(0);
	expect(() => payload.actions).toThrow(failure);
	expect(reads).toBe(1);
	const jsonPayload = {
		kind: "html",
		title: "Native",
		content: "<p>native</p>",
		actions: [{ id: "confirm", label: "Confirm" }],
	};
	expect(hostArtifactTransportSchema.parse(jsonPayload)).toBe(jsonPayload);
	expect(
		hostArtifactTransportSchema.safeParse({ kind: "html", title: 42 }).success
	).toBe(false);
});
