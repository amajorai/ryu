import { describe, expect, it } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import { newWorkflowDraft, newWorkflowName } from "./workflow-draft.ts";

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

const GERMAN: Record<string, string> = { "New workflow": "Neuer Workflow" };
const german: LiteralMessage = (source, values) =>
	formatMessage(GERMAN[source] ?? source, values ?? {});

describe("newWorkflowDraft", () => {
	it("names the draft in the creator's language", () => {
		expect(newWorkflowDraft(german).name).toBe("Neuer Workflow");
		expect(newWorkflowName(german)).toBe("Neuer Workflow");
	});

	it("keeps the English default and an empty definition", () => {
		expect(newWorkflowDraft(english)).toEqual({
			id: "",
			name: "New workflow",
			nodes: [],
			edges: [],
			triggers: [],
		});
	});
});
