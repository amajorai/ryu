// The panel shows each of the agent's own accounts with its login URLs, saves
// a change through Core's login URL route, and shows Core's refusal.

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
	url: "https://login-urls-panel.fixture",
	token: "login-urls-token",
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { AgentAccountLoginUrlsPanel } = await import(
	"./AgentAccountLoginUrlsPanel.tsx"
);
const { parseLoginUrlLines } = await import(
	"./AgentAccountAccessPanel-vault-accounts.ts"
);

const originalFetch = globalThis.fetch;
type Account = Record<string, unknown>;
let accounts: Account[] = [];
let writes: { url: string; body: unknown }[] = [];
let refuse: string | null = null;
let root: Root | null = null;
let container: HTMLDivElement;

function account(id: string, submitUrls: string[]): Account {
	return {
		has_password: true,
		has_totp: false,
		host: "example.com",
		id,
		site: "https://example.com",
		submit_urls: submitUrls,
		username: "helper-bot",
	};
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Login URL panel did not settle: ${container.textContent}`
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

function field(id: string): HTMLTextAreaElement {
	const found = container.querySelector<HTMLTextAreaElement>(
		`[id="agent-account-login-urls-${id}"]`
	);
	if (!found) {
		throw new Error(`${id} field absent`);
	}
	return found;
}

async function type(id: string, value: string): Promise<void> {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	const element = field(id);
	await act(async () => {
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function saveButton(): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes("Save login URLs")
	);
	if (!found) {
		throw new Error("save button absent");
	}
	return found;
}

async function render(): Promise<void> {
	container = document.createElement("div");
	document.body.append(container);
	const created = createRoot(container);
	root = created;
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		created.render(
			<QueryClientProvider client={client}>
				<AgentAccountLoginUrlsPanel agentId="agent 1" />
			</QueryClientProvider>
		)
	);
}

beforeEach(() => {
	accounts = [];
	writes = [];
	refuse = null;
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/vault/agent-accounts" && method === "GET") {
				return Promise.resolve(Response.json({ accounts, attached: [] }));
			}
			if (
				url.pathname === "/api/vault/agent-accounts/login-urls" &&
				method === "PUT"
			) {
				const body = JSON.parse(String(init?.body)) as {
					account: string;
					submit_urls: string[];
				};
				writes.push({ url: `${url.pathname}${url.search}`, body });
				if (refuse) {
					return Promise.resolve(
						Response.json({ error: refuse }, { status: 400 })
					);
				}
				accounts = accounts.map((existing) =>
					existing.id === body.account
						? { ...existing, submit_urls: body.submit_urls }
						: existing
				);
				return Promise.resolve(
					Response.json({ account: account(body.account, body.submit_urls) })
				);
			}
			return Promise.resolve(
				Response.json({ error: "not in fixture" }, { status: 404 })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	const mounted = root;
	root = null;
	if (mounted) {
		await act(async () => mounted.unmount());
		container.remove();
	}
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("login URL lines are trimmed and blank lines skipped", () => {
	expect(
		parseLoginUrlLines(" https://a.example/login \n\n https://a.example/2fa ")
	).toEqual(["https://a.example/login", "https://a.example/2fa"]);
});

test("an agent without accounts shows nothing", async () => {
	await render();
	await act(async () => {
		await Bun.sleep(20);
	});
	expect(container.textContent).toBe("");
});

test("saving sends the account and its login URLs to Core", async () => {
	accounts = [account("example.com--1", ["https://example.com/session"])];
	await render();
	await until(
		() => container.textContent?.includes("Account login URLs") === true
	);
	expect(field("example.com--1").value).toBe("https://example.com/session");
	expect(saveButton().disabled).toBe(true);
	await type(
		"example.com--1",
		"https://example.com/login\n\nhttps://auth.example.com/2fa"
	);
	await act(async () => saveButton().click());
	await until(() => writes.length === 1);
	expect(writes[0]).toEqual({
		url: "/api/vault/agent-accounts/login-urls?agent_id=agent%201",
		body: {
			account: "example.com--1",
			submit_urls: [
				"https://example.com/login",
				"https://auth.example.com/2fa",
			],
		},
	});
	await until(
		() =>
			field("example.com--1").value ===
			"https://example.com/login\nhttps://auth.example.com/2fa"
	);
});

test("Core's refusal is shown and the text is kept", async () => {
	accounts = [account("example.com--1", [])];
	refuse = "login URL must be on example.com or one of its subdomains";
	await render();
	await until(
		() => container.textContent?.includes("Account login URLs") === true
	);
	await type("example.com--1", "https://evil.example.net/login");
	await act(async () => saveButton().click());
	await until(() => container.querySelector('[role="alert"]') !== null);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"must be on example.com"
	);
	expect(field("example.com--1").value).toBe("https://evil.example.net/login");
});
