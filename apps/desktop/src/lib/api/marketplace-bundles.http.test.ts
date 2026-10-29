import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MarketplaceBundleMember } from "@ryu/marketplace/catalog/bundle-types";
import { z } from "zod";
import { validatePackageManifest } from "../../../../../packages/portable-packages/src/index.ts";
import { buildIndex } from "../../../../../tools/generate-marketplace.mjs";
import { marketplaceBundleDefinitionSchema } from "./marketplace-bundle-contracts.ts";
import { installMarketplaceBundle } from "./marketplace-bundles.ts";
import {
	type PluginDocument,
	type PluginValue,
	pluginDocumentSchema,
} from "./plugin-wire-values.ts";

// Run in its own Bun process: the older orchestration suite mocks these clients.
// Only the HTTP authority is a fixture; the installer and every API client are real.
interface Call {
	authorization: string | null;
	body: PluginDocument | null;
	identity: string | null;
	method: string;
	path: string;
}
const calls: Call[] = [];
const installed = new Set<string>();
const failures = new Map<string, { status: number; body: PluginValue }>();
let catalogWarmupResponse: (() => Promise<Response>) | undefined;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		const body =
			request.method === "POST" && request.headers.get("content-length") !== "0"
				? await request
						.text()
						.then((value) =>
							value ? pluginDocumentSchema.parse(JSON.parse(value)) : null
						)
				: null;
		calls.push({
			path,
			method: request.method,
			body,
			authorization: request.headers.get("authorization"),
			identity: request.headers.get("x-ryu-user-jwt"),
		});
		if (path === "/api/marketplace/public-catalog") {
			if (
				request.method !== "POST" ||
				JSON.stringify(body) !== JSON.stringify({ kind: "bundle" }) ||
				request.headers.get("authorization") !== "Bearer fixture-node" ||
				request.headers.get("x-ryu-user-jwt") !== "fixture-delegation"
			) {
				return Response.json(
					{ error: "invalid scoped catalog preparation" },
					{ status: 400 }
				);
			}
			return catalogWarmupResponse
				? catalogWarmupResponse()
				: Response.json({ success: true });
		}
		if (path === "/fixture/readback") {
			return Response.json([...installed]);
		}
		const id = String(
			body?.id ??
				body?.template_id ??
				decodeURIComponent(path.split("/")[3] ?? "")
		);
		const failure = failures.get(id) ?? failures.get(path);
		if (failure) {
			return Response.json(failure.body, { status: failure.status });
		}
		if (path === "/api/marketplace/usage") {
			return Response.json({ success: true });
		}
		if (installed.has(id)) {
			return Response.json({ error: "already installed" }, { status: 409 });
		}
		installed.add(id);
		if (
			path.startsWith("/api/plugins/") &&
			path !== "/api/plugins/catalog/install"
		) {
			return Response.json({
				app: {
					id,
					enabled: true,
					version: "1.0.0",
					approved_grants: [],
					created_at: null,
					updated_at: null,
				},
			});
		}
		if (path === "/api/plugins/catalog/install") {
			return Response.json({ success: true });
		}
		if (path === "/api/agents/published/install") {
			return Response.json({ agent: { id, name: id }, requires: {} });
		}
		if (path === "/api/skills/catalog/install") {
			return Response.json({
				success: true,
				result: { slug: id, path: `/fixture/skills/${id}` },
			});
		}
		if (path === "/api/mcp/catalog/install") {
			return Response.json({
				success: true,
				server: {
					name: id,
					transport: "stdio",
					command: "fixture",
					args: [],
					url: null,
				},
			});
		}
		if (path === "/api/workflows/catalog/install") {
			return Response.json({ workflow_id: id });
		}
		if (path === "/api/marketplace/packages/install") {
			return Response.json({
				package: {
					id,
					kind: body?.kind,
					enabled: true,
					installed_at_unix_ms: 0,
					package_digest: "fixture-digest",
					version: "1.0.0",
				},
			});
		}
		return Response.json(
			{ error: `unexpected route ${path}` },
			{ status: 404 }
		);
	},
});
const target = {
	url: server.url.toString(),
	token: "fixture-node",
	userJwt: "fixture-delegation",
};
const member = (
	kind: MarketplaceBundleMember["kind"],
	id: string,
	source: string | null = null
): MarketplaceBundleMember => ({ kind, id, source, name: id, required: true });
beforeEach(() => {
	calls.length = 0;
	installed.clear();
	failures.clear();
	catalogWarmupResponse = undefined;
});
afterAll(() => server.stop(true));

