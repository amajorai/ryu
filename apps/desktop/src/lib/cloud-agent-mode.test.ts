import { describe, expect, test } from "bun:test";
import {
	backendAgentMode,
	CLOUD_AGENT_MODE_LABELS,
	executorAgentMode,
	planFromDatacenter,
} from "./cloud-agent-mode.ts";

describe("cloud agent mode", () => {
	test("the Ryu agent keeps the loop on the computer; other executors run in the cloud", () => {
		expect(executorAgentMode("ryu")).toBe("agent-on-computer");
		for (const executor of ["claude-code", "codex", "opencode", "cursor"]) {
			expect(executorAgentMode(executor)).toBe("agent-in-cloud");
		}
	});

	test("backends map to where the agent loop runs", () => {
		expect(backendAgentMode("ryu-box", "ryu")).toBe("agent-on-computer");
		expect(backendAgentMode("ryu-box", "claude-code")).toBe("agent-in-cloud");
		expect(backendAgentMode("anthropic-subscription-cli", "claude-code")).toBe(
			"agent-in-cloud"
		);
		expect(backendAgentMode("openai-subscription-cli", "codex")).toBe(
			"agent-in-cloud"
		);
		expect(backendAgentMode("anthropic-subscription-sdk", "claude-code")).toBe(
			"on-node"
		);
		expect(backendAgentMode("openai-subscription-sdk", "codex")).toBe(
			"on-node"
		);
	});

	test("flags a personal plan only where it would leave a datacenter IP", () => {
		expect(planFromDatacenter("ryu-box", "claude-code", false)).toBe(true);
		expect(planFromDatacenter("ryu-box", "codex", false)).toBe(true);
		expect(planFromDatacenter("ryu-box", "ryu", true)).toBe(false);
		expect(planFromDatacenter("ryu-box", "opencode", false)).toBe(false);
		expect(
			planFromDatacenter("anthropic-subscription-sdk", "claude-code", true)
		).toBe(true);
		expect(
			planFromDatacenter("anthropic-subscription-sdk", "claude-code", false)
		).toBe(false);
		expect(
			planFromDatacenter("anthropic-subscription-cli", "claude-code", true)
		).toBe(false);
	});

	test("every mode has a label", () => {
		expect(Object.keys(CLOUD_AGENT_MODE_LABELS).sort()).toEqual([
			"agent-in-cloud",
			"agent-on-computer",
			"on-node",
		]);
	});
});
