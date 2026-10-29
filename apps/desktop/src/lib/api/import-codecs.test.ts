// apps/desktop/src/lib/api/import-codecs.test.ts
//
// Core owns the import vocabulary: `import::kind::*` in
// `apps/core/src/import/mod.rs` (item kinds, including the chat-export
// `conversations` group) and `normalize_provider` in
// `apps/core/src/server/agent_sync.rs` (sync providers, including the chat-export
// sources `chatgpt` and `claude-ai` and the framework sources). The Desktop
// response codecs for `/api/import/run` and `/api/agent-sync/*` once lagged
// behind that vocabulary: a ChatGPT export import came back as a ZodError instead
// of a result, and a Hermes or OpenClaw profile made the whole profile list
// unreadable. These cases drive every wire value through the real request path
// (a real HTTP server, no stubbed codec) so a value Core emits and a client
// codec rejects cannot go unnoticed again.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MIGRATION_SOURCES } from "../agent-migration.ts";
import {
	getAgentSyncStatus,
	importAgentSyncItems,
	listAgentSyncProfiles,
	SYNC_PROVIDERS,
	type SyncProvider,
	saveAgentSyncProfile,
	scanAgentSyncRoot,
} from "./agent-sync.ts";
import { IMPORT_ITEM_KINDS, type ImportItemKind, runImport } from "./import.ts";

// Written out by hand from Core (not derived from the client), and typed as a
// `Record` so that adding a member to either TypeScript union without extending
// this list is a type error instead of a silently shorter loop.
const PROVIDER_TABLE: Record<SyncProvider, true> = {
	claude: true,
	codex: true,
	cursor: true,
	openclaw: true,
	hermes: true,
	muse: true,
	mastra: true,
	langchain: true,
	persona: true,
	chatgpt: true,
	"claude-ai": true,
	other: true,
};
const KIND_TABLE: Record<ImportItemKind, true> = {
	instructions: true,
	skill: true,
	mcp_server: true,
	plugin: true,
	memory: true,
	agent: true,
	slash_command: true,
	conversations: true,
};
const PROVIDERS = Object.keys(PROVIDER_TABLE) as SyncProvider[];
const KINDS = Object.keys(KIND_TABLE) as ImportItemKind[];

const UNKNOWN_PROVIDER = "martian-framework";
const UNKNOWN_KIND = "telepathy";

type WireBody = Record<string, unknown>;

async function withNode<T>(
	routes: Record<string, WireBody>,
	run: (target: { token: string; url: string }) => Promise<T>
): Promise<T> {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const body = routes[new URL(request.url).pathname];
			return body === undefined
				? Response.json({ error: "not found" }, { status: 404 })
				: Response.json(body);
		},
	});
	try {
		return await run({ url: server.url.origin, token: "fixture" });
	} finally {
		server.stop(true);
	}
}

function profile(provider: string, index: number): WireBody {
	return {
		conflictCount: 0,
		exportEnabled: true,
		id: `profile-${index}`,
		importEnabled: true,
		lastOperationId: null,
		provider,
		root: `/fixtures/${provider}`,
		status: "ready",
		updatedAt: 1_700_000_000 + index,
	};
}

function scanBody(provider: string, kinds: string[]): WireBody {
	return {
		agentId: null,
		capabilities: {
			acpLoadResume: null,
			nativeConversationExport: false,
			nativeThreads: false,
			note: null,
			portableBundle: true,
			setupImport: true,
		},
		items: kinds.map((kind) => ({
			id: `${kind}/item`,
			kind,
			title: `A ${kind}`,
		})),
		provider,
		root: `/fixtures/${provider}`,
		threads: [],
		warnings: [],
	};
}

function outcomes(kinds: string[]): WireBody[] {
	return kinds.map((kind) => ({
		id: `${kind}/item`,
		kind,
		status: "imported",
		title: `A ${kind}`,
	}));
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort();
}

const CORE_SRC = join(import.meta.dir, "../../../../core/src");

function coreSource(file: string): string {
	return readFileSync(join(CORE_SRC, file), "utf8");
}

