import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register before React and isolate this file from non-browser Bun suites.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

import type {
	UseAgentLaunchCheckInput,
	UseAgentLaunchCheckResult,
} from "@/src/hooks/useAgentLaunchCheck.ts";
import type { AgentInput, AgentLaunchCheck } from "@/src/lib/api/agents.ts";

// The dialog's own flow is under test; its heavy children and data hooks are
// stand-ins so this stays a fast, network-free DOM test.
const created: AgentInput[] = [];
const realAgents = await import("@/src/hooks/useAgents.ts");
mock.module("@/src/hooks/useAgents.ts", () => ({
	...realAgents,
	useAgents: () => ({
		agents: [],
		create: (input: AgentInput) => {
			created.push(input);
			return Promise.resolve({ id: "new-agent" });
		},
	}),
}));
const realActiveNode = await import("@/src/hooks/useActiveNode.ts");
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	...realActiveNode,
	useActiveNode: () => ({
		name: "Synthetic node",
		token: "synthetic-create-node",
		url: "http://127.0.0.1:7982",
		userJwt: null,
	}),
}));
const realTabs = await import("@/src/contexts/TabsContext.tsx");
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	...realTabs,
	useTabSelector: () => () => undefined,
}));
mock.module("@/src/components/agents/AgentSetupComposer.tsx", () => ({
	AgentSetupComposer: () => null,
}));
mock.module("@/src/components/agents/AgentImageField.tsx", () => ({
	AgentImageField: () => null,
}));
mock.module("@ryu/ui/components/employee-badge.tsx", () => ({
	EmployeeBadge: () => null,
}));
// Core's launch check, answered per engine by the test that needs it. The
// default is "no answer yet", as with a Core that has no launch check.
const launchInputs: UseAgentLaunchCheckInput[] = [];
let answerLaunch: (input: UseAgentLaunchCheckInput) => AgentLaunchCheck | null =
	() => null;
mock.module("@/src/hooks/useAgentLaunchCheck.ts", () => ({
	useAgentLaunchCheck: (
		input: UseAgentLaunchCheckInput
	): UseAgentLaunchCheckResult => {
		launchInputs.push(input);
		const check = answerLaunch(input);
		return {
			check,
			pending: false,
			refused: check !== null && !check.launchable,
		};
	},
}));

const CLAUDE_REFUSAL =
	"This engine calls Anthropic itself, using your own sign-in or key, and this agent's account access doesn't allow Anthropic.";

function launchCheck(fields: Partial<AgentLaunchCheck>): AgentLaunchCheck {
	return {
		code: null,
		launchable: true,
		limitedModelSource: null,
		modelWarning: null,
		reason: null,
		runsOnManagedPi: false,
		sandboxSupported: true,
		vendorProvider: null,
		...fields,
	};
}

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CreateAgentDialog } = await import("./CreateAgentDialog.tsx");
const { useCreateAgentDialog } = await import(
	"@/src/store/useCreateAgentDialog.ts"
);

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	created.length = 0;
	launchInputs.length = 0;
	answerLaunch = () => null;
	useCreateAgentDialog.setState({ open: false });
	document.body.replaceChildren();
});

async function mount() {
	useCreateAgentDialog.setState({ open: true });
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(createElement(CreateAgentDialog)));
}

function button(label: string): HTMLButtonElement {
	const matches = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].filter((element) => element.textContent?.trim() === label);
	const element = matches[0];
	if (matches.length !== 1 || !element) {
		throw new Error(
			`Expected one button named ${label}, found ${matches.length}`
		);
	}
	return element;
}

function inputWithMaxLength(maxLength: number): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>(
		`input[maxlength="${maxLength}"]`
	);
	if (!element) {
		throw new Error(`Expected an input with maxlength ${maxLength}`);
	}
	return element;
}

/** The Name field (64 characters) on the details step. */
function nameInput(): HTMLInputElement {
	return inputWithMaxLength(64);
}

/** The Title badge field (48 characters) on the details step. */
function titleInput(): HTMLInputElement {
	return inputWithMaxLength(48);
}

