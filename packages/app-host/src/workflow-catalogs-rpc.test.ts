import { describe, expect, test } from "bun:test";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";

// The workflows:catalogs grant is approved for any app id, so the catalog
// methods answer a third-party frame. These rows are what a host service hands
// the dispatcher: Core's rows as the host's own settings pages read them. The
// frame must get picker rows only, and nothing a later Core adds to a row.

const GRANTED: ReadonlySet<Capability> = new Set<Capability>([
	"workflows.catalogs",
]);
const NOW = "2026-01-01T00:00:00Z";
const LATER = "field-added-by-a-later-core";

const HOST_ROWS = {
	mcp: {
		servers: [
			{
				addedLater: LATER,
				args: ["--api-key", "sk-test"],
				authConfigured: true,
				authRequired: true,
				authType: "env",
				available: true,
				command: "npx",
				description: "Orders database",
				enabled: true,
				envKeys: ["DATABASE_PASSWORD"],
				headerNames: [],
				name: "db",
				ownerPluginId: null,
				ownerServerName: null,
				savedKeyAccount: "mcp-secret:db",
				transport: "stdio",
				url: null,
			},
			{
				// Core puts a remote server's URL in `command` as well.
				args: [],
				authConfigured: true,
				authRequired: true,
				authType: "header",
				available: null,
				command: "https://h/x?key=abc",
				description: null,
				enabled: false,
				envKeys: [],
				headerNames: ["X-Account-Token"],
				name: "remote",
				ownerPluginId: "@acme/crm",
				ownerServerName: "crm",
				savedKeyAccount: null,
				transport: "streamable-http",
				url: "https://h/x?key=abc",
			},
		],
		tools: [
			{
				addedLater: LATER,
				description: "Run a query",
				id: "db.query",
				inputSchema: { type: "object", default: "schema-default-value" },
				meta: { annotations: { hint: "tool-meta-value" } },
				name: "query",
				server: "db",
			},
		],
	},
	// The native host's shorter server row, with the URL in `command` only.
	nativeMcp: {
		servers: [
			{
				args: ["--api-key", "sk-test"],
				available: null,
				command: "https://h/x?key=abc",
				description: null,
				enabled: true,
				name: "remote",
			},
		],
		tools: [],
	},
	schedules: [
		{
			addedLater: LATER,
			appId: null,
			createdAt: NOW,
			enabled: true,
			history: [
				{
					error: "provider refused: quota for acct-7781",
					finishedAt: NOW,
					outcome: "failure",
					runId: "run-41",
					startedAt: NOW,
				},
			],
			id: "job-1",
			lastOutcome: "failure",
			lastRunAt: NOW,
			name: "Morning digest",
			ownerApp: null,
			providerAccount: {
				accountId: "acct-7781",
				model: "m",
				prompt: "ping the saved account",
				providerId: "p",
			},
			requireApproval: false,
			schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Lisbon" },
			system: false,
			target: {
				agentId: "agent-1",
				conversationId: "conv-private-1",
				model: "model-x",
				prompt: "Summarise the board minutes and the salary review",
				type: "agent",
			},
			updatedAt: NOW,
		},
		{
			createdAt: NOW,
			enabled: false,
			history: [],
			id: "wf-sched-flow-1-0",
			lastOutcome: null,
			lastRunAt: null,
			name: "Nightly sync",
			schedule: { kind: "every", interval: "6h", jitter: "unlisted" },
			target: {
				input: { customer: "input-value-for-the-run" },
				type: "workflow",
				workflowId: "flow-1",
			},
			updatedAt: NOW,
		},
	],
	notifyTargets: [
		{
			addedLater: LATER,
			email: "ada@example.test",
			id: "user-ada",
			image: null,
			name: "Ada Lovelace",
			role: "owner",
		},
	],
	agents: [
		{
			addedLater: LATER,
			builtIn: false,
			createdAt: NOW,
			description: "Handles billing questions",
			engine: "engine-a",
			id: "agent-1",
			installed: true,
			installHint: "install-hint-text",
			locked: false,
			model: "model-x",
			name: "billing",
			safetyProfile: "autonomous",
			systemPrompt: "You are the billing agent. Internal rule 7 applies.",
			title: "Billing",
			transport: "acp",
			version: "1.2.3",
		},
	],
	apps: [
		{
			addedLater: LATER,
			approvedGrants: ["mail:send"],
			builtIn: false,
			commands: [
				{ method: "POST", name: "sync", path: "/internal/sync", summary: null },
			],
			companion: null,
			description: "Customer records",
			enabled: true,
			id: "@acme/crm",
			installed: true,
			installedVersion: "1.0.0",
			localOnly: false,
			mcpOAuthServers: [
				{
					clientId: "oauth-client-9",
					name: "crm",
					resource: "https://crm.test",
				},
			],
			name: "CRM",
			permissionGrants: ["mail:send", "storage:kv"],
			requires: null,
			runnables: [
				{
					config: { endpoint: "runnable-config-value" },
					id: "lookup",
					kind: "tool",
					name: "Lookup",
				},
			],
			sidecarName: "crm-sidecar",
			surfaceSupport: [],
			targets: ["desktop"],
			version: "1.0.0",
			windowsFirst: false,
		},
	],
	skills: [
		{
			addedLater: LATER,
			allowedTools: ["files.read"],
			description: null,
			enabled: true,
			id: "research",
			name: "Research",
		},
	],
};

