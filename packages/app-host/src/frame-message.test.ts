import { expect, test } from "bun:test";
import { frameMessageSchema } from "./ExtensionHost.tsx";

test("frame messages retain compact shared graphs without expanding them", () => {
	type SharedGraph = number | SharedGraph[];
	let graph: SharedGraph = 0;
	for (let i = 0; i < 40; i++) {
		graph = [graph, graph];
	}
	const started = performance.now();
	const parsed = frameMessageSchema.parse({ kind: "ignored", payload: graph });
	expect(parsed.payload).toBe(graph);
	expect(performance.now() - started).toBeLessThan(1000);
	expect(frameMessageSchema.parse({ kind: "ready", value: 1 })).toEqual({
		kind: "ready",
		value: 1,
	});
	expect(frameMessageSchema.safeParse(null).success).toBe(false);
});
