import { expect, test } from "bun:test";
import {
	artifactFromInput,
	hostArtifactTransportSchema,
} from "./tools/artifact-tool.ts";
import { turnEndPartsSchema } from "./turn-end-wire.ts";
import { normalizeToolPart } from "./utils/tool-part-normalizer.ts";

test("persisted future fields retain deep JSON and native references", () => {
	const future = JSON.parse(`${"[".repeat(15_000)}0${"]".repeat(15_000)}`);
	const part = {
		type: "tool-Write",
		input: { path: "a.ts", content: "text" },
		future,
	};
	const parts = [part];
	expect(Object.is(turnEndPartsSchema.parse(parts), parts)).toBe(true);
	expect(Object.is(normalizeToolPart(part), part)).toBe(true);
});

test("artifact admission preserves future own keys and the transport codec rejects malformed known fields", () => {
	const artifact = JSON.parse(
		'{"title":"Saved","__proto__":{"future":true},"extra":1e400}'
	);
	expect(Object.is(artifactFromInput({ artifact }), artifact)).toBe(true);
	expect(Object.is(hostArtifactTransportSchema.parse(artifact), artifact)).toBe(
		true
	);
	// Known fields are decoded by the HostArtifact transport codec, which
	// rejects them; transcript admission only selects the native receiver and
	// leaves each field to its consumer (see native-artifact-observation.ts).
	const wrongTitle = { title: 42 };
	const missingActionId = { actions: [{ label: "Missing id" }] };
	expect(hostArtifactTransportSchema.safeParse(wrongTitle).success).toBe(false);
	expect(hostArtifactTransportSchema.safeParse(missingActionId).success).toBe(
		false
	);
	expect(artifactFromInput({ artifact: wrongTitle })).toBe(wrongTitle);
	expect(artifactFromInput({ artifact: missingActionId })).toBe(
		missingActionId
	);
});
