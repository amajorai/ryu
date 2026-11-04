import { describe, expect, it } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import { skillRelationNodeLabel } from "./skill-relation-node-label.ts";

const SOURCE =
	"{kind, select, agent {Agent: {name}} skill {Skill: {name}} other {Tool: {name}}}";

const englishTl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

const germanTl: LiteralMessage = (source, values) =>
	formatMessage(
		source === SOURCE
			? "{kind, select, agent {Agent: {name}} skill {Fähigkeit: {name}} other {Werkzeug: {name}}}"
			: source,
		values ?? {},
		"de"
	);

describe("skillRelationNodeLabel", () => {
	it("names each kind with a capitalised word, not the raw enum", () => {
		expect(skillRelationNodeLabel("agent", "Researcher", englishTl)).toBe(
			"Agent: Researcher"
		);
		expect(skillRelationNodeLabel("skill", "Summarise", englishTl)).toBe(
			"Skill: Summarise"
		);
		expect(skillRelationNodeLabel("tool", "web_search", englishTl)).toBe(
			"Tool: web_search"
		);
	});

	it("announces the kind in German", () => {
		expect(skillRelationNodeLabel("tool", "web_search", germanTl)).toBe(
			"Werkzeug: web_search"
		);
		expect(skillRelationNodeLabel("skill", "Summarise", germanTl)).toBe(
			"Fähigkeit: Summarise"
		);
	});
});
