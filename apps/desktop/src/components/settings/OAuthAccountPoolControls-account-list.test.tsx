import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type {
	OAuthAccountPoolPolicy,
	PiAccount,
} from "@/src/lib/api/pi-config.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { AccountOrderList } = await import(
	"./OAuthAccountPoolControls-account-list.tsx"
);
const { applyOrder } = await import("./credential-order.ts");

const roots: Root[] = [];
const originalElementFromPoint = document.elementFromPoint;
const account = (
	accountId: string,
	label: string,
	kind: PiAccount["kind"]
): PiAccount => ({
	accountId,
	label,
	kind,
	active: false,
	gatewayActive: false,
	updatedAt: 0,
});
const WORK = account("work", "Work", "api_key");
const SPARE = account("spare", "Spare", "api_key");
const LOGIN = account("login", "person@example.com", "oauth");
const START: OAuthAccountPoolPolicy = {
	strategy: "fill_first",
	drainThresholdPercent: 80,
	accounts: {
		spare: { enabled: true, priority: 0 },
		login: { enabled: true, priority: 1 },
		work: { enabled: false, priority: 2 },
	},
};
let orders: string[][];
let policy: OAuthAccountPoolPolicy;

function Harness({ accounts }: { accounts: PiAccount[] }) {
	const [draft, setDraft] = useState(START);
	policy = draft;
	return (
		<AccountOrderList
			accounts={accounts}
			capabilities={{
				credentialKinds: ["api_key", "oauth"],
				quotaObservations: false,
				strategies: ["manual", "round_robin", "fill_first"],
			}}
			hints={{ work: "0001", spare: "0002" }}
			onOrder={(order) => {
				orders.push(order);
				setDraft((current) => applyOrder(current, order, ["fill_first"]));
			}}
			onRule={(accountId, change) =>
				setDraft((current) => ({
					...current,
					accounts: {
						...current.accounts,
						[accountId]: {
							...(current.accounts[accountId] ?? {
								enabled: true,
								priority: 0,
							}),
							...change,
						},
					},
				}))
			}
			providerId="openrouter"
			rules={draft.accounts}
			saving={false}
		/>
	);
}

async function mount(accounts: PiAccount[] = [WORK, SPARE, LOGIN]) {
	orders = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(<Harness accounts={accounts} />));
	return root;
}

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	document.elementFromPoint = originalElementFromPoint;
});

const rows = () =>
	[...document.querySelectorAll("[data-credential-row]")].map((row) =>
		row.getAttribute("data-credential-row")
	);
function row(id: string) {
	const element = document.querySelector<HTMLElement>(
		`[data-credential-row="${id}"]`
	);
	if (!element) {
		throw new Error(`Missing row ${id}`);
	}
	return element;
}
function handle(id: string) {
	const element = row(id).querySelector<HTMLButtonElement>(
		'button[draggable="true"]'
	);
	if (!element) {
		throw new Error(`Missing handle ${id}`);
	}
	return element;
}
function labelled(label: string) {
	const element = document.querySelector<HTMLButtonElement>(
		`button[aria-label="${label}"]`
	);
	if (!element) {
		throw new Error(`Missing button ${label}`);
	}
	return element;
}
/** A mouse-shaped event of any type; the pointer fields are added on top. */
function pointerEvent(type: string, pointerType?: string) {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		// Outside every row box, so the row the event is sent to is the target.
		clientX: -1,
		clientY: -1,
	});
	if (pointerType) {
		Object.defineProperty(event, "pointerId", { value: 7 });
		Object.defineProperty(event, "pointerType", { value: pointerType });
	}
	return event;
}
async function send(target: Element, event: Event) {
	await act(async () => {
		target.dispatchEvent(event);
	});
}
const priorities = () =>
	Object.fromEntries(
		Object.entries(policy.accounts).map(([id, rule]) => [id, rule.priority])
	);

test("rows start in saved priority order and show only the end of each key", async () => {
	await mount();
	expect(rows()).toEqual(["spare", "login", "work"]);
	expect(row("spare").textContent).toContain("Key ending in 0002");
	expect(row("work").textContent).toContain("Key ending in 0001");
	expect(row("login").textContent).toContain("Subscription account");
	expect(labelled("Move Spare up").disabled).toBe(true);
	expect(labelled("Move Work down").disabled).toBe(true);
	expect(labelled("Move person@example.com up").disabled).toBe(false);
});

