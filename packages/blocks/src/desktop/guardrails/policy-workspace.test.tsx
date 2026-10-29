// The workspace's save flow in a DOM: a successful save shows the stored
// version, a version conflict reloads the newer policy instead of keeping
// the stale draft (spec 06.10 PL-14), and a spend cap whose amount is empty or
// not a number never saves as $0 or as the previous cap. An assignment
// write shows in the list at once, even before a fresh list arrives, and the
// Preview control is a visible outline button.

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PolicyAssignmentView, PolicyView } from "./policy-model.ts";
import type { PolicyWorkspaceClient } from "./policy-workspace.tsx";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { PolicyWorkspace } = await import("./policy-workspace.tsx");
const { emptyPolicyRules, UNASSIGNED_POLICY_COPY } = await import(
	"./policy-model.ts"
);

function policy(version: number, name: string): PolicyView {
	return {
		assignments: [],
		description: "",
		id: "gp_1",
		locked: [],
		name,
		rules: { ...emptyPolicyRules(), firewall: { enabled: true } },
		version,
	};
}

class Refusal extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

const options = { agent: [], key: [], member: [], org: [], team: [] };

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/**
 * Type into a controlled field the way React's onChange observes it. React
 * may have been evaluated before the DOM was registered, in which case it
 * watches the focused field's keyup instead of `input`, so send both.
 */
function typeInto(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	input.focus();
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

function buttonNamed(container: HTMLElement, label: string) {
	const button = [...container.querySelectorAll("button")].find((element) =>
		element.textContent?.includes(label)
	);
	if (!button) {
		throw new Error(`no button named ${label}`);
	}
	return button;
}

async function mount(client: PolicyWorkspaceClient) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<PolicyWorkspace
				canEdit
				client={client}
				orgKey="org"
				runWrite={(action) => action()}
				scopeOptions={options}
			/>
		);
	});
	await settle();
	await act(async () => {
		buttonNamed(container, "Baseline").click();
	});
	await settle();
	return {
		container,
		nameInput: () =>
			container.querySelector<HTMLInputElement>(
				"#policy-name"
			) as HTMLInputElement,
		unmount: () => act(async () => root.unmount()),
	};
}

function stubClient(overrides: Partial<PolicyWorkspaceClient>) {
	const client: PolicyWorkspaceClient = {
		archive: async () => null,
		assign: async (input) => ({
			id: "ga_1",
			policyId: input.policyId,
			scope: input.scope,
		}),
		create: async () => policy(1, "Baseline"),
		list: async () => [policy(1, "Baseline")],
		preview: async () => {
			throw new Error("not used");
		},
		unassign: async () => null,
		update: async () => policy(2, "Baseline"),
		...overrides,
	};
	return client;
}

describe("PolicyWorkspace save flow", () => {
	test("a save remounts from the stored version and disables Save", async () => {
		const view = await mount(
			stubClient({
				update: async (_id, input) => ({
					...policy(2, input.name),
					// The server normalizes rules; the editor must show its copy.
					rules: { ...emptyPolicyRules(), firewall: { enabled: true } },
				}),
			})
		);
		await act(async () => {
			typeInto(view.nameInput(), "Baseline two");
		});
		const save = buttonNamed(view.container, "Save policy");
		expect(save.disabled).toBe(false);
		await act(async () => {
			save.click();
		});
		await settle();
		expect(view.nameInput().value).toBe("Baseline two");
		expect(buttonNamed(view.container, "Save policy").disabled).toBe(true);
		expect(view.container.textContent).toContain("Saved as version 2.");
		await view.unmount();
	});

	test("a version conflict reloads the newer policy instead of the stale draft", async () => {
		let lists = 0;
		const view = await mount(
			stubClient({
				list: async () => {
					lists += 1;
					return [
						lists === 1
							? policy(1, "Baseline")
							: policy(2, "Renamed elsewhere"),
					];
				},
				update: async () => {
					throw new Refusal("version_conflict");
				},
			})
		);
		await act(async () => {
			typeInto(view.nameInput(), "My stale edit");
		});
		await act(async () => {
			buttonNamed(view.container, "Save policy").click();
		});
		await settle();
		expect(view.container.textContent).toContain("Someone else saved");
		await act(async () => {
			buttonNamed(view.container, "Reload").click();
		});
		await settle();
		expect(view.nameInput().value).toBe("Renamed elsewhere");
		expect(buttonNamed(view.container, "Save policy").disabled).toBe(true);
		await view.unmount();
	});
});

