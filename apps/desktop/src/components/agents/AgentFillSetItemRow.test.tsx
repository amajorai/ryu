// One item row of the attach dialog: its login URL field and the Box opt-in
// with the capture warning, reported back through onChange.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { BoxFillChoice } from "@/src/lib/api/agent-fill-sets.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { AgentFillSetItemRow } = await import("./AgentFillSetItemRow.tsx");

let root: Root | null = null;
let container: HTMLDivElement;

afterEach(async () => {
	const mounted = root;
	root = null;
	if (mounted) {
		await act(async () => mounted.unmount());
		container.remove();
	}
});

async function render(
	choice: BoxFillChoice,
	changes: BoxFillChoice[],
	disabled = false
): Promise<void> {
	container = document.createElement("div");
	document.body.append(container);
	const created = createRoot(container);
	root = created;
	await act(async () =>
		created.render(
			<ul>
				<AgentFillSetItemRow
					choice={choice}
					disabled={disabled}
					index={2}
					item={{ key: "github", path: "/logins" }}
					onChange={(next) => changes.push(next)}
				/>
			</ul>
		)
	);
}

test("the row names the item and shows its login URL and the capture warning", async () => {
	await render({ loginUrl: "https://github.com/session", unbound: false }, []);
	expect(container.textContent).toContain("logins/github");
	expect(
		container.querySelector<HTMLInputElement>("#agent-fill-set-login-url-2")
			?.value
	).toBe("https://github.com/session");
	const warning = container.querySelector(
		"#agent-fill-set-box-unbound-2-warning"
	);
	expect(warning?.textContent?.replace(/\s+/g, " ").trim()).toBe(
		"With this option the agent can capture this password by sending it to another page on the site, and the site stays intercepted for the rest of the Box (no WebSockets)."
	);
	// The opt-in is described by the warning, so a screen reader reads it too.
	expect(
		container.querySelector(
			'[aria-describedby="agent-fill-set-box-unbound-2-warning"]'
		)
	).not.toBeNull();
});

test("editing the URL and ticking the opt-in report the new choice", async () => {
	const changes: BoxFillChoice[] = [];
	await render({ loginUrl: "", unbound: false }, changes);
	const field = container.querySelector<HTMLInputElement>(
		"#agent-fill-set-login-url-2"
	);
	if (!field) {
		throw new Error("login URL field absent");
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(field, "https://github.com/login");
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const optIn = container.querySelector<HTMLElement>(
		"#agent-fill-set-box-unbound-2"
	);
	await act(async () => optIn?.click());
	expect(changes).toEqual([
		{ loginUrl: "https://github.com/login", unbound: false },
		{ loginUrl: "", unbound: true },
	]);
});