/** The string values of `pub const X: &str = "…";` inside `pub mod kind { … }`. */
function coreImportKinds(): string[] {
	const block = coreSource("import/mod.rs").match(
		/pub mod kind \{([\s\S]*?)\n\}/
	)?.[1];
	if (!block) {
		throw new Error("import-codecs.test.ts: Core `pub mod kind` not found");
	}
	return [...block.matchAll(/pub const [A-Z_]+: &str = "([^"]+)";/g)].map(
		(match) => match[1] ?? ""
	);
}

/** The provider names `normalize_provider` lets through. */
function coreSyncProviders(): string[] {
	const source = coreSource("server/agent_sync.rs");
	const start = source.indexOf("fn normalize_provider(");
	const matchesAt = source.indexOf("matches!(", start);
	const end = source.indexOf("unsupported provider", matchesAt);
	if (start < 0 || matchesAt < 0 || end < 0) {
		throw new Error(
			"import-codecs.test.ts: Core `normalize_provider` allow-list not found"
		);
	}
	return [...source.slice(matchesAt, end).matchAll(/"([^"]+)"/g)].map(
		(match) => match[1] ?? ""
	);
}

describe("the shared vocabulary covers Core's wire values", () => {
	test("lists every sync provider and import kind once", () => {
		expect(PROVIDERS).toHaveLength(12);
		expect(KINDS).toHaveLength(8);
		expect(new Set(PROVIDERS).size).toBe(PROVIDERS.length);
		expect(new Set(KINDS).size).toBe(KINDS.length);
	});

	test("the exported lists the codecs derive from match the Core vocabulary", () => {
		expect(sorted(SYNC_PROVIDERS)).toEqual(sorted(PROVIDERS));
		expect(sorted(IMPORT_ITEM_KINDS)).toEqual(sorted(KINDS));
	});

	test("the exported lists match what Core's source allows", () => {
		expect(sorted(SYNC_PROVIDERS)).toEqual(sorted(coreSyncProviders()));
		expect(sorted(IMPORT_ITEM_KINDS)).toEqual(sorted(coreImportKinds()));
	});

	test("every migration source the UI offers is a provider Core accepts", () => {
		for (const source of MIGRATION_SOURCES) {
			expect(SYNC_PROVIDERS as readonly string[]).toContain(source.id);
		}
	});
});

describe("agent-sync response codecs accept every sync provider", () => {
	test("scanAgentSyncRoot reads the provider of every scan", async () => {
		const seen: string[] = [];
		for (const provider of PROVIDERS) {
			await withNode(
				{ "/api/agent-sync/scan": scanBody(provider, ["skill"]) },
				async (target) => {
					const scan = await scanAgentSyncRoot(target, "/fixtures", provider);
					seen.push(scan.provider);
				}
			);
		}
		expect(seen).toEqual(PROVIDERS);
	});

	test("listAgentSyncProfiles keeps a saved profile of every provider", async () => {
		await withNode(
			{
				"/api/agent-sync/profiles": {
					profiles: PROVIDERS.map(profile),
				},
			},
			async (target) => {
				const { profiles } = await listAgentSyncProfiles(target);
				expect(profiles.map((p) => p.provider)).toEqual(PROVIDERS);
			}
		);
	});

	test("saveAgentSyncProfile returns the saved profile of every provider", async () => {
		const seen: string[] = [];
		for (const [index, provider] of PROVIDERS.entries()) {
			await withNode(
				{ "/api/agent-sync/profiles": profile(provider, index) },
				async (target) => {
					const saved = await saveAgentSyncProfile(target, {
						exportEnabled: true,
						importEnabled: true,
						provider,
						root: `/fixtures/${provider}`,
					});
					seen.push(saved.provider);
				}
			);
		}
		expect(seen).toEqual(PROVIDERS);
	});

	test("getAgentSyncStatus reads a profile of every provider", async () => {
		await withNode(
			{
				"/api/agent-sync/status": {
					activeOperations: 0,
					bindings: [],
					items: [],
					nodeId: "local",
					profiles: PROVIDERS.map(profile),
				},
			},
			async (target) => {
				const status = await getAgentSyncStatus(target);
				expect(status.profiles.map((p) => p.provider)).toEqual(PROVIDERS);
			}
		);
	});
});

