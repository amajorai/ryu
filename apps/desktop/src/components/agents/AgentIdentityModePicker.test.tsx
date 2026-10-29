import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register before React and isolate this file from non-browser Bun suites.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentIdentityModePicker, identityModeAccountWarning } = await import(
	"./AgentIdentityModePicker.tsx"
);

import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

function radios(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
}

function checkedTitle(): string | null {
	const checked = radios().find(
		(radio) => radio.getAttribute("aria-checked") === "true"
	);
	return (
		checked
			?.closest("[data-identity-mode]")
			?.getAttribute("data-identity-mode") ?? null
	);
}

async function mount(initial: AgentIdentityMode, changes: AgentIdentityMode[]) {
	function Harness() {
		const [value, setValue] = useState<AgentIdentityMode>(initial);
		return createElement(AgentIdentityModePicker, {
			onChange: (mode: AgentIdentityMode) => {
				changes.push(mode);
				setValue(mode);
			},
			size: "hero",
			value,
		});
	}
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(createElement(Harness)));
}

describe("AgentIdentityModePicker", () => {
	test("renders three labelled radios with the current mode checked", async () => {
		await mount("managed", []);

		const group = document.querySelector('[role="radiogroup"]');
		expect(group?.getAttribute("aria-label")).toBe(
			"How should this agent work?"
		);
		expect(radios()).toHaveLength(3);
		expect(checkedTitle()).toBe("managed");
		const text = document.body.textContent ?? "";
		expect(text).toContain("Acts as you");
		expect(text).toContain("Its own identity");
		expect(text).toContain("Both");
	});

	test("clicking a card selects that mode", async () => {
		const changes: AgentIdentityMode[] = [];
		await mount("managed", changes);

		const card = document.querySelector<HTMLElement>(
			'[data-identity-mode="individual"]'
		);
		await act(async () => card?.click());

		expect(changes).toEqual(["individual"]);
		expect(checkedTitle()).toBe("individual");
	});

	test("arrow keys move the selection", async () => {
		const changes: AgentIdentityMode[] = [];
		await mount("managed", changes);

		const first = radios()[0];
		await act(async () => {
			first?.focus();
			first?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});

		expect(changes.at(-1)).toBe("individual");
		expect(checkedTitle()).toBe("individual");
	});
});

describe("identityModeAccountWarning", () => {
	test("warns when its own identity drops the user's selected accounts", () => {
		expect(
			identityModeAccountWarning(
				"individual",
				// The Treg switch and the agent's own account are not yours.
				["composio:ca_1", "platform:treg", "agent:acct"],
				1
			)
		).toBe(
			"2 of your accounts selected here won't be used while this agent has its own identity."
		);
	});

	test("warns when acting as you drops the agent's own accounts", () => {
		expect(
			identityModeAccountWarning("managed", ["agent:acct", "composio:x"], 0)
		).toBe(
			"1 of the agent's own accounts selected here won't be used while it acts as you."
		);
	});

	test("an app on the agent's own Composio identity is the agent's, not yours", () => {
		expect(
			identityModeAccountWarning(
				"individual",
				["agent-composio:own_1", "agent:acct", "composio:ca_1"],
				0
			)
		).toBe(
			"1 of your accounts selected here won't be used while this agent has its own identity."
		);
		expect(
			identityModeAccountWarning("individual", ["agent-composio:own_1"], 0)
		).toBeNull();
		expect(
			identityModeAccountWarning(
				"managed",
				["agent-composio:own_1", "agent:acct", "composio:ca_1"],
				0
			)
		).toBe(
			"2 of the agent's own accounts selected here won't be used while it acts as you."
		);
	});

	test("control of your desktop counts as yours; Treg does not", () => {
		expect(
			identityModeAccountWarning(
				"individual",
				["platform:desktop", "platform:treg", "provider:openai"],
				0
			)
		).toBe(
			"1 of your accounts selected here won't be used while this agent has its own identity."
		);
	});

	test("names the event triggers that will stop firing, in any mode", () => {
		expect(identityModeAccountWarning("mixed", ["composio:a"], 0, 1)).toBe(
			"1 event trigger watches an account this agent may no longer use, so it will stop firing."
		);
		expect(identityModeAccountWarning("individual", ["composio:a"], 0, 2)).toBe(
			"1 of your accounts selected here won't be used while this agent has its own identity. 2 event triggers watch accounts this agent may no longer use, so they will stop firing."
		);
		expect(identityModeAccountWarning("managed", null, 0, 0)).toBeNull();
	});

	test("stays quiet for both, and for an unrestricted agent", () => {
		expect(
			identityModeAccountWarning("mixed", ["agent:a", "composio:b"], 2)
		).toBeNull();
		expect(identityModeAccountWarning("managed", null, 0)).toBeNull();
	});
});
