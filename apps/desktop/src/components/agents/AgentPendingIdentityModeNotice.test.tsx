import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentPendingIdentityModeNotice } = await import(
	"./AgentPendingIdentityModeNotice.tsx"
);

import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

async function mount(selectedMode: AgentIdentityMode, events: string[]) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			createElement(AgentPendingIdentityModeNotice, {
				busy: false,
				disabled: false,
				keptMode: "managed",
				onAccept: (mode: AgentIdentityMode) => events.push(`accept:${mode}`),
				onKeepCurrent: () => events.push("keep"),
				pendingMode: "mixed",
				selectedMode,
			})
		)
	);
}

function button(label: string): HTMLButtonElement {
	const found = [...document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === label
	);
	if (!found) {
		throw new Error(`no ${label} button`);
	}
	return found;
}

test("names the requested and kept modes, and Accept selects the requested one", async () => {
	const events: string[] = [];
	await mount("managed", events);
	const text = document.body.textContent ?? "";
	expect(text).toContain('asks for "Both" instead of "Acts as you"');
	expect(text).toContain('Ryu keeps "Acts as you" until you decide');
	await act(async () => button("Accept").click());
	expect(events).toEqual(["accept:mixed"]);
});

test("Keep current dismisses, and an accepted selection waits for the save", async () => {
	const events: string[] = [];
	await mount("mixed", events);
	expect(button("Accept").disabled).toBe(true);
	expect(document.body.textContent).toContain(
		"Save the agent to accept the request."
	);
	await act(async () => button("Keep current").click());
	expect(events).toEqual(["keep"]);
});
