import { describe, expect, it } from "bun:test";
import {
	acpHarnessSuffix,
	composeTriggerSummary,
	type TriggerSummarySource,
} from "./composer-trigger-summary.ts";

function source(
	partial: Partial<TriggerSummarySource> & { key: string; name: string }
): TriggerSummarySource {
	return { decorated: false, effort: false, loading: false, ...partial };
}

function requireSegment(
	segments: ReturnType<typeof composeTriggerSummary>,
	key: string
) {
	const segment = segments.find((candidate) => candidate.key === key);
	if (!segment) throw new Error(`Expected composer trigger segment ${key}`);
	return segment;
}

// The order the composer hook actually produces: agent, model, approval, then
// the agent-advertised config options (reasoning among them).
const AGENT = source({ key: "agent", name: "Ryu" });
const MODEL = source({ key: "model", name: "Claude Sonnet 4.5" });
const APPROVAL = source({
	key: "approval",
	name: "Accept edits",
	decorated: true,
});
const EFFORT = source({ key: "cfg-thought_level", name: "High", effort: true });

describe("composeTriggerSummary", () => {
	it("folds effort onto the model segment even across the approval section", () => {
		const segments = composeTriggerSummary([AGENT, MODEL, APPROVAL, EFFORT]);
		expect(segments.map((s) => s.key)).toEqual(["agent", "model", "approval"]);
		expect(requireSegment(segments, "model").effortName).toBe("High");
	});

	it("renders a decorated mode as icon-only but keeps its name for a11y", () => {
		const segments = composeTriggerSummary([AGENT, MODEL, APPROVAL, EFFORT]);
		const approval = segments.find((s) => s.key === "approval");
		expect(approval?.iconOnly).toBe(true);
		expect(approval?.name).toBe("Accept edits");
	});

	it("keeps the text of a mode whose value resolved no decoration", () => {
		// opencode's `mode` option defaults to `build`, which matches none of the
		// approval styles — icon-only there would render an empty segment.
		const build = source({ key: "cfg-mode", name: "Build", decorated: false });
		const segments = composeTriggerSummary([AGENT, MODEL, build]);
		const mode = segments.find((s) => s.key === "cfg-mode");
		expect(mode?.iconOnly).toBe(false);
		expect(mode?.name).toBe("Build");
	});

	it("gives effort its own segment when there is no model to ride on", () => {
		const segments = composeTriggerSummary([AGENT, EFFORT]);
		expect(segments.map((s) => s.key)).toEqual(["agent", "cfg-thought_level"]);
		expect(
			requireSegment(segments, "cfg-thought_level").effortName
		).toBeUndefined();
		expect(requireSegment(segments, "cfg-thought_level").name).toBe("High");
	});

	it("does not fold effort onto a model still being probed", () => {
		const probing = source({ key: "model", name: "Detecting…", loading: true });
		const segments = composeTriggerSummary([AGENT, probing, EFFORT]);
		expect(segments).toHaveLength(3);
		expect(requireSegment(segments, "model").effortName).toBeUndefined();
	});

	it("folds only the first effort scale, so a second keeps its own segment", () => {
		const second = source({ key: "cfg-depth", name: "Deep", effort: true });
		const segments = composeTriggerSummary([MODEL, EFFORT, second]);
		expect(segments.map((s) => s.key)).toEqual(["model", "cfg-depth"]);
		expect(requireSegment(segments, "model").effortName).toBe("High");
	});

	it("never marks a loading section icon-only (the spinner is its content)", () => {
		const probing = source({
			key: "approval",
			name: "Detecting…",
			decorated: true,
			loading: true,
		});
		expect(
			requireSegment(composeTriggerSummary([probing]), "approval").iconOnly
		).toBe(false);
	});
});

describe("acpHarnessSuffix", () => {
	it("names the harness when the agent's name does not imply it", () => {
		expect(acpHarnessSuffix("Ryu", "acp:pi")).toBe("pi");
	});

	it.each([
		["OpenCode", "acp:opencode"],
		["Claude Agent", "claude"],
		["Gemini CLI", "gemini"],
		["Factory Droid", "droid"],
		["Amp", "amp-acp"],
		["pi ACP", "pi"],
	])("suppresses the redundant suffix for %p", (name, engine) => {
		expect(acpHarnessSuffix(name, engine)).toBeNull();
	});

	it("returns null when the agent carries no engine (custom store agents)", () => {
		expect(acpHarnessSuffix("Coder", null)).toBeNull();
		expect(acpHarnessSuffix("Coder", "acp:")).toBeNull();
		expect(acpHarnessSuffix(null, "acp:pi")).toBeNull();
	});
});
