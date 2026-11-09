// The panel lists the agent's active fill set from Core, attaches parsed items
// with the chosen time to live, and revokes the active set.

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
	url: "https://fill-set-panel.fixture",
	token: "fill-set-token",
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AgentFillSetPanel } = await import("./AgentFillSetPanel.tsx");

const originalFetch = globalThis.fetch;
type Set = Record<string, unknown>;
let sets: Set[] = [];
let attachRefusal: string | null = null;
let writes: { method: string; path: string; body: unknown }[] = [];
let root: Root;
let container: HTMLDivElement;

function setFrom(items: { key: string; path?: string }[]): Set {
	return {
		agent_id: "agent-1",
		claimed: false,
		created_at: 0,
		expires_at: 3_600_000,
		id: "fs_1",
		items: items.map((item, index) => ({
			environment: "default",
			fields: ["password"],
			handle: `attached:${index}`,
			host: "github.com",
			key: item.key,
			kind: "login",
			path: item.path ?? "/",
			site: "https://github.com",
		})),
	};
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Fill set panel did not settle: ${container.textContent}`
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

function button(label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(label)
	);
	if (!found) {
		throw new Error(`${label} button absent`);
	}
	return found;
}

async function typeItems(value: string): Promise<void> {
	const field = container.querySelector("textarea");
	if (!field) {
		throw new Error("items field absent");
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

async function render(locale?: string): Promise<void> {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const panel = <AgentFillSetPanel agentId="agent-1" />;
	await act(async () =>
		root.render(
			locale ? (
				<I18nProvider initialLocale={locale} initialPackId={null}>
					{panel}
				</I18nProvider>
			) : (
				panel
			)
		)
	);
	await until(
		() =>
			container.textContent?.includes("Attach items") === true ||
			container.textContent?.includes("Revoke attached items") === true
	);
}

beforeEach(() => {
	sets = [];
	writes = [];
	attachRefusal = null;
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/vault/fill-sets" && method === "GET") {
				return Promise.resolve(Response.json({ fillSets: sets }));
			}
			if (url.pathname === "/api/vault/fill-sets" && method === "POST") {
				if (attachRefusal) {
					return Promise.resolve(
						Response.json({ error: attachRefusal }, { status: 409 })
					);
				}
				const body = JSON.parse(String(init?.body)) as {
					items: { key: string; path?: string }[];
				};
				writes.push({ method, path: url.pathname, body });
				sets = [setFrom(body.items)];
				return Promise.resolve(Response.json({ fillSet: sets[0] }));
			}
			if (url.pathname === "/api/vault/fill-sets/fs_1" && method === "DELETE") {
				writes.push({ method, path: url.pathname, body: null });
				sets = [];
				return Promise.resolve(Response.json({ revoked: true }));
			}
			return Promise.resolve(
				Response.json({ error: "not in fixture" }, { status: 404 })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	registerLiteralCatalogLoader(null);
	document.body.removeAttribute("data-ryu-i18n");
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("an agent with no set offers an empty form that cannot be submitted", async () => {
	await render();
	expect(button("Attach items").disabled).toBe(true);
});

test("attaching sends the parsed items and the chosen time to live", async () => {
	await render();
	await typeItems("logins/github https://github.com");
	await act(async () => button("4 hours").click());
	await act(async () => button("Attach items").click());
	await until(
		() => container.textContent?.includes("Revoke attached items") === true
	);
	expect(writes).toEqual([
		{
			method: "POST",
			path: "/api/vault/fill-sets",
			body: {
				agent_id: "agent-1",
				items: [
					{
						box_unbound: false,
						key: "github",
						path: "/logins",
						site: "https://github.com",
						submit_urls: [],
					},
				],
				ttl_secs: 4 * 3600,
			},
		},
	]);
	expect(container.textContent).toContain("/logins/github");
	expect(container.textContent).toContain("github.com");
});

test("a malformed line blocks attaching and says which line", async () => {
	await render();
	await typeItems("ok-key\nbad key here");
	expect(container.textContent).toContain("Line 2 is not folder/key");
	expect(button("Attach items").disabled).toBe(true);
});

test("several malformed lines are listed together in one plural sentence", async () => {
	await render();
	await typeItems("bad key here\nok-key\nbad key two\nbad key three");
	expect(container.textContent).toContain(
		"Lines 1, 3, and 4 are not folder/key followed by a site."
	);
});

test("revoking the active set returns to the empty form", async () => {
	sets = [setFrom([{ key: "github" }])];
	await render();
	expect(container.textContent).toContain("Not used yet");
	await act(async () => button("Revoke attached items").click());
	await until(() => container.textContent?.includes("Attach items") === true);
	expect(writes.map((write) => write.method)).toEqual(["DELETE"]);
});

function input(id: string): HTMLInputElement {
	const found = container.querySelector<HTMLInputElement>(`#${id}`);
	if (!found) {
		throw new Error(`${id} absent`);
	}
	return found;
}

