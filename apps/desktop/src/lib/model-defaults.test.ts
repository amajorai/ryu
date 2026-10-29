import { describe, expect, test } from "bun:test";
import type { EffectiveDefaults, ScopeDefault } from "./api/hierarchy.ts";
import {
	defaultLabel,
	inheritedBelow,
	inheritedForCoordinator,
	isScopeSet,
	roleValue,
	withRoleValue,
} from "./model-defaults.ts";

const EMPTY: ScopeDefault = { effort: "", model: "", provider: "" };

function level(model: string, effort = "", provider = "p"): ScopeDefault {
	return { effort, model, provider };
}

function levels(
	partial: Partial<EffectiveDefaults["levels"]>
): EffectiveDefaults["levels"] {
	return {
		agent: null,
		agent_binding_model: null,
		global: null,
		project: null,
		project_agent: null,
		session: null,
		settings: null,
		...partial,
	};
}

describe("roleValue / withRoleValue", () => {
	test("each role reads and writes only its own fields", () => {
		const both = withRoleValue(
			withRoleValue(EMPTY, "thread", { model: "haiku", provider: "a" }),
			"coordinator",
			{ effort: "high", model: "opus", provider: "a" }
		);
		expect(roleValue(both, "thread")).toEqual({
			effort: "",
			model: "haiku",
			provider: "a",
		});
		expect(roleValue(both, "coordinator")).toEqual({
			effort: "high",
			model: "opus",
			provider: "a",
		});
	});

	test("a stored value without coordinator fields reads as unset", () => {
		expect(roleValue(level("x"), "coordinator").model).toBe("");
		expect(roleValue(null, "thread").model).toBe("");
	});
});

describe("isScopeSet", () => {
	test("a coordinator-only value counts as set", () => {
		expect(isScopeSet(EMPTY)).toBe(false);
		expect(isScopeSet({ ...EMPTY, coordinatorEffort: "low" })).toBe(true);
	});
});

describe("inheritedBelow", () => {
	test("skips the level itself and everything above it", () => {
		const all = levels({
			project_agent: level("pa"),
			agent: level("agent"),
			project: level("project", "low"),
			global: level("lane", "medium"),
		});
		expect(inheritedBelow(all, "project_agent").model).toBe("agent");
		expect(inheritedBelow(all, "agent").model).toBe("project");
		expect(inheritedBelow(all, "project")).toEqual({
			effort: "medium",
			model: "lane",
			provider: "p",
		});
	});

	test("the agent card's own model sits between the bot and the project", () => {
		const all = levels({
			agent_binding_model: "bound",
			project: level("project"),
		});
		expect(inheritedBelow(all, "agent").model).toBe("bound");
		expect(inheritedBelow(all, "project").model).toBe("");
	});

	test("model and effort fall through independently", () => {
		const all = levels({
			project: level("", "high", ""),
			settings: level("settings-model"),
		});
		expect(inheritedBelow(all, "agent")).toEqual({
			effort: "high",
			model: "settings-model",
			provider: "p",
		});
	});
});

describe("defaultLabel", () => {
	test("names the inherited value when there is one", () => {
		expect(defaultLabel("claude-opus-5-5")).toBe("Default (claude-opus-5-5)");
		expect(defaultLabel("")).toBe("Default");
	});
});

describe("inheritedForCoordinator", () => {
	test("with no coordinator value stored, the scope's own thread value applies first", () => {
		const all = levels({
			project: level("project-thread", "low"),
			global: level("lane", "medium"),
		});
		expect(
			inheritedForCoordinator(all, "project", level("project-thread", "low"))
		).toEqual({
			effort: "low",
			model: "project-thread",
			provider: "p",
		});
	});

	test("a scope's own coordinator value is not its own fallback", () => {
		const all = levels({
			project: level("project-coord", "high"),
			global: level("lane", "medium"),
		});
		const stored: ScopeDefault = {
			...EMPTY,
			coordinatorEffort: "high",
			coordinatorModel: "project-coord",
		};
		expect(inheritedForCoordinator(all, "project", stored)).toEqual({
			effort: "medium",
			model: "lane",
			provider: "p",
		});
	});
});