test("bundle catalog warmup uses exact scoped preparation before member writes and never creates an installed member", async () => {
	catalogWarmupResponse = () =>
		Promise.resolve(Response.json({ success: true }));
	const members = [member("workflow", "ryu/warmup-flow")];
	const result = await installMarketplaceBundle(
		target,
		"ryu/warmup-bundle",
		members
	);
	expect(calls[0]).toEqual({
		path: "/api/marketplace/public-catalog",
		method: "POST",
		body: { kind: "bundle" },
		authorization: "Bearer fixture-node",
		identity: "fixture-delegation",
	});
	expect(calls.map(({ path }) => path)).toEqual([
		"/api/marketplace/public-catalog",
		"/api/workflows/catalog/install",
		"/api/marketplace/usage",
	]);
	expect(result).toEqual({
		completed: members,
		skipped: [],
		failures: [],
		manual: [],
	});
	expect(
		await fetch(new URL("fixture/readback", server.url)).then((response) =>
			response.json().then(z.array(z.string()).parse)
		)
	).toEqual(["ryu/warmup-flow"]);
});

test("refused catalog warmup remains best effort while member permission failures remain visible", async () => {
	catalogWarmupResponse = () =>
		Promise.resolve(
			Response.json({ error: "catalog preparation forbidden" }, { status: 403 })
		);
	failures.set("ryu/refused-flow", {
		status: 403,
		body: { error: "member installation forbidden" },
	});
	const members = [
		member("workflow", "ryu/refused-flow"),
		member("workflow", "ryu/allowed-flow"),
	];
	const result = await installMarketplaceBundle(
		target,
		"ryu/warmup-refusal",
		members
	);
	expect(calls[0].body).toEqual({ kind: "bundle" });
	expect(calls[0].authorization).toBe("Bearer fixture-node");
	expect(calls[0].identity).toBe("fixture-delegation");
	expect(result.completed).toEqual([members[1]]);
	expect(result.skipped).toEqual([]);
	expect(result.failures).toHaveLength(1);
	expect(result.failures[0].member).toBe(members[0]);
	expect(result.failures[0].error).toContain("member installation forbidden");
	expect(
		await fetch(new URL("fixture/readback", server.url)).then((response) =>
			response.json().then(z.array(z.string()).parse)
		)
	).toEqual(["ryu/allowed-flow"]);
});

test("delayed catalog failure holds member progress until preparation settles then continues exact installation", async () => {
	let release!: (response: Response) => void;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	catalogWarmupResponse = () => {
		markStarted();
		return new Promise<Response>((resolve) => {
			release = resolve;
		});
	};
	const members = [member("workflow", "ryu/delayed-flow")];
	const progress: number[] = [];
	const installing = installMarketplaceBundle(
		target,
		"ryu/delayed-bundle",
		members,
		(event) => progress.push(event.completed)
	);
	await started;
	expect(calls.map(({ path }) => path)).toEqual([
		"/api/marketplace/public-catalog",
	]);
	expect(calls[0].body).toEqual({ kind: "bundle" });
	expect(progress).toEqual([]);
	expect(installed.size).toBe(0);
	release(
		Response.json({ error: "catalog upstream unavailable" }, { status: 503 })
	);
	expect(await installing).toEqual({
		completed: members,
		skipped: [],
		failures: [],
		manual: [],
	});
	expect(progress).toEqual([0, 1]);
	expect(calls.map(({ path }) => path)).toEqual([
		"/api/marketplace/public-catalog",
		"/api/workflows/catalog/install",
		"/api/marketplace/usage",
	]);
	expect(
		await fetch(new URL("fixture/readback", server.url)).then((response) =>
			response.json().then(z.array(z.string()).parse)
		)
	).toEqual(["ryu/delayed-flow"]);
});