async function pressPointer(target: Element) {
	await act(async () => {
		for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
			target.dispatchEvent(
				new MouseEvent(type, { bubbles: true, button: 0, cancelable: true })
			);
		}
		(target as HTMLElement).click();
	});
	await settle();
}

describe("PolicyWorkspace spend cap", () => {
	test("picking a window with no amount keeps Save disabled", async () => {
		const writes: unknown[] = [];
		const view = await mount(
			stubClient({
				update: async (_id, input) => {
					writes.push(input.rules.budgets);
					return policy(2, input.name);
				},
			})
		);
		const trigger = view.container.querySelector("#policy-budget-window");
		if (!trigger) {
			throw new Error("no budget window select");
		}
		await pressPointer(trigger);
		const monthly = [...document.querySelectorAll('[role="option"]')].find(
			(element) => element.textContent?.includes("Per month")
		);
		if (!monthly) {
			throw new Error("no Per month option");
		}
		await pressPointer(monthly);
		const amount = view.container.querySelector<HTMLInputElement>(
			"#policy-budget-amount"
		);
		expect(amount?.value).toBe("");
		expect(view.container.textContent).toContain("Enter an amount");
		const save = buttonNamed(view.container, "Save policy");
		expect(save.disabled).toBe(true);
		await act(async () => {
			save.click();
		});
		await settle();
		expect(writes).toEqual([]);
		await view.unmount();
	});

	test("an empty or non-numeric amount blocks saving a stored cap", async () => {
		const writes: unknown[] = [];
		const capped: PolicyView = {
			...policy(1, "Baseline"),
			rules: {
				...emptyPolicyRules(),
				budgets: [{ usdMicro: 30_000_000, window: "daily" }],
			},
		};
		const view = await mount(
			stubClient({
				list: async () => [capped],
				update: async (_id, input) => {
					writes.push(input.rules.budgets);
					return { ...capped, version: 2 };
				},
			})
		);
		const amount = () =>
			view.container.querySelector<HTMLInputElement>(
				"#policy-budget-amount"
			) as HTMLInputElement;
		expect(amount().value).toBe("30");
		// Another edit makes the draft dirty, so only the amount can block Save.
		await act(async () => {
			typeInto(view.nameInput(), "Baseline capped");
		});
		await act(async () => {
			typeInto(amount(), "");
		});
		expect(buttonNamed(view.container, "Save policy").disabled).toBe(true);
		await act(async () => {
			typeInto(amount(), "lots");
		});
		const save = buttonNamed(view.container, "Save policy");
		expect(save.disabled).toBe(true);
		await act(async () => {
			save.click();
		});
		await settle();
		expect(writes).toEqual([]);
		await act(async () => {
			typeInto(amount(), "45");
		});
		await act(async () => {
			buttonNamed(view.container, "Save policy").click();
		});
		await settle();
		expect(writes).toEqual([[{ usdMicro: 45_000_000, window: "daily" }]]);
		await view.unmount();
	});
});

const ORG_SCOPE = { id: "", kind: "org" } as const;

function named(
	id: string,
	name: string,
	assignments: PolicyAssignmentView[] = []
): PolicyView {
	return { ...policy(1, name), assignments, id };
}

/** The smallest element holding `name`'s row in the index, without `other`. */
function rowText(container: HTMLElement, name: string, other: string) {
	let node: HTMLElement | null = buttonNamed(container, name);
	while (
		node?.parentElement &&
		!node.parentElement.textContent?.includes(other)
	) {
		node = node.parentElement;
	}
	return node?.textContent ?? "";
}

