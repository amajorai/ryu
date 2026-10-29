import { expect, test } from "bun:test";
import {
	deriveConnectionChecklist,
	normalizeAgentConnectionRequirements,
	normalizeConnectionRequirements,
	normalizePackageConnectionRequirements,
	validatePackageManifest,
} from "./index.ts";

test("normalizes canonical package requirements and legacy aliases", () => {
	const requirements = normalizePackageConnectionRequirements({
		connection_requirements: [
			{
				consumers: ["workflow:weekly-report"],
				display_name: "Google Drive",
				id: "google-drive",
				provider: "composio",
				purpose: "Read the customer project folder",
				required: true,
				toolkit: "GOOGLEDRIVE",
				usage: ["read_files"],
			},
		],
	});

	expect(requirements).toEqual([
		{
			consumers: ["workflow:weekly-report"],
			display_name: "Google Drive",
			id: "google-drive",
			provider: "composio",
			purpose: "Read the customer project folder",
			required: true,
			toolkit: "GOOGLEDRIVE",
			usage: ["read_files"],
		},
	]);

	const manifest = validatePackageManifest({
		artifacts: ["workflow.json"],
		capabilities: [],
		connectionRequirements: requirements,
		id: "ryu/report-workflow",
		kind: "workflow",
		name: "Report workflow",
		requires: {},
		schemaVersion: 1,
		security: {
			containsSecrets: false,
			permissions: [],
			privateContent: false,
			redacted: false,
		},
		scopes: ["workflow"],
		targets: ["ryu-desktop"],
		version: "1.0.0",
	});
	expect(manifest.connectionRequirements).toEqual(requirements);
});

test("keeps existing agent connection declarations compatible", () => {
	const requirements = normalizeAgentConnectionRequirements({
		connections: [
			"slack",
			{ provider: "notion", purpose: "Write notes", required: false },
		],
	});

	expect(requirements).toEqual([
		{
			consumers: ["agent"],
			display_name: "Notion",
			id: "notion",
			provider: "notion",
			purpose: "Write notes",
			required: false,
			toolkit: null,
			usage: [],
		},
		{
			consumers: ["agent"],
			display_name: "Slack",
			id: "slack",
			provider: "slack",
			purpose: null,
			required: true,
			toolkit: null,
			usage: [],
		},
	]);
});

test("collapses duplicate ids and merges declarations deterministically", () => {
	const requirements = normalizeConnectionRequirements([
		{
			consumers: ["workflow:weekly-report"],
			id: "slack",
			provider: "slack",
			required: false,
			usage: ["send_messages"],
		},
		{
			consumers: ["agent:researcher"],
			provider: "slack",
			required: true,
			usage: ["read_messages"],
		},
	]);

	expect(requirements).toHaveLength(1);
	expect(requirements[0]).toMatchObject({
		consumers: ["agent:researcher", "workflow:weekly-report"],
		id: "slack",
		required: true,
		usage: ["read_messages", "send_messages"],
	});
});

test("counts required and optional requirements while preserving host states", () => {
	const requirements = normalizeConnectionRequirements([
		{ id: "connected", provider: "slack" },
		{ id: "missing", provider: "notion" },
		{ id: "unavailable", provider: "jira", required: false },
		{ id: "quiet", provider: "linear", required: false },
		{ id: "failed", provider: "github" },
	]);
	const summary = deriveConnectionChecklist(requirements, {
		connected: "connected",
		failed: { message: "timed out", state: "error" },
		missing: "needs_connection",
		unavailable: "unavailable",
	});

	expect(summary.required).toBe(3);
	expect(summary.optional).toBe(2);
	expect(summary.total).toBe(5);
	expect(summary.byState).toEqual({
		connected: 1,
		error: 1,
		needs_connection: 1,
		optional: 1,
		unavailable: 1,
	});
	expect(summary.items.map((item) => [item.id, item.state])).toEqual([
		["connected", "connected"],
		["failed", "error"],
		["missing", "needs_connection"],
		["quiet", "optional"],
		["unavailable", "unavailable"],
	]);
});

test("rejects credential-shaped fields and values before normalization", () => {
	expect(() =>
		normalizeConnectionRequirements({
			connections: [
				{ access_token: "should never be carried", provider: "slack" },
			],
		})
	).toThrow("credential-shaped");

	expect(() =>
		normalizeConnectionRequirements({
			connections: [
				{ provider: "slack", settings: { value: "ghp_12345678901234567890" } },
			],
		})
	).toThrow("credential-shaped");
});

test("preserves cycle diagnostics and checks credentials beyond repeated graph nodes", () => {
	interface CyclicDeclaration {
		metadata?: CyclicDeclaration;
		password?: string;
		provider: string;
	}
	const declaration: CyclicDeclaration = { provider: "github" };
	declaration.metadata = declaration;
	expect(() => normalizeConnectionRequirements(declaration)).toThrow(
		"contains a cyclic value"
	);
	declaration.password = "private";
	expect(() => normalizeConnectionRequirements(declaration)).toThrow(
		"credential-shaped fields and values are not allowed"
	);
	expect(() =>
		normalizeConnectionRequirements(
			JSON.parse('{"connections":["github"],"__proto__":{"token":""}}')
		)
	).toThrow("credential-shaped fields and values are not allowed");
});

test("uses native inherited getter receivers without claiming inherited declaration ownership", () => {
	class Requirement {
		readonly #provider = "github";
		get provider() {
			return this.#provider;
		}
	}
	expect(
		normalizeConnectionRequirements([new Requirement()])[0]?.provider
	).toBe("github");
	expect(normalizeConnectionRequirements(new Requirement())).toEqual([]);
});

test("preserves native Map and function status providers and invalid-status fallback", () => {
	const declarations = [{ provider: "github", required: true }];
	const mapped = deriveConnectionChecklist(
		declarations,
		new Map([["github", { state: "optional" }]])
	);
	expect(mapped.items[0]?.state).toBe("needs_connection");
	const supplied = deriveConnectionChecklist(declarations, () => ({
		state: "connected",
		message: " Ready ",
	}));
	expect(supplied.items[0]?.message).toBe("Ready");
	expect(supplied.items[0]?.state).toBe("connected");
});

test("nested metadata has linear connection-validation cost", () => {
	let metadata = {};
	for (let i = 0; i < 400; i++) {
		metadata = { metadata };
	}
	const started = performance.now();
	expect(
		normalizePackageConnectionRequirements({
			connections: [],
			descriptor: metadata,
		})
	).toEqual([]);
	expect(performance.now() - started).toBeLessThan(500);
});