async function typeInto(field: HTMLInputElement, value: string): Promise<void> {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

test("the login URL is prefilled from the item URL and the opt-in shows the capture warning", async () => {
	await render();
	await typeItems(
		"logins/github https://github.com/session\nlogins/bank https://bank.example"
	);
	expect(input("agent-fill-set-login-url-0").value).toBe(
		"https://github.com/session"
	);
	// A site root names no login page, so nothing is prefilled.
	expect(input("agent-fill-set-login-url-1").value).toBe("");
	const warning = container.querySelector(
		"#agent-fill-set-box-unbound-1-warning"
	);
	expect(warning?.textContent?.replace(/\s+/g, " ").trim()).toBe(
		"With this option the agent can capture this password by sending it to another page on the site, and the site stays intercepted for the rest of the Box (no WebSockets)."
	);
	expect(container.textContent).toContain("Allow Box fill without a login URL");
});

test("attaching sends each item's login URL and Box opt-in", async () => {
	await render();
	await typeItems(
		"logins/github https://github.com/session\nlogins/bank https://bank.example"
	);
	await typeInto(
		input("agent-fill-set-login-url-0"),
		"https://github.com/login"
	);
	const optIn = container.querySelector<HTMLElement>(
		"#agent-fill-set-box-unbound-1"
	);
	if (!optIn) {
		throw new Error("opt-in absent");
	}
	await act(async () => optIn.click());
	await act(async () => button("Attach items").click());
	await until(
		() => container.textContent?.includes("Revoke attached items") === true
	);
	expect(writes[0]?.body).toEqual({
		agent_id: "agent-1",
		items: [
			{
				box_unbound: false,
				key: "github",
				path: "/logins",
				site: "https://github.com/session",
				submit_urls: ["https://github.com/login"],
			},
			{
				box_unbound: true,
				key: "bank",
				path: "/logins",
				site: "https://bank.example",
				submit_urls: [],
			},
		],
		ttl_secs: 3600,
	});
});

test("a Core vault refusal shows its sentence without the vault_ code", async () => {
	attachRefusal =
		"vault_conflict: this agent already has an attached vault set; revoke it first";
	await render();
	await typeItems("logins/github https://github.com");
	await act(async () => button("Attach items").click());
	await until(
		() =>
			container.textContent?.includes(
				"This agent already has an attached vault set; revoke it first"
			) === true
	);
	expect(container.textContent).not.toContain("vault_conflict");
	expect(container.textContent).not.toContain("The items were not attached.");
});

test("a Core vault refusal reaches a Japanese reader translated", async () => {
	const ja: Record<string, string> = {
		"This agent may not use your accounts; change its identity in the agent's settings":
			"このエージェントはあなたのアカウントを使えません",
	};
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? ja : {}));
	// With the DOM localizer off, only the panel's own translation can apply.
	document.body.setAttribute("data-ryu-i18n", "off");
	attachRefusal =
		"vault_denied: this agent may not use your accounts; change its identity in the agent's settings";
	await render("ja");
	await typeItems("logins/github https://github.com");
	await act(async () => button("Attach items").click());
	await until(
		() =>
			container.textContent?.includes(
				"このエージェントはあなたのアカウントを使えません"
			) === true
	);
	expect(container.textContent).not.toContain("vault_denied");
	expect(container.textContent).not.toContain("may not use your accounts");
});