test("real clients send sequential per-kind install payloads, scoped admission and progress; readback retains every success", async () => {
	const members = [
		member("app", "@ryu/projects"),
		member("plugin", "@ryu/rtk"),
		member("skill", "ryu/test", "fixture-source"),
		member("agent", "ryu/design-director"),
		member("mcp", "ryu/files"),
		member("workflow", "ryu/flow"),
		member("stack_template", "ryu/stack"),
		...(
			["theme", "language_pack", "output_style", "space", "profile"] as const
		).map((kind) => member(kind, `ryu/${kind}`)),
	];
	const progress: number[] = [];
	const result = await installMarketplaceBundle(
		target,
		"ryu/bundle/fixture",
		members,
		(event) => {
			expect(event.total).toBe(members.length);
			expect(event.member).toBe(
				members[Math.min(Math.floor(progress.length / 2), members.length - 1)]
			);
			progress.push(event.completed);
		}
	);
	expect(result).toEqual({
		completed: members,
		skipped: [],
		failures: [],
		manual: [],
	});
	expect(progress).toEqual(members.flatMap((_, index) => [index, index + 1]));
	expect(calls.map((call) => call.path)).toEqual([
		"/api/marketplace/public-catalog",
		"/api/plugins/%40ryu%2Fprojects/install",
		"/api/plugins/catalog/install",
		"/api/skills/catalog/install",
		"/api/agents/published/install",
		"/api/mcp/catalog/install",
		"/api/workflows/catalog/install",
		"/api/workflows/catalog/install",
		...Array.from({ length: 5 }, () => "/api/marketplace/packages/install"),
		"/api/marketplace/usage",
	]);
	expect(calls.map((call) => call.body)).toEqual([
		{ kind: "bundle" },
		null,
		{ id: "@ryu/rtk" },
		{ id: "ryu/test", source: "fixture-source" },
		{
			id: "ryu/design-director",
			idempotency_key: expect.stringMatching(/^[\da-f-]{36}$/),
		},
		{ id: "ryu/files", force: false },
		{ template_id: "ryu/flow" },
		{ template_id: "ryu/stack" },
		...members.slice(7).map(({ kind, id }) => ({ kind, id })),
		{ event: "download", id: "ryu/bundle/fixture", kind: "bundle" },
	]);
	for (const call of calls) {
		expect(call.method).toBe("POST");
		expect(call.authorization).toBe("Bearer fixture-node");
		expect(call.identity).toBe("fixture-delegation");
	}
	expect(
		await fetch(new URL("fixture/readback", server.url)).then((response) =>
			response.json().then(z.array(z.string()).parse)
		)
	).toEqual(members.map((item) => item.id));
});

test("409 duplicates, permission refusal, semantic failure and unsupported models remain distinct and later members continue", async () => {
	installed.add("@ryu/projects");
	failures.set("@ryu/denied", {
		status: 403,
		body: { error: "permission denied", message: "permission denied" },
	});
	failures.set("ryu/broken", {
		status: 200,
		body: { success: false, error: "source unavailable" },
	});
	failures.set("/api/marketplace/usage", {
		status: 503,
		body: { error: "offline" },
	});
	const members = [
		member("app", "@ryu/projects"),
		member("plugin", "@ryu/denied"),
		member("skill", "ryu/broken"),
		member("model", "ryu/model"),
		member("workflow", "ryu/after"),
	];
	const result = await installMarketplaceBundle(
		target,
		"ryu/bundle/failures",
		members
	);
	expect(result.completed).toEqual([members[4]]);
	expect(result.skipped).toEqual([members[0]]);
	expect(
		result.failures.map(({ member: item, error }) => [item.id, error])
	).toEqual([
		["@ryu/denied", "Gateway denied one or more permission grants."],
		["ryu/broken", "source unavailable"],
	]);
	expect(
		result.manual.map(({ member: item, reason }) => [item.id, reason])
	).toEqual([
		["ryu/model", "choose a model file in Models, then install it there."],
	]);
	expect(installed).toEqual(new Set(["@ryu/projects", "ryu/after"]));
	expect(calls).toHaveLength(6);
});

test("64 member bound and empty bundles preserve exact usage and never install overflow", async () => {
	const members = Array.from({ length: 65 }, (_, index) =>
		member("workflow", `flow-${index}`)
	);
	const result = await installMarketplaceBundle(target, "bounded", members);
	expect(result.completed).toEqual(members.slice(0, 64));
	expect(installed.has("flow-64")).toBe(false);
	expect(calls).toHaveLength(66);
	calls.length = 0;
	expect(await installMarketplaceBundle(target, "empty", [])).toEqual({
		completed: [],
		failures: [],
		skipped: [],
		manual: [],
	});
	expect(calls.map(({ body }) => body)).toEqual([
		{ kind: "bundle" },
		{ event: "download", kind: "bundle", id: "empty" },
	]);
});

