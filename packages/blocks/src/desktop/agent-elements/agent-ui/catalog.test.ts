import { describe, expect, it } from "bun:test";
import { agentUiCatalog } from "./catalog.ts";

// The agent-UI catalog is the contract a model generates specs against, and it
// also drives the contract generator (scripts/gen-agent-ui-contract.ts). Pin the
// vocabulary and the prompt so a component added/removed/renamed here is a
// deliberate, reviewed change rather than silent drift.

const EXPECTED_COMPONENTS = [
	"Stack",
	"Grid",
	"Card",
	"Separator",
	"Heading",
	"Text",
	"Link",
	"Image",
	"Avatar",
	"Badge",
	"Alert",
	"Table",
	"Progress",
	"Skeleton",
	"Button",
	"Input",
	"Textarea",
	"Checkbox",
	"Switch",
	"Select",
];

describe("agentUiCatalog", () => {
	it("exposes exactly the intended component vocabulary", () => {
		expect([...agentUiCatalog.componentNames].sort()).toEqual(
			[...EXPECTED_COMPONENTS].sort()
		);
	});

	it("declares no custom actions (state is mutated via built-ins)", () => {
		expect([...agentUiCatalog.actionNames]).toEqual([]);
	});

	it("produces a non-empty system prompt naming every component", () => {
		const prompt = agentUiCatalog.prompt();
		expect(typeof prompt).toBe("string");
		expect(prompt.length).toBeGreaterThan(0);
		for (const name of EXPECTED_COMPONENTS) {
			expect(prompt, `prompt mentions ${name}`).toContain(name);
		}
	});

	it("emits a JSON schema for the spec", () => {
		const schema = agentUiCatalog.jsonSchema();
		expect(schema).toBeTruthy();
		expect(typeof schema).toBe("object");
	});
});
