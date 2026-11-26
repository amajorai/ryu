import { describe, expect, test } from "bun:test";
import {
	workflowAgentsRecordsSchema,
	workflowAppsRecordsSchema,
	workflowComposioResponseSchema,
	workflowHookEventsRecordsSchema,
	workflowMcpRecordSchema,
	workflowNotifyTargetsRecordsSchema,
	workflowSchedulesRecordsSchema,
	workflowSkillsRecordsSchema,
} from "./workflow-picker-records.ts";

describe("workflow picker reply owners", () => {
	test("reduces skills, the roster and hook events to their listed fields", () => {
		const skills = [
			{
				allowedTools: ["files.read"],
				description: null,
				enabled: false,
				id: "skill",
				name: "Skill",
				future: { version: 2 },
			},
		];
		const users = [
			{
				email: "user@example.test",
				id: "user",
				image: null,
				name: "User",
				role: "admin",
			},
		];
		const events = [
			{
				id: "app#changed",
				title: "Changed",
				payload_example: { nested: [null, 1] },
				plugin: "app",
				description: undefined,
				handlerPath: "/internal/handler",
			},
		];
		const pickedSkills = workflowSkillsRecordsSchema.parse(skills);
		expect(pickedSkills).toEqual([
			{ description: null, enabled: false, id: "skill", name: "Skill" },
		]);
		expect(pickedSkills).not.toBe(skills);
		expect(JSON.stringify(pickedSkills)).not.toContain("files.read");
		expect(JSON.stringify(pickedSkills)).not.toContain("future");
		// `email` and `role` stay as keys for shipped Workflows bundles, always null.
		expect(workflowNotifyTargetsRecordsSchema.parse(users)).toEqual([
			{ email: null, id: "user", image: null, name: "User", role: null },
		]);
		const pickedEvents = workflowHookEventsRecordsSchema.parse(events);
		expect(pickedEvents).toEqual([
			{
				id: "app#changed",
				title: "Changed",
				payload_example: { nested: [null, 1] },
				plugin: "app",
			},
		]);
		expect(pickedEvents).not.toBe(events);
		expect(JSON.stringify(pickedEvents)).not.toContain("/internal/handler");
		expect(
			workflowSkillsRecordsSchema.safeParse([{ id: "skill" }]).success
		).toBe(false);
		expect(
			workflowNotifyTargetsRecordsSchema.safeParse([{ ...users[0], image: 4 }])
				.success
		).toBe(false);
		expect(
			workflowHookEventsRecordsSchema.safeParse([
				{ ...events[0], payload_example: [] },
			]).success
		).toBe(false);
	});
	test("reduces native and desktop MCP rows to the same picker fields", () => {
		const server = {
			args: ["--api-key", "sk-test"],
			available: null,
			command: "server",
			description: null,
			enabled: true,
			name: "local",
		};
		const tool = {
			description: null,
			id: "local.read",
			inputSchema: { type: "object", properties: {} },
			name: "read",
			server: "local",
			meta: undefined,
		};
		const pickedTool = {
			description: null,
			id: "local.read",
			name: "read",
			server: "local",
		};
		const native = { servers: [server], tools: [tool] };
		const desktop = {
			servers: [
				{
					...server,
					authConfigured: false,
					authRequired: true,
					authType: "oauth",
					envKeys: [],
					headerNames: [],
					ownerPluginId: null,
					ownerServerName: null,
					transport: "future",
					url: "https://h/x?key=abc",
				},
			],
			tools: [{ ...tool, meta: { annotations: { readOnly: true } } }],
		};
		const pickedNative = workflowMcpRecordSchema.parse(native);
		expect(pickedNative).toEqual({
			servers: [
				{ available: null, description: null, enabled: true, name: "local" },
			],
			tools: [pickedTool],
		});
		expect(pickedNative).not.toBe(native);
		const pickedDesktop = workflowMcpRecordSchema.parse(desktop);
		expect(pickedDesktop).toEqual({
			servers: [
				{
					available: null,
					description: null,
					enabled: true,
					name: "local",
					ownerPluginId: null,
					transport: "future",
				},
			],
			tools: [pickedTool],
		});
		expect(JSON.stringify(pickedDesktop)).not.toContain("sk-test");
		expect(JSON.stringify(pickedDesktop)).not.toContain("key=abc");
		// A picked row parses again to an equal row (host service, then dispatcher).
		expect(workflowMcpRecordSchema.parse(pickedDesktop)).toEqual(pickedDesktop);
		expect(
			workflowMcpRecordSchema.safeParse({
				servers: [{ ...server, enabled: "yes" }],
				tools: [],
			}).success
		).toBe(false);
		expect(
			workflowMcpRecordSchema.safeParse({
				servers: [],
				tools: [{ ...tool, server: 5 }],
			}).success
		).toBe(false);
	});
	test("reduces jobs to id, name, state and schedule without target or history", () => {
		const base = {
			createdAt: "",
			enabled: true,
			history: [],
			id: "job",
			lastOutcome: null,
			lastRunAt: null,
			name: "Job",
			updatedAt: "",
		};
		const picked = {
			enabled: true,
			id: "job",
			lastOutcome: null,
			lastRunAt: null,
			name: "Job",
		};
		const native = [
			{
				...base,
				schedule: { kind: "every", interval: "5m" },
				target: { type: "workflow", workflowId: "flow", input: undefined },
			},
		];
		const desktop = [
			{
				...base,
				ownerApp: null,
				requireApproval: false,
				system: false,
				schedule: { kind: "cron", expr: "0 * * * *", tz: "Europe/Lisbon" },
				target: {
					type: "agent",
					agentId: "agent",
					model: null,
					conversationId: "conversation-1",
					prompt: "the scheduled prompt",
				},
				history: [
					{
						error: "the run error",
						finishedAt: "",
						outcome: "failure",
						runId: null,
						startedAt: "",
					},
				],
			},
		];
		expect(workflowSchedulesRecordsSchema.parse(native)).toEqual([
			{ ...picked, schedule: { kind: "every", interval: "5m" } },
		]);
		const pickedDesktop = workflowSchedulesRecordsSchema.parse(desktop);
		expect(pickedDesktop).toEqual([
			{
				...picked,
				schedule: { kind: "cron", expr: "0 * * * *", tz: "Europe/Lisbon" },
			},
		]);
		expect(pickedDesktop).not.toBe(desktop);
		const text = JSON.stringify(pickedDesktop);
		expect(text).not.toContain("the scheduled prompt");
		expect(text).not.toContain("conversation-1");
		expect(text).not.toContain("the run error");
		expect(
			workflowSchedulesRecordsSchema.safeParse([
				{
					...base,
					schedule: { kind: "cron", expr: 7 },
					target: { type: "agent", agentId: "a", prompt: "" },
				},
			]).success
		).toBe(false);
		expect(
			workflowSchedulesRecordsSchema.safeParse([
				{ ...base, schedule: { kind: "weekly", day: "mon" } },
			]).success
		).toBe(false);
	});
});

