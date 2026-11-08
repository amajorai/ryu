// The panel reads an agent's egress allowlist from Core, stores the edited
// list with PUT (showing Core's normalized result), and clears it with DELETE
// when the limit is switched off.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target: ApiTarget = {
	url: "https://egress-allowlist.fixture",
	token: "egress-token",
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { AgentEgressAllowlistPanel } = await import(
	"./AgentEgressAllowlistPanel.tsx"
);

const PATH = "/api/agents/agent-1/egress-allowlist";
const originalFetch = globalThis.fetch;
let stored: string[] | null = null;
let writes: { method: string; body: unknown }[] = [];
let root: Root;
let container: HTMLDivElement;

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Allowlist panel did not settle: ${container.textContent}`
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

function saveButton(): HTMLButtonElement {
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes("Save allowed sites")
	);
	if (!button) {
		throw new Error("save button absent");
	}
	return button;
}

async function toggleLimit(): Promise<void> {
	const toggle = container.querySelector<HTMLElement>('[role="switch"]');
	if (!toggle) {
		throw new Error("limit switch absent");
	}
	await act(async () => toggle.click());
}

async function typeHosts(value: string): Promise<void> {
	const field = container.querySelector("textarea");
	if (!field) {
		throw new Error("hosts field absent");
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function render(): Promise<void> {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(<AgentEgressAllowlistPanel agentId="agent-1" />)
	);
	await until(
		() => container.textContent?.includes("Save allowed sites") === true
	);
}

beforeEach(() => {
	stored = null;
	writes = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname !== PATH) {
				return Promise.resolve(
					Response.json({ error: "not in fixture" }, { status: 404 })
				);
			}
			const method = init?.method ?? "GET";
			if (method === "PUT") {
				const body = JSON.parse(String(init?.body)) as { allowlist: string[] };
				writes.push({ method, body });
				// Core answers with the normalized, sorted list.
				stored = body.allowlist.map((host) => host.toLowerCase()).sort();
			} else if (method === "DELETE") {
				writes.push({ method, body: init?.body });
				stored = null;
			}
			return Promise.resolve(
				Response.json({ agent_id: "agent-1", allowlist: stored })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("an unrestricted agent shows the limit off and nothing to save", async () => {
	await render();
	expect(container.textContent).toContain("may reach any site");
	expect(container.querySelector("textarea")).toBeNull();
	expect(saveButton().disabled).toBe(true);
});

test("turning the limit on stores the listed hosts as Core normalizes them", async () => {
	await render();
	await toggleLimit();
	await typeHosts("Example.com\n*.docs.example.org, extra.example");
	await act(async () => saveButton().click());
	await until(
		() => container.textContent?.includes("Allowed sites updated.") === true
	);
	expect(writes).toEqual([
		{
			method: "PUT",
			body: {
				allowlist: ["Example.com", "*.docs.example.org", "extra.example"],
			},
		},
	]);
	expect(container.querySelector("textarea")?.value).toBe(
		"*.docs.example.org\nexample.com\nextra.example"
	);
});

test("turning the limit off removes the stored list", async () => {
	stored = ["example.com"];
	await render();
	expect(container.querySelector("textarea")?.value).toBe("example.com");
	await toggleLimit();
	await act(async () => saveButton().click());
	await until(() => writes.length === 1);
	expect(writes[0]?.method).toBe("DELETE");
	await until(() => container.querySelector("textarea") === null);
});

test("more hosts than Core accepts cannot be saved", async () => {
	await render();
	await toggleLimit();
	await typeHosts(
		Array.from({ length: 33 }, (_, index) => `h${index}.example.com`).join("\n")
	);
	expect(container.textContent).toContain("List at most 32 sites.");
	expect(saveButton().disabled).toBe(true);
});