/** Types into a React-controlled input the way a user's keystrokes would. */
async function typeInto(element: HTMLInputElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setValue?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("CreateAgentDialog identity step", () => {
	test("opens on the identity question before the details", async () => {
		await mount();
		const text = document.body.textContent ?? "";

		expect(text).toContain("How should this agent work?");
		expect(text).toContain(
			"You can change this later in the agent's settings."
		);
		expect(document.querySelectorAll('[role="radio"]')).toHaveLength(3);
		expect(text).not.toContain("Title badge");
	});

	test("the chosen mode carries into the created agent", async () => {
		await mount();
		const card = document.querySelector<HTMLElement>(
			'[data-identity-mode="individual"]'
		);
		await act(async () => card?.click());
		await act(async () => button("Continue").click());

		const text = document.body.textContent ?? "";
		expect(text).toContain("Title badge");
		expect(text).toContain("Its own identity");

		await act(async () => button("Create agent").click());

		expect(created).toHaveLength(1);
		expect(created[0]?.identityMode).toBe("individual");
		expect(created[0]?.accountAccess).toBeUndefined();
	});

	test("Change returns to the question with the choice kept", async () => {
		await mount();
		const card = document.querySelector<HTMLElement>(
			'[data-identity-mode="mixed"]'
		);
		await act(async () => card?.click());
		await act(async () => button("Continue").click());
		await act(async () => button("Change").click());

		const checked = document.querySelector(
			'[role="radio"][aria-checked="true"]'
		);
		expect(
			checked
				?.closest("[data-identity-mode]")
				?.getAttribute("data-identity-mode")
		).toBe("mixed");
	});

	test("dismissing asks the question again but keeps the draft", async () => {
		await mount();
		const card = document.querySelector<HTMLElement>(
			'[data-identity-mode="individual"]'
		);
		await act(async () => card?.click());
		await act(async () => button("Continue").click());
		expect(document.body.textContent ?? "").toContain("Title badge");
		const draftName = nameInput().value;
		expect(draftName.length).toBeGreaterThan(0);
		await typeInto(titleInput(), "Release lead");

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(useCreateAgentDialog.getState().open).toBe(false);

		await act(async () => useCreateAgentDialog.setState({ open: true }));
		const text = document.body.textContent ?? "";
		expect(text).toContain("How should this agent work?");
		expect(text).not.toContain("Title badge");
		const checked = document.querySelector(
			'[role="radio"][aria-checked="true"]'
		);
		expect(
			checked
				?.closest("[data-identity-mode]")
				?.getAttribute("data-identity-mode")
		).toBe("managed");

		await act(async () => button("Continue").click());
		expect(nameInput().value).toBe(draftName);
		expect(titleInput().value).toBe("Release lead");
	});
});

describe("CreateAgentDialog launch check", () => {
	async function chooseIndividual() {
		const card = document.querySelector<HTMLElement>(
			'[data-identity-mode="individual"]'
		);
		await act(async () => card?.click());
	}

	test("a refused engine shows Core's reason and keeps Create disabled until Ryu is chosen", async () => {
		answerLaunch = (input) =>
			input.engine === "acp:pi"
				? launchCheck({ runsOnManagedPi: true })
				: launchCheck({
						code: "provider_access_refused",
						launchable: false,
						reason: CLAUDE_REFUSAL,
						vendorProvider: "anthropic",
					});
		await mount();
		await chooseIndividual();
		await act(async () => button("Continue").click());

		expect(document.body.textContent ?? "").toContain(CLAUDE_REFUSAL);
		expect(button("Create agent").disabled).toBe(true);
		expect(button("Advanced setup").disabled).toBe(true);
		await act(async () => button("Create agent").click());
		expect(created).toHaveLength(0);

		await act(async () => button("Use Ryu instead").click());

		expect(launchInputs.at(-1)).toMatchObject({
			accountAccess: null,
			engine: "acp:pi",
			identityMode: "individual",
		});
		expect(document.body.textContent ?? "").not.toContain(CLAUDE_REFUSAL);
		expect(button("Create agent").disabled).toBe(false);
		await act(async () => button("Create agent").click());
		expect(created).toHaveLength(1);
		expect(created[0]?.engine).toBe("acp:pi");
		expect(created[0]?.identityMode).toBe("individual");
	});

	test("a Both agent that needs the sandbox offers a limit, not a switch to Ryu", async () => {
		const sandboxRefusal =
			"This computer can't confine this agent. Turn on Limit to selected accounts.";
		answerLaunch = (input) =>
			input.accountAccess === null
				? launchCheck({
						code: "account_access_sandbox_unavailable",
						launchable: false,
						reason: sandboxRefusal,
						sandboxSupported: false,
					})
				: launchCheck({ runsOnManagedPi: true, sandboxSupported: false });
		await mount();
		await act(async () =>
			document
				.querySelector<HTMLElement>('[data-identity-mode="mixed"]')
				?.click()
		);
		await act(async () => button("Continue").click());

		expect(document.body.textContent ?? "").toContain(sandboxRefusal);
		expect(button("Create agent").disabled).toBe(true);
		// Switching to Ryu would be refused the same way, so it is not offered.
		expect(
			[...document.querySelectorAll("button")].some(
				(element) => element.textContent?.trim() === "Use Ryu instead"
			)
		).toBe(false);

		await act(async () => button("Limit to selected accounts").click());
		expect(launchInputs.at(-1)).toMatchObject({
			accountAccess: [],
			identityMode: "mixed",
		});
		expect(button("Create agent").disabled).toBe(false);
		await act(async () => button("Create agent").click());
		expect(created).toHaveLength(1);
		expect(created[0]?.accountAccess).toEqual([]);
		expect(created[0]?.identityMode).toBe("mixed");
	});

	test("the identity step says when only Ryu can run a limited agent here", async () => {
		answerLaunch = () => launchCheck({ sandboxSupported: false });
		await mount();
		const note =
			"On this computer, an agent with its own identity or limited accounts can run only on Ryu (without shell or file tools).";
		// Acting as you with no limit needs no sandbox.
		expect(document.body.textContent ?? "").not.toContain(note);

		await chooseIndividual();
		expect(document.body.textContent ?? "").toContain(note);
	});

	test("Core's model warning shows without blocking Create", async () => {
		const warning =
			"This agent has no model it can use, so its turns will fail.";
		answerLaunch = () =>
			launchCheck({
				limitedModelSource: "local",
				modelWarning: warning,
				runsOnManagedPi: true,
			});
		await mount();
		await chooseIndividual();
		await act(async () => button("Continue").click());

		expect(document.body.textContent ?? "").toContain(warning);
		expect(button("Create agent").disabled).toBe(false);
	});

	test("a launchable answer, or none, leaves Create alone", async () => {
		await mount();
		await chooseIndividual();
		await act(async () => button("Continue").click());
		expect(button("Create agent").disabled).toBe(false);
		expect(document.querySelector('[data-testid="agent-launch-warning"]')).toBe(
			null
		);
	});
});
