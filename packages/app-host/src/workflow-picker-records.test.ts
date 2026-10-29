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
	test("preserves complete installed skills, roster and hook event rows", () => {
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
			{ email: null, id: "user", image: null, name: "User", role: null },
		];
		const events = [
			{
				id: "app#changed",
				title: "Changed",
				payload_example: { nested: [null, 1] },
				plugin: "app",
				description: undefined,
			},
		];
		expect(workflowSkillsRecordsSchema.parse(skills)).toBe(skills);
		expect(workflowNotifyTargetsRecordsSchema.parse(users)).toBe(users);
		expect(workflowHookEventsRecordsSchema.parse(events)).toBe(events);
		expect(
			workflowSkillsRecordsSchema.safeParse([{ id: "skill" }]).success
		).toBe(false);
		expect(
			workflowNotifyTargetsRecordsSchema.safeParse([{ ...users[0], email: 4 }])
				.success
		).toBe(false);
		expect(
			workflowHookEventsRecordsSchema.safeParse([
				{ ...events[0], payload_example: [] },
			]).success
		).toBe(false);
	});
	test("preserves both native and desktop MCP normalization including optional meta", () => {
		const server = {
			args: [],
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
					url: null,
				},
			],
			tools: [{ ...tool, meta: { annotations: { readOnly: true } } }],
		};
		expect(Object.is(workflowMcpRecordSchema.parse(native), native)).toBe(true);
		expect(Object.is(workflowMcpRecordSchema.parse(desktop), desktop)).toBe(
			true
		);
		expect(
			workflowMcpRecordSchema.safeParse({
				servers: [{ ...server, args: [1] }],
				tools: [],
			}).success
		).toBe(false);
		expect(
			workflowMcpRecordSchema.safeParse({
				servers: [],
				tools: [{ ...tool, inputSchema: () => null }],
			}).success
		).toBe(false);
	});
	test("retains optional undefined, timezone and execution fields without normalizing jobs", () => {
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
					conversationId: null,
					prompt: "",
				},
				history: [
					{
						error: null,
						finishedAt: "",
						outcome: "failure",
						runId: null,
						startedAt: "",
					},
				],
			},
		];
		expect(
			Object.is(workflowSchedulesRecordsSchema.parse(native), native)
		).toBe(true);
		expect(
			Object.is(workflowSchedulesRecordsSchema.parse(desktop), desktop)
		).toBe(true);
		expect(
			workflowSchedulesRecordsSchema.safeParse([
				{
					...base,
					schedule: { kind: "cron", expr: 7 },
					target: { type: "agent", agentId: "a", prompt: "" },
				},
			]).success
		).toBe(false);
		const invalidMap = JSON.parse('{"__proto__":4}');
		expect(
			workflowSchedulesRecordsSchema.safeParse([
				{
					...base,
					schedule: { kind: "every", interval: "1m" },
					target: { type: "workflow", workflowId: "flow", input: invalidMap },
				},
			]).success
		).toBe(false);
	});
});

test("Composio response decoding follows the requested family and retains future status", () => {
	const status = { baseUrl: "", configured: false, executionOwner: "connect" };
	const toolkit = [
		{ description: null, logo: null, name: "Mail", slug: "mail" },
	];
	const triggers = [
		{
			description: null,
			displayName: "New",
			name: "new",
			toolkit: "mail",
			config: { properties: { field: { default: [null, 1] } } },
		},
	];
	const connections = [
		{
			accessLevel: "risk_based",
			active: false,
			id: "account",
			status: "FUTURE_STATE",
			toolkit: "mail",
		},
	];
	for (const [kind, value] of [
		["status", status],
		["toolkits", toolkit],
		["triggers", triggers],
		["connections", connections],
	] as const) {
		expect(
			Object.is(workflowComposioResponseSchema(kind).parse(value), value)
		).toBe(true);
	}
	expect(
		workflowComposioResponseSchema("triggers").safeParse(toolkit).success
	).toBe(false);
	expect(
		workflowComposioResponseSchema("connections").safeParse([
			{ ...connections[0], accessLevel: "unrestricted" },
		]).success
	).toBe(false);
});

test("Agent catalog retains both platforms and all normalized avatar descriptors", () => {
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
		systemPrompt: null,
		title: "",
		transport: null,
		version: null,
	};
	const glyphs = [
		null,
		{ kind: "avatar", dataUrl: "data:image/png;base64,..." },
		{
			kind: "icon",
			id: "lucide:mail",
			dither: { direction: "up", from: "green", to: null },
		},
		{ kind: "emoji", emoji: "🌿" },
		{ kind: "dicebear", seed: "agent", style: "notionists" },
		{
			kind: "dither",
			dither: { direction: "right", from: "blue", to: "purple" },
		},
		{
			kind: "expressive",
			expression: "curious",
			variant: undefined,
			colors: { c1: "#000000" },
			animation: "random",
		},
	];
	expect(
		Object.is(workflowAgentsRecordsSchema.parse([native])[0], native)
	).toBe(true);
	for (const avatarGlyph of glyphs) {
		const rows = [
			{
				...native,
				avatarGlyph,
				avatarUrl: null,
				latestVersion: null,
				lifecycleStatus: "active",
				recommended: false,
				safetyProfile: "autonomous",
				versionStatus: "future-version-state",
			},
		];
		expect(Object.is(workflowAgentsRecordsSchema.parse(rows), rows)).toBe(true);
	}
	expect(
		workflowAgentsRecordsSchema.safeParse([
			{ ...native, avatarGlyph: { kind: "avatar", dataUrl: 5 } },
		]).success
	).toBe(false);
	expect(workflowAgentsRecordsSchema.safeParse([{ id: "agent" }]).success).toBe(
		false
	);
});

test("App catalogs preserve lifecycle, capabilities and both platforms' presentation metadata", () => {
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
		permissionGrants: [],
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
	const desktop = {
		...native,
		accentColor: null,
		approvedGrants: [],
		category: null,
		channel: "canary",
		description: null,
		external: false,
		icon: null,
		iconBackground: null,
		iconDither: { direction: "future", from: 0, to: null },
		iconPadding: null,
		iconUrl: null,
		layers: [
			{
				capability: "capability",
				target: undefined,
				title: null,
				verbs: ["read"],
			},
		],
		mandatory: false,
		mcpOAuthServers: [
			{ clientId: null, name: "remote", resource: "https://example.invalid" },
		],
		optionalPermissionGrants: [],
		stability: null,
		suppressedBySafeMode: false,
		tagline: null,
		tier: "community",
	};
	expect(Object.is(workflowAppsRecordsSchema.parse([native])[0], native)).toBe(
		true
	);
	const unknownSurface = [{ ...native, targets: ["unknown"] }];
	expect(
		Object.is(workflowAppsRecordsSchema.parse(unknownSurface), unknownSurface)
	).toBe(true);
	expect(
		Object.is(workflowAppsRecordsSchema.parse([desktop])[0], desktop)
	).toBe(true);
	expect(
		workflowAppsRecordsSchema.safeParse([
			{
				...native,
				requires: { apps: [{ id: "dep", minVersion: 7 }], grants: [] },
			},
		]).success
	).toBe(false);
	expect(
		workflowAppsRecordsSchema.safeParse([
			{
				...native,
				runnables: [
					{ config: () => null, id: "run", kind: "tool", name: "Run" },
				],
			},
		]).success
	).toBe(false);
});