test("the arrow buttons move a row one place and save the order as priorities", async () => {
	await mount();
	await act(async () => labelled("Move Spare down").click());
	expect(rows()).toEqual(["login", "spare", "work"]);
	expect(orders).toEqual([["login", "spare", "work"]]);
	expect(priorities()).toEqual({ login: 0, spare: 1, work: 2 });
	// Being turned off survives a move.
	expect(policy.accounts.work?.enabled).toBe(false);
	expect(
		document.querySelector('[data-slot="order-announcement"]')?.textContent
	).toBe("Spare is now 2 of 3");
	await act(async () => labelled("Move Work up").click());
	await act(async () => labelled("Move Work up").click());
	expect(rows()).toEqual(["work", "login", "spare"]);
	expect(priorities()).toEqual({ work: 0, login: 1, spare: 2 });
});

test("the up and down arrow keys move the focused row and keep the focus on it", async () => {
	await mount();
	handle("work").focus();
	await send(
		handle("work"),
		new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
	);
	expect(rows()).toEqual(["spare", "work", "login"]);
	expect(document.activeElement).toBe(handle("work"));
	await send(
		handle("work"),
		new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
	);
	expect(rows()).toEqual(["spare", "login", "work"]);
	// At the end of the list a further press changes nothing.
	await send(
		handle("work"),
		new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
	);
	expect(orders).toHaveLength(2);
});

test("dragging a row with the mouse drops it next to the row it is dropped on", async () => {
	await mount();
	await send(handle("work"), pointerEvent("dragstart"));
	expect(row("work").className).toContain("opacity-50");
	await send(row("spare"), pointerEvent("dragover"));
	await send(row("spare"), pointerEvent("drop"));
	expect(rows()).toEqual(["work", "spare", "login"]);
	expect(orders).toEqual([["work", "spare", "login"]]);
	expect(row("work").className).not.toContain("opacity-50");
});

test("a drag that ends without a drop changes nothing", async () => {
	await mount();
	await send(handle("work"), pointerEvent("dragstart"));
	await send(row("spare"), pointerEvent("dragover"));
	await send(handle("work"), pointerEvent("dragend"));
	expect(rows()).toEqual(["spare", "login", "work"]);
	expect(orders).toEqual([]);
	expect(row("work").className).not.toContain("opacity-50");
});

test("dragging with a finger follows the pointer and drops on release", async () => {
	await mount();
	document.elementFromPoint = () => row("login");
	await send(handle("spare"), pointerEvent("pointerdown", "touch"));
	expect(row("spare").className).toContain("opacity-50");
	await send(handle("spare"), pointerEvent("pointermove", "touch"));
	await send(handle("spare"), pointerEvent("pointerup", "touch"));
	expect(rows()).toEqual(["login", "spare", "work"]);
	expect(orders).toEqual([["login", "spare", "work"]]);
	expect(row("spare").className).not.toContain("opacity-50");
});

test("a mouse press on the handle does not start the finger drag", async () => {
	await mount();
	document.elementFromPoint = () => row("login");
	await send(handle("spare"), pointerEvent("pointerdown", "mouse"));
	await send(handle("spare"), pointerEvent("pointermove", "mouse"));
	await send(handle("spare"), pointerEvent("pointerup", "mouse"));
	expect(rows()).toEqual(["spare", "login", "work"]);
	expect(orders).toEqual([]);
});

test("typing a priority number does not move the row until the policy is saved", async () => {
	await mount();
	const input = document.querySelector<HTMLInputElement>(
		"#oauth-priority-work"
	);
	if (!input) {
		throw new Error("Missing priority input");
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, "0");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(policy.accounts.work?.priority).toBe(0);
	expect(rows()).toEqual(["spare", "login", "work"]);
	expect(orders).toEqual([]);
});

test("an account added later joins at the end and a removed one leaves", async () => {
	const root = await mount([SPARE, LOGIN]);
	expect(rows()).toEqual(["spare", "login"]);
	await act(async () =>
		root.render(<Harness accounts={[WORK, SPARE, LOGIN]} />)
	);
	expect(rows()).toEqual(["spare", "login", "work"]);
	await act(async () => root.render(<Harness accounts={[WORK, SPARE]} />));
	expect(rows()).toEqual(["spare", "work"]);
	await act(async () => root.render(<Harness accounts={[]} />));
	expect(document.querySelector('[data-slot="credential-order"]')).toBeNull();
});