test("all 45 shipped bundle definitions install their exact ordered members through real client routing", async () => {
	const root = resolve(
		import.meta.dir,
		"../../../../..",
		"marketplace-store/bundles"
	);
	const slugs = readdirSync(root).sort();
	expect(slugs).toHaveLength(45);
	for (const slug of slugs) {
		installed.clear();
		calls.length = 0;
		const definition = marketplaceBundleDefinitionSchema.parse(
			JSON.parse(readFileSync(resolve(root, slug, "bundle.json"), "utf8"))
		);
		const envelope = validatePackageManifest(
			JSON.parse(readFileSync(resolve(root, slug, "ryu.package.json"), "utf8"))
		);
		const result = await installMarketplaceBundle(
			target,
			envelope.id,
			definition.members
		);
		expect(result.failures, slug).toEqual([]);
		expect(result.completed, slug).toEqual(definition.members);
		expect(result.skipped, slug).toEqual([]);
		expect([...installed], slug).toEqual(
			definition.members.map(({ id }) => id)
		);
		expect(calls.at(-1)?.body, slug).toEqual({
			id: envelope.id,
			kind: "bundle",
			event: "download",
		});
	}
});

test("all shipped bundle local members resolve against the production mirror catalog roots", () => {
	const repository = resolve(import.meta.dir, "../../../../..");
	// Same typed roots as tools/mirror-plugins.sh; no invented skill/MCP mounts.
	const roots = [
		{ dir: resolve(repository, "apps-store"), type: "app" },
		...["plugins", "lsp", "external_plugins"].map((group) => ({
			dir: resolve(repository, "plugins-store", group),
			type: "plugin",
			external: group === "external_plugins",
		})),
		...(
			[
				"agents",
				"workflows",
				"themes",
				"spaces",
				"profiles",
				"bundles",
			] as const
		).map((group) => ({
			dir: resolve(repository, "marketplace-store", group),
			type: group.slice(0, -1),
		})),
	];
	const index = buildIndex(roots);
	const legacyIds = new Map<string, string>();
	for (const root of roots) {
		if (!existsSync(root.dir)) {
			continue;
		}
		for (const slug of readdirSync(root.dir)) {
			const manifestPath = resolve(root.dir, slug, "manifest.json");
			if (!existsSync(manifestPath)) {
				continue;
			}
			const manifest = pluginDocumentSchema.parse(
				JSON.parse(readFileSync(manifestPath, "utf8"))
			);
			legacyIds.set(`${root.type}:${slug}`, z.string().parse(manifest.id));
		}
	}
	const entries = index.entries;
	const localMembers = new Set<string>();
	const remoteMembers = new Set<string>();
	const bundleRoot = resolve(repository, "marketplace-store/bundles");
	for (const slug of readdirSync(bundleRoot).sort()) {
		const definition = marketplaceBundleDefinitionSchema.parse(
			JSON.parse(readFileSync(resolve(bundleRoot, slug, "bundle.json"), "utf8"))
		);
		const projected = entries.find(
			(entry) => entry.type === "bundle" && entry.id === `ryu/bundle/${slug}`
		);
		expect(projected?.includes, slug).toEqual(
			definition.members.map(({ kind, id }) => `${kind}:${id}`)
		);
		for (const item of definition.members) {
			const key = `${item.kind}:${item.id}`;
			if (item.kind === "skill" || item.kind === "mcp") {
				// These authorities resolve remote registries, absent from the local mirror.
				expect(item.id, key).toMatch(/^[^/\s]+\/[^\s]+$/);
				remoteMembers.add(key);
				continue;
			}
			const matches = entries.filter(
				(entry) =>
					entry.type === item.kind &&
					(entry.id === item.id ||
						legacyIds.get(`${entry.type}:${entry.name}`) === item.id)
			);
			expect(matches, `${slug}: ${key}`).toHaveLength(1);
			localMembers.add(key);
		}
	}
	expect(localMembers.size).toBeGreaterThan(0);
	expect(remoteMembers.size).toBeGreaterThan(0);
});