test("Composio response decoding follows the requested family and keeps listed fields only", () => {
	const status = {
		baseUrl: "https://connect.internal.test",
		configured: false,
		executionOwner: "connect",
	};
	const toolkit = [
		{ description: null, logo: null, name: "Mail", slug: "mail", later: "x1" },
	];
	const triggers = [
		{
			description: null,
			displayName: "New",
			name: "new",
			toolkit: "mail",
			config: { properties: { field: { default: [null, 1] } } },
			later: "x2",
		},
	];
	const connections = [
		{
			accessLevel: "risk_based",
			active: false,
			id: "account",
			status: "FUTURE_STATE",
			toolkit: "mail",
			later: "x3",
		},
	];
	expect(workflowComposioResponseSchema("status").parse(status)).toEqual({
		configured: false,
		executionOwner: "connect",
	});
	expect(workflowComposioResponseSchema("toolkits").parse(toolkit)).toEqual([
		{ description: null, logo: null, name: "Mail", slug: "mail" },
	]);
	expect(workflowComposioResponseSchema("triggers").parse(triggers)).toEqual([
		{
			description: null,
			displayName: "New",
			name: "new",
			toolkit: "mail",
			config: { properties: { field: { default: [null, 1] } } },
		},
	]);
	expect(
		workflowComposioResponseSchema("connections").parse(connections)
	).toEqual([
		{
			accessLevel: "risk_based",
			active: false,
			id: "account",
			status: "FUTURE_STATE",
			toolkit: "mail",
		},
	]);
	expect(workflowComposioResponseSchema("toolkits").parse(toolkit)).not.toBe(
		toolkit
	);
	expect(
		workflowComposioResponseSchema("triggers").safeParse(toolkit).success
	).toBe(false);
	expect(
		workflowComposioResponseSchema("connections").safeParse([
			{ ...connections[0], accessLevel: "unrestricted" },
		]).success
	).toBe(false);
});