function hostReturning(
	rows: typeof HOST_ROWS,
	mcp: unknown = rows.mcp
): HostServices {
	return {
		workflowsAgents: () => Promise.resolve(rows.agents),
		workflowsApps: () => Promise.resolve(rows.apps),
		workflowsMcp: () => Promise.resolve(mcp),
		workflowsNotifyTargets: () => Promise.resolve(rows.notifyTargets),
		workflowsSchedules: () => Promise.resolve(rows.schedules),
		workflowsSkills: () => Promise.resolve(rows.skills),
	} as unknown as HostServices;
}

function call(method: string, services = hostReturning(HOST_ROWS)) {
	return dispatchRpc(method, [], GRANTED, services);
}

describe("workflows catalogs give an app frame picker rows only", () => {
	test("workflows.mcp drops each server's command, arguments and URL", async () => {
		const result = await call("workflows.mcp");
		const text = JSON.stringify(result);
		for (const secret of [
			"--api-key",
			"sk-test",
			"https://h/x?key=abc",
			"key=abc",
			"npx",
			"DATABASE_PASSWORD",
			"X-Account-Token",
			"mcp-secret:db",
			"schema-default-value",
			"tool-meta-value",
			LATER,
		]) {
			expect(text).not.toContain(secret);
		}
		expect(result).toEqual({
			servers: [
				{
					available: true,
					description: "Orders database",
					enabled: true,
					name: "db",
					ownerPluginId: null,
					transport: "stdio",
				},
				{
					available: null,
					description: null,
					enabled: false,
					name: "remote",
					ownerPluginId: "@acme/crm",
					transport: "streamable-http",
				},
			],
			tools: [
				{
					description: "Run a query",
					id: "db.query",
					name: "query",
					server: "db",
				},
			],
		});
		expect(result).not.toBe(HOST_ROWS.mcp);
	});

	test("workflows.mcp does the same for the native host's server row", async () => {
		const result = await call(
			"workflows.mcp",
			hostReturning(HOST_ROWS, HOST_ROWS.nativeMcp)
		);
		const text = JSON.stringify(result);
		expect(text).not.toContain("sk-test");
		expect(text).not.toContain("key=abc");
		expect(result).toEqual({
			servers: [
				{ available: null, description: null, enabled: true, name: "remote" },
			],
			tools: [],
		});
	});

	test("workflows.schedules drops prompts, conversation ids, inputs and run errors", async () => {
		const result = await call("workflows.schedules");
		const text = JSON.stringify(result);
		for (const secret of [
			"Summarise the board minutes",
			"conv-private-1",
			"ping the saved account",
			"acct-7781",
			"input-value-for-the-run",
			"run-41",
			"model-x",
			"unlisted",
			LATER,
		]) {
			expect(text).not.toContain(secret);
		}
		expect(result).toEqual([
			{
				enabled: true,
				id: "job-1",
				lastOutcome: "failure",
				lastRunAt: NOW,
				name: "Morning digest",
				schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Lisbon" },
			},
			{
				enabled: false,
				id: "wf-sched-flow-1-0",
				lastOutcome: null,
				lastRunAt: null,
				name: "Nightly sync",
				schedule: { kind: "every", interval: "6h" },
			},
		]);
	});

	test("workflows.notifyTargets drops each member's email and role", async () => {
		const result = await call("workflows.notifyTargets");
		const text = JSON.stringify(result);
		expect(text).not.toContain("ada@example.test");
		expect(text).not.toContain("example.test");
		expect(text).not.toContain("owner");
		expect(text).not.toContain(LATER);
		// Shipped Workflows bundles require both keys, so they stay and are null.
		expect(result).toEqual([
			{
				email: null,
				id: "user-ada",
				image: null,
				name: "Ada Lovelace",
				role: null,
			},
		]);
	});

	test("workflows.agents drops system prompts", async () => {
		const result = await call("workflows.agents");
		const text = JSON.stringify(result);
		expect(text).not.toContain("Internal rule 7");
		expect(text).not.toContain("install-hint-text");
		expect(text).not.toContain(LATER);
		expect(result).toEqual([
			{
				description: "Handles billing questions",
				engine: "engine-a",
				id: "agent-1",
				installed: true,
				model: "model-x",
				name: "billing",
				title: "Billing",
				transport: "acp",
			},
		]);
	});

	test("workflows.apps drops grants, routes, OAuth clients and runnable config", async () => {
		const result = await call("workflows.apps");
		const text = JSON.stringify(result);
		for (const secret of [
			"mail:send",
			"/internal/sync",
			"oauth-client-9",
			"runnable-config-value",
			"crm-sidecar",
			LATER,
		]) {
			expect(text).not.toContain(secret);
		}
		expect(result).toEqual([
			{
				description: "Customer records",
				enabled: true,
				id: "@acme/crm",
				installed: true,
				name: "CRM",
				runnables: [{ id: "lookup", kind: "tool", name: "Lookup" }],
			},
		]);
	});

	test("workflows.skills drops the tool list", async () => {
		const result = await call("workflows.skills");
		expect(JSON.stringify(result)).not.toContain("files.read");
		expect(JSON.stringify(result)).not.toContain(LATER);
		expect(result).toEqual([
			{ description: null, enabled: true, id: "research", name: "Research" },
		]);
	});

	test("a malformed picker field is still refused", async () => {
		const broken = {
			...HOST_ROWS,
			skills: [{ ...HOST_ROWS.skills[0], name: 7 }],
		} as unknown as typeof HOST_ROWS;
		await expect(
			call("workflows.skills", hostReturning(broken))
		).rejects.toThrow();
	});
});
