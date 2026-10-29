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
	"Chart",
	"Stat",
	"Progress",
	"Skeleton",
	"Button",
	"Input",
	"Textarea",
	"Checkbox",
	"Switch",
	"Select",
	"OptionList",
	"Slider",
	"ApprovalCard",
	"LinkPreview",
];

describe("agentUiCatalog", () => {
	it("exposes exactly the intended component vocabulary", () => {
		expect([...agentUiCatalog.componentNames].sort()).toEqual(
			[...EXPECTED_COMPONENTS].sort()
		);
	});

	it("declares the host-facing submit action", () => {
		expect([...agentUiCatalog.actionNames]).toEqual(["submit"]);
		expect(agentUiCatalog.prompt()).toContain(
			"Submit a user's answer or selection"
		);
	});

	it("produces a non-empty system prompt naming every component", () => {
		const prompt = agentUiCatalog.prompt();
		for (const name of EXPECTED_COMPONENTS) {
			expect(prompt, `prompt mentions ${name}`).toContain(name);
		}
	});

	it("emits the root and element contract for generated specs", () => {
		expect(agentUiCatalog.jsonSchema()).toMatchObject({
			type: "object",
			required: ["root", "elements"],
			additionalProperties: false,
			properties: {
				root: { type: "string" },
				elements: {
					type: "object",
					additionalProperties: {
						type: "object",
						required: ["type", "props", "children", "visible"],
						additionalProperties: false,
						properties: {
							type: { enum: EXPECTED_COMPONENTS },
							props: { type: "object" },
							children: { type: "array", items: { type: "string" } },
						},
					},
				},
			},
		});
	});
});