describe("import response codecs accept every item kind", () => {
	test("scanAgentSyncRoot keeps a scan item of every kind", async () => {
		await withNode(
			{ "/api/agent-sync/scan": scanBody("chatgpt", KINDS) },
			async (target) => {
				const scan = await scanAgentSyncRoot(target, "/fixtures", "chatgpt");
				expect(scan.items.map((item) => item.kind)).toEqual(KINDS);
			}
		);
	});

	test("importAgentSyncItems keeps an outcome of every kind", async () => {
		await withNode(
			{
				"/api/agent-sync/import": {
					conflicts: 0,
					dryRun: false,
					failed: 0,
					imported: KINDS.length,
					operationId: "op-1",
					profileId: "profile-1",
					results: outcomes(KINDS),
					skipped: 0,
				},
			},
			async (target) => {
				const result = await importAgentSyncItems(target, {
					items: KINDS.map((kind) => ({ id: `${kind}/item`, kind })),
					profileId: "profile-1",
				});
				expect(result.results.map((outcome) => outcome.kind)).toEqual(KINDS);
			}
		);
	});

	test("runImport keeps an outcome of every kind", async () => {
		await withNode(
			{
				"/api/import/run": {
					root: "/fixtures",
					results: outcomes(KINDS),
				},
			},
			async (target) => {
				const result = await runImport(
					target,
					"/fixtures",
					KINDS.map((kind) => ({ id: `${kind}/item`, kind }))
				);
				expect(result.results.map((outcome) => outcome.kind)).toEqual(KINDS);
				expect(result.results.map((outcome) => outcome.status)).toEqual(
					KINDS.map(() => "imported")
				);
			}
		);
	});
});

describe("the codecs still fail closed on values Core does not emit", () => {
	test("an unknown provider is rejected by scan, list, save and status", async () => {
		await withNode(
			{
				"/api/agent-sync/scan": scanBody(UNKNOWN_PROVIDER, ["skill"]),
				"/api/agent-sync/profiles": {
					profiles: [profile(UNKNOWN_PROVIDER, 0)],
				},
				"/api/agent-sync/status": {
					activeOperations: 0,
					bindings: [],
					items: [],
					nodeId: "local",
					profiles: [profile(UNKNOWN_PROVIDER, 0)],
				},
			},
			async (target) => {
				const unknown = UNKNOWN_PROVIDER as SyncProvider;
				await expect(scanAgentSyncRoot(target, "/fixtures")).rejects.toThrow(
					z.ZodError
				);
				await expect(listAgentSyncProfiles(target)).rejects.toThrow(z.ZodError);
				await expect(
					saveAgentSyncProfile(target, {
						exportEnabled: true,
						importEnabled: true,
						provider: unknown,
						root: "/fixtures",
					})
				).rejects.toThrow(z.ZodError);
				await expect(getAgentSyncStatus(target)).rejects.toThrow(z.ZodError);
			}
		);
	});

	test("an unknown item kind is rejected by scan, sync import and run", async () => {
		await withNode(
			{
				"/api/agent-sync/scan": scanBody("claude", [UNKNOWN_KIND]),
				"/api/agent-sync/import": {
					results: outcomes([UNKNOWN_KIND]),
				},
				"/api/import/run": {
					root: "/fixtures",
					results: outcomes([UNKNOWN_KIND]),
				},
			},
			async (target) => {
				const unknown = UNKNOWN_KIND as ImportItemKind;
				const selection = [{ id: "x", kind: unknown }];
				await expect(scanAgentSyncRoot(target, "/fixtures")).rejects.toThrow(
					z.ZodError
				);
				await expect(
					importAgentSyncItems(target, { items: selection, profileId: "p" })
				).rejects.toThrow(z.ZodError);
				await expect(runImport(target, "/fixtures", selection)).rejects.toThrow(
					z.ZodError
				);
			}
		);
	});
});