describe("PolicyWorkspace assignments", () => {
	// The list never changes, so only the write itself can update the view.
	test("assigning shows the scope at once, even before a fresh list", async () => {
		const stale = [named("gp_1", "Baseline")];
		const view = await mount(stubClient({ list: async () => stale }));
		expect(view.container.textContent).toContain(UNASSIGNED_POLICY_COPY);
		await act(async () => {
			buttonNamed(view.container, "Assign").click();
		});
		await settle();
		expect(view.container.textContent).toContain("Assigned to Organization.");
		expect(view.container.textContent).not.toContain(UNASSIGNED_POLICY_COPY);
		expect(buttonNamed(view.container, "Remove")).toBeTruthy();
		await act(async () => {
			buttonNamed(view.container, "Policies").click();
		});
		await settle();
		expect(rowText(view.container, "Baseline", "Effective policy")).toContain(
			"Organization"
		);
		await view.unmount();
	});

	test("removing an assignment shows the policy unassigned at once", async () => {
		const stale = [
			named("gp_1", "Baseline", [
				{ id: "ga_1", policyId: "gp_1", scope: ORG_SCOPE },
			]),
		];
		const removed: string[] = [];
		const view = await mount(
			stubClient({
				list: async () => stale,
				unassign: async (assignmentId) => {
					removed.push(assignmentId);
					return { deleted: true, id: assignmentId };
				},
			})
		);
		expect(view.container.textContent).not.toContain(UNASSIGNED_POLICY_COPY);
		await act(async () => {
			buttonNamed(view.container, "Remove").click();
		});
		await settle();
		expect(removed).toEqual(["ga_1"]);
		expect(view.container.textContent).toContain("Removed from Organization.");
		expect(view.container.textContent).toContain(UNASSIGNED_POLICY_COPY);
		await view.unmount();
	});

	test("replacing moves the scope from the other policy to this one", async () => {
		const stale = [
			named("gp_1", "Baseline"),
			named("gp_2", "Strict", [
				{ id: "ga_9", policyId: "gp_2", scope: ORG_SCOPE },
			]),
		];
		const sent: unknown[] = [];
		const view = await mount(
			stubClient({
				assign: async (input) => {
					sent.push(input);
					return {
						id: input.assignmentId ?? "ga_new",
						policyId: input.policyId,
						scope: input.scope,
					};
				},
				list: async () => stale,
			})
		);
		await act(async () => {
			buttonNamed(view.container, "Replace assignment").click();
		});
		await settle();
		expect(sent).toEqual([
			{ assignmentId: "ga_9", policyId: "gp_1", scope: ORG_SCOPE },
		]);
		expect(view.container.textContent).toContain(
			"This policy is already assigned here."
		);
		expect(view.container.textContent).not.toContain(UNASSIGNED_POLICY_COPY);
		await act(async () => {
			buttonNamed(view.container, "Policies").click();
		});
		await settle();
		expect(rowText(view.container, "Baseline", "Strict")).toContain(
			"Organization"
		);
		expect(rowText(view.container, "Strict", "Baseline")).toContain(
			UNASSIGNED_POLICY_COPY
		);
		await view.unmount();
	});

	test("a dismissed step-up changes nothing", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<PolicyWorkspace
					canEdit
					client={stubClient({ list: async () => [named("gp_1", "Baseline")] })}
					orgKey="org"
					runWrite={async () => null}
					scopeOptions={options}
				/>
			);
		});
		await settle();
		await act(async () => {
			buttonNamed(container, "Baseline").click();
		});
		await settle();
		await act(async () => {
			buttonNamed(container, "Assign").click();
		});
		await settle();
		expect(container.textContent).toContain(UNASSIGNED_POLICY_COPY);
		expect(container.textContent).not.toContain("Assigned to");
		await act(async () => root.unmount());
	});
});

describe("PolicyWorkspace preview control", () => {
	test("Preview is an outline button, visible on the settings surface", async () => {
		const view = await mount(stubClient({}));
		const preview = buttonNamed(view.container, "Preview");
		expect(preview.getAttribute("data-slot")).toBe("button");
		expect(preview.className).toContain("border-border");
		expect(preview.className).toContain("bg-background");
		expect(preview.className).not.toContain("bg-secondary");
		await view.unmount();
	});
});

describe("PolicyWorkspace keyboard focus", () => {
	test("opening a page focuses its heading and Back returns to the row", async () => {
		const view = await mount(stubClient({}));
		try {
			const heading = view.container.querySelector("h3");
			expect(heading?.textContent).toBe("Baseline");
			// Compare identities, not nodes: a failing toBe would try to print
			// the whole DOM tree.
			expect(document.activeElement === heading).toBe(true);

			await act(async () => {
				buttonNamed(view.container, "Policies").click();
			});
			await settle();
			expect(
				document.activeElement === buttonNamed(view.container, "Baseline")
			).toBe(true);

			await act(async () => {
				buttonNamed(view.container, "Effective policy").click();
			});
			await settle();
			expect(document.activeElement?.textContent).toBe("Effective policy");
			await act(async () => {
				buttonNamed(view.container, "Policies").click();
			});
			await settle();
			expect(
				document.activeElement ===
					buttonNamed(view.container, "Effective policy")
			).toBe(true);
		} finally {
			await view.unmount();
		}
	});
});
