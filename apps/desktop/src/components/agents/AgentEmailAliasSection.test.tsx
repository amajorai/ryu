// The agent edit page's Email address section calls Core's agent_inbox tools
// through `callMcpTool`; these cases mock that one seam.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { McpCallResult } from "@/src/lib/api/mcp.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const target: ApiTarget = {
	token: "alias-token",
	url: "https://agent-email.fixture",
	userJwt: null,
};
interface ToolCall {
	agentId: string;
	arguments: unknown;
	tool: string;
}
const calls: ToolCall[] = [];
let respond: (call: ToolCall) => McpCallResult = () => ({ ok: true });

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
mock.module("@/src/lib/api/mcp.ts", () => ({
	callMcpTool: (_target: ApiTarget, input: ToolCall) => {
		calls.push(input);
		return Promise.resolve(respond(input));
	},
}));

const { createRoot } = await import("react-dom/client");
const { AgentEmailAliasSection, NOT_ORG_NODE_TEXT, PENDING_TEXT } =
	await import("./AgentEmailAliasSection.tsx");

let root: Root;
let container: HTMLDivElement;

const noAlias = {
	ok: true,
	output: {
		has_alias: false,
		mailbox: { address: "acme@mail.example.com" },
		ok: true,
	},
};

function aliasOutput(status: string) {
	return {
		address: "nova@acme.mail.example.com",
		display_name: "Nova",
		host: "acme.mail.example.com",
		kind: "alias",
		local_part: "nova",
		status,
	};
}

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(`${label}: ${container.textContent}`);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

function button(label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`no ${label} button: ${container.textContent}`);
	}
	return found;
}

async function typeName(value: string) {
	const input = container.querySelector("input");
	if (!input) {
		throw new Error("no name input");
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function render(agentId: string | null = "nova") {
	await act(async () =>
		root.render(createElement(AgentEmailAliasSection, { agentId }))
	);
}

beforeEach(() => {
	calls.length = 0;
	respond = () => noAlias;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

test("Check calls check_email_alias with the typed name", async () => {
	respond = (call) =>
		call.tool === "agent_inbox.check_email_alias"
			? {
					ok: true,
					output: {
						address: "nova@acme.mail.example.com",
						available: true,
						ok: true,
						suggestions: [],
					},
				}
			: noAlias;
	await render();
	await until(() => container.textContent?.includes("Claim") ?? false, "form");
	expect(calls[0]).toEqual({
		agentId: "nova",
		arguments: {},
		tool: "agent_inbox.get",
	});
	await typeName("Nova");
	await act(async () => button("Check").click());
	await until(
		() => container.textContent?.includes("is available") ?? false,
		"check result"
	);
	expect(calls[1]).toEqual({
		agentId: "nova",
		arguments: { local_part: "Nova" },
		tool: "agent_inbox.check_email_alias",
	});
	expect(container.textContent).toContain("nova@acme.mail.example.com");
});

test("Claim shows the new address on success", async () => {
	respond = (call) =>
		call.tool === "agent_inbox.claim_email_alias"
			? {
					ok: true,
					output: {
						alias: aliasOutput("active"),
						mailbox: { address: "acme@mail.example.com" },
						message: "nova@acme.mail.example.com is now this agent's address.",
						ok: true,
						status: "active",
					},
				}
			: noAlias;
	await render();
	await until(() => container.textContent?.includes("Claim") ?? false, "form");
	await act(async () => button("Claim").click());
	await until(
		() => container.textContent?.includes("Copy") ?? false,
		"claimed alias"
	);
	expect(calls.at(-1)).toEqual({
		agentId: "nova",
		arguments: {},
		tool: "agent_inbox.claim_email_alias",
	});
	expect(container.textContent).toContain("nova@acme.mail.example.com");
	expect(container.textContent).toContain("Active");
	expect(container.textContent).toContain("is now this agent's address");
});

test("a refusal shows its message and suggestions as clickable chips", async () => {
	respond = (call) =>
		call.tool === "agent_inbox.claim_email_alias"
			? {
					ok: true,
					output: {
						code: "alias_taken",
						message:
							"That address is taken, and addresses are never reissued, so retrying it cannot succeed. Choose a different name.",
						ok: false,
						status: 409,
						suggestions: [
							"nova-2@acme.mail.example.com",
							"nova-3@acme.mail.example.com",
						],
					},
				}
			: noAlias;
	await render();
	await until(() => container.textContent?.includes("Claim") ?? false, "form");
	await typeName("nova");
	await act(async () => button("Claim").click());
	await until(
		() => container.textContent?.includes("never reissued") ?? false,
		"refusal"
	);
	await act(async () => button("nova-2@acme.mail.example.com").click());
	expect(container.querySelector("input")?.value).toBe("nova-2");
	await act(async () => button("Claim").click());
	await until(
		() =>
			calls.filter((call) => call.tool === "agent_inbox.claim_email_alias")
				.length === 2,
		"second claim"
	);
	expect(calls.at(-1)?.arguments).toEqual({ local_part: "nova-2" });
});

test("a pending claim says it is waiting for an organization admin", async () => {
	respond = () => ({
		ok: true,
		output: {
			alias: aliasOutput("pending"),
			has_alias: true,
			mailbox: { address: "acme@mail.example.com" },
			ok: true,
		},
	});
	await render();
	await until(
		() => container.textContent?.includes(PENDING_TEXT) ?? false,
		"pending"
	);
	expect(container.textContent).toContain("nova@acme.mail.example.com");
	expect(container.textContent).not.toContain("Claim");
});

test("an existing alias shows the address with a copy button", async () => {
	respond = () => ({
		ok: true,
		output: {
			alias: aliasOutput("active"),
			has_alias: true,
			mailbox: { address: "acme@mail.example.com" },
			ok: true,
		},
	});
	await render();
	await until(
		() => container.textContent?.includes("Copy") ?? false,
		"existing alias"
	);
	expect(
		container.querySelector('[aria-label="Copy nova@acme.mail.example.com"]')
	).not.toBeNull();
	expect(calls).toHaveLength(1);
});

test("an agent on a non-org node is told agent email needs an org node", async () => {
	respond = () => ({
		ok: true,
		output: {
			code: "node_not_org_scoped",
			message: "This node is not enrolled in an organization.",
			ok: false,
			status: 403,
		},
	});
	await render();
	await until(
		() => container.textContent?.includes(NOT_ORG_NODE_TEXT) ?? false,
		"non-org text"
	);
	expect(container.textContent).not.toContain("Claim");
});