test("Agent catalog reduces both platforms to picker fields without the system prompt", () => {
	const native = {
		builtIn: false,
		createdAt: null,
		description: null,
		engine: null,
		gatewayBypass: true,
		id: "agent",
		installed: null,
		installHint: null,
		locked: false,
		model: null,
		name: "Agent",
		systemPrompt: "the system prompt",
		title: "",
		transport: null,
		version: null,
	};
	const picked = {
		description: null,
		engine: null,
		id: "agent",
		installed: null,
		model: null,
		name: "Agent",
		title: "",
		transport: null,
	};
	const desktop = {
		...native,
		avatarGlyph: { kind: "avatar", dataUrl: "data:image/png;base64,..." },
		avatarUrl: null,
		latestVersion: null,
		lifecycleStatus: "active",
		recommended: false,
		safetyProfile: "autonomous",
		versionStatus: "future-version-state",
	};
	const rows = [native, desktop];
	const pickedRows = workflowAgentsRecordsSchema.parse(rows);
	expect(pickedRows).toEqual([picked, picked]);
	expect(pickedRows).not.toBe(rows);
	expect(JSON.stringify(pickedRows)).not.toContain("the system prompt");
	expect(
		workflowAgentsRecordsSchema.safeParse([{ ...native, title: 5 }]).success
	).toBe(false);
	expect(workflowAgentsRecordsSchema.safeParse([{ id: "agent" }]).success).toBe(
		false
	);
});

test("App catalogs reduce both platforms to id, name, state and runnable labels", () => {
	const native = {
		builtIn: false,
		commands: [{ method: "POST", name: "sync", path: "/sync", summary: null }],
		companion: null,
		enabled: false,
		id: "app",
		installed: true,
		installedVersion: "1",
		localOnly: false,
		name: "App",
		permissionGrants: ["mail:send"],
		requires: { apps: [{ id: "dep", minVersion: null }], grants: [] },
		runnables: [
			{
				config: [null, { future: true }],
				id: "run",
				kind: "future-kind",
				name: "Run",
			},
		],
		sidecarName: null,
		surfaceSupport: [{ surface: "future-surface", support: "future-support" }],
		targets: ["mobile"],
		version: "2",
		windowsFirst: false,
	};
	const picked = {
		enabled: false,
		id: "app",
		installed: true,
		name: "App",
		runnables: [{ id: "run", kind: "future-kind", name: "Run" }],
	};
	const desktop = {
		...native,
		accentColor: null,
		approvedGrants: ["mail:send"],
		category: null,
		channel: "canary",
		description: null,
		external: false,
		icon: null,
		mandatory: false,
		mcpOAuthServers: [
			{
				clientId: "client-1",
				name: "remote",
				resource: "https://example.invalid",
			},
		],
		optionalPermissionGrants: [],
		tier: "community",
	};
	const pickedNative = workflowAppsRecordsSchema.parse([native]);
	expect(pickedNative).toEqual([picked]);
	expect(pickedNative).not.toContain(native);
	const pickedDesktop = workflowAppsRecordsSchema.parse([desktop]);
	expect(pickedDesktop).toEqual([{ ...picked, description: null }]);
	const text = JSON.stringify(pickedDesktop);
	expect(text).not.toContain("mail:send");
	expect(text).not.toContain("client-1");
	expect(text).not.toContain("/sync");
	expect(
		workflowAppsRecordsSchema.safeParse([{ ...native, installed: "yes" }])
			.success
	).toBe(false);
	expect(
		workflowAppsRecordsSchema.safeParse([
			{
				...native,
				runnables: [{ config: null, id: "run", kind: 5, name: "Run" }],
			},
		]).success
	).toBe(false);
});
