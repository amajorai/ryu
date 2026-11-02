// Store home fixture routes, part 3 of 3: tried in order by
// installLocalFixture until one answers the request.

import {
	appCatalogEntry,
	appLifecycle,
	IDS,
	json,
} from "./marketplace-store-home.fixture.ts";
import { mcpFixtureCards } from "./marketplace-store-home.fixture-cards.ts";
import type { StoreRouteContext } from "./marketplace-store-home.routes-context.ts";
import {
	storeIdRequestSchema,
	storePluginInstallSchema,
	storePluginUpdateSchema,
	storeUrlInstallSchema,
} from "./marketplace-store-home-proof.contracts.ts";

export async function routeStoreHome3(
	ctx: StoreRouteContext
): Promise<unknown> {
	const { route, url, method, body, fixture, diagnostic, strictEngines } = ctx;
	if (url.pathname === "/api/mcp/catalog/detail" && method === "GET") {
		const id = url.searchParams.get("id") ?? IDS.mcp;
		const card = mcpFixtureCards(fixture, fixture.mcpActiveSource).find(
			(server) => server.id === id
		);
		return json(route, 200, {
			card: {
				description: card?.description ?? "Selected MCP fixture detail.",
				has_packages: true,
				has_remotes: true,
				id,
				name: card?.name ?? id,
				transports: card?.transports ?? ["stdio"],
				version: card?.version ?? "1.0.0",
			},
			packages: [
				{
					identifier: "fixture-package",
					registry_type: "npm",
					transport: "stdio",
					version: "1.0.0",
				},
			],
			remotes: [
				{
					transport_type: "streamable-http",
					url: "https://fixture.invalid/mcp",
				},
			],
		});
	}
	if (url.pathname === "/api/mcp/catalog/install" && method === "POST") {
		const install = storeIdRequestSchema.parse(body);
		if (fixture.mcpInstallFailures > 0) {
			fixture.mcpInstallFailures -= 1;
			return json(route, 503, { error: "Fixture MCP install failed" });
		}
		const gate = fixture.mcpInstallGate;
		if (gate) {
			fixture.mcpInstallGate = null;
			await gate.promise;
		}
		fixture.mcpInstalled.add(install.id);
		return json(route, 200, {
			server: {
				args: ["fixture"],
				command: "node",
				name: install.id,
				transport: "stdio",
				url: null,
			},
			success: true,
		});
	}

	if (url.pathname === "/api/agents/catalog" && method === "GET") {
		return json(route, 200, {
			agents: [IDS.agent, IDS.contextAgent, IDS.recommendationAgent].map(
				(id) => ({
					added: fixture.agentsAdded.has(id),
					available: true,
					description: "A local agent fixture.",
					engine: "fixture-engine",
					id,
					name:
						id === IDS.agent
							? "Home Agent Fixture"
							: id === IDS.contextAgent
								? "Context Agent Fixture"
								: "For You Agent",
				})
			),
		});
	}
	if (url.pathname === "/api/agents/catalog/install" && method === "POST") {
		fixture.agentsAdded.add(storeIdRequestSchema.parse(body).id);
		return json(route, 200, { success: true });
	}

	if (url.pathname === "/api/plugins/catalog" && method === "GET") {
		return json(route, 200, {
			entries: [
				appCatalogEntry(IDS.app, "Fixture Home App", "app", "built-in"),
				appCatalogEntry(
					IDS.plugin,
					"Fixture Home Plugin",
					"plugin",
					"marketplace"
				),
			],
		});
	}
	if (url.pathname === "/api/plugins/catalog/browse" && method === "GET") {
		const source = url.searchParams.get("source") ?? "all";
		const query = url.searchParams.get("query")?.toLowerCase() ?? "";
		const origin = url.searchParams.get("origin");
		if (origin === "community") {
			const communityEntry = appCatalogEntry(
				IDS.communityPlugin,
				"Community Fixture Plugin",
				"plugin",
				"community",
				{
					origin: "community",
					repo_url: "https://github.com/fixture/community-plugin",
					reviewed: false,
				}
			);
			const communityMatches =
				!query ||
				`${communityEntry.name} ${communityEntry.description} ${communityEntry.tags.join(" ")}`
					.toLowerCase()
					.includes(query);
			return json(route, 200, {
				entries: communityMatches ? [communityEntry] : [],
				next_cursor: null,
				total: communityMatches ? 1 : 0,
			});
		}
		if (fixture.appCatalogFailures > 0) {
			fixture.appCatalogFailures -= 1;
			return json(route, 503, { error: "Fixture app catalog unavailable" });
		}
		if (query === "paging-fixture") {
			const cursor = url.searchParams.get("cursor");
			const entries = cursor
				? [
						appCatalogEntry(
							"fixture/pagination-plugin-25",
							"Pagination Plugin 25",
							"plugin",
							"marketplace",
							{ category: "Pagination", tags: ["paging-fixture"] }
						),
					]
				: Array.from({ length: 24 }, (_, index) => {
						const itemIndex = index + 1;
						return appCatalogEntry(
							`fixture/pagination-plugin-${itemIndex}`,
							`Pagination Plugin ${itemIndex}`,
							"plugin",
							"marketplace",
							{ category: "Pagination", tags: ["paging-fixture"] }
						);
					});
			return json(route, 200, {
				entries,
				next_cursor: cursor ? null : "fixture-next-page",
				total: cursor ? 25 : 24,
			});
		}
		const entries = [
			appCatalogEntry(IDS.app, "Fixture Home App", "app", "built-in", {
				category: "Productivity",
				description: "A native fixture app for the Apps tab.",
				permission_grants: ["net.fetch"],
				tags: ["fixture", "workflow"],
			}),
			...Array.from({ length: 8 }, (_, index) => {
				const itemIndex = index + 1;
				return appCatalogEntry(
					`fixture/extra-app-${itemIndex}`,
					`Fixture Extra App ${itemIndex}`,
					"app",
					"built-in",
					{
						category: "Productivity",
						description: `Productivity fixture ${itemIndex}.`,
						tags: ["fixture", "workflow"],
					}
				);
			}),
			appCatalogEntry(
				IDS.utilitiesApp,
				"Fixture Utilities App",
				"app",
				"built-in",
				{
					category: "Utilities",
					description: "A second category for shelf navigation.",
					tags: ["fixture", "utilities"],
				}
			),
			appCatalogEntry(
				IDS.plugin,
				"Fixture Home Plugin",
				"plugin",
				"marketplace",
				{
					category: "Developer tools",
					description: "A signed fixture plugin for the Plugins tab.",
					permission_grants: ["tools:read"],
					requires: {
						apps: [{ id: "fixture/required-plugin", min_version: "1.2.0" }],
						grants: ["tools:read"],
					},
					repo_url: "https://github.com/fixture/ryu-plugin",
					tags: ["fixture", "developer"],
				}
			),
			appCatalogEntry(
				IDS.urlPlugin,
				"URL Installed Plugin",
				"plugin",
				"marketplace",
				{
					category: "Developer tools",
					description: "A fixture installed through a manifest URL.",
					tags: ["fixture", "url"],
				}
			),
			appCatalogEntry(
				IDS.betaPlugin,
				"Beta Plugin Fixture",
				"plugin",
				"marketplace",
				{
					category: "Developer tools",
					description: "An unstable local fixture release.",
					stability: "beta",
					tags: ["developer", "preview"],
				}
			),
		];
		const sourceEntries = entries.filter(
			(entry) =>
				source === "all" ||
				(source === "ryu-catalog" && entry.source === "built-in") ||
				(source !== "ryu-catalog" && entry.source !== "built-in")
		);
		const filtered = query
			? sourceEntries.filter((entry) =>
					`${entry.name} ${entry.description} ${entry.tags.join(" ")}`
						.toLowerCase()
						.includes(query)
				)
			: sourceEntries;
		return json(route, 200, {
			entries: filtered,
			next_cursor: null,
			total: filtered.length,
		});
	}
	if (url.pathname === "/api/plugins/catalog/detail" && method === "GET") {
		const id = url.searchParams.get("id") ?? IDS.plugin;
		return json(route, 200, {
			description:
				id === IDS.app
					? "A native fixture app for the Apps tab."
					: id === IDS.urlPlugin
						? "A fixture installed through a manifest URL."
						: "A signed fixture plugin for the Plugins tab.",
			id,
			kind: id === IDS.app ? "app" : "plugin",
			name:
				id === IDS.app
					? "Fixture Home App"
					: id === IDS.urlPlugin
						? "URL Installed Plugin"
						: "Fixture Home Plugin",
			apiSurface: {
				commands: [
					{
						description: "Open the local fixture command.",
						id: "fixture:open",
						name: "Open fixture",
					},
				],
			},
			readme:
				"# Fixture plugin\n\nLocal README content for the Store detail proof.",
			readmeUrl: "https://github.com/fixture/ryu-plugin#readme",
			repositoryUrl: "https://github.com/fixture/ryu-plugin",
			source: "fixture",
			versions: [
				{
					installable: true,
					publishedAt: "2026-08-20T00:00:00Z",
					stability: "stable",
					url: "https://github.com/fixture/ryu-plugin/releases/tag/v1.0.0",
					version: "1.0.0",
				},
				{
					installable: true,
					publishedAt: "2026-07-20T00:00:00Z",
					stability: "stable",
					url: "https://github.com/fixture/ryu-plugin/releases/tag/v0.9.0",
					version: "0.9.0",
				},
			],
			version: "1.0.0",
		});
	}
	if (
		url.pathname === "/api/plugins/catalog/version-detail" &&
		method === "GET"
	) {
		return json(route, 200, {
			atRef: url.searchParams.get("tag"),
			description: "The historical fixture release.",
			license: "MIT",
			readme: "Historical README body.",
			stability: "stable",
			version: url.searchParams.get("tag") === "0.9.0" ? "0.9.0" : "1.0.0",
		});
	}
	if (url.pathname === "/api/plugins/catalog/channels" && method === "GET") {
		return json(route, 200, {
			channels: [
				{ channel: "stable", installable: true, version: "1.0.0" },
				{ channel: "beta", installable: true, version: "1.1.0-beta.1" },
			],
		});
	}
	if (url.pathname === "/api/plugins" && method === "GET") {
		return json(route, 200, {
			apps: [...fixture.appsInstalled].map((id) => appLifecycle(fixture, id)),
		});
	}
	if (
		url.pathname === `/api/plugins/${encodeURIComponent(IDS.app)}/install` &&
		method === "POST"
	) {
		if (fixture.appInstallFailures > 0) {
			fixture.appInstallFailures -= 1;
			return json(route, 503, { error: "Fixture app install failed" });
		}
		fixture.appsInstalled.add(IDS.app);
		return json(route, 200, {
			app: {
				approved_grants: [],
				created_at: "2026-08-01T00:00:00Z",
				enabled: false,
				id: IDS.app,
				updated_at: "2026-08-01T00:00:00Z",
				version: "1.0.0",
			},
		});
	}
	const appLifecycleMatch = url.pathname.match(
		/^\/api\/plugins\/([^/]+)\/(enable|disable|uninstall)$/
	);
	if (appLifecycleMatch && method === "POST") {
		const id = decodeURIComponent(appLifecycleMatch[1] ?? "");
		const action = appLifecycleMatch[2];
		if (action === "enable") {
			fixture.appEnabled.add(id);
			return json(route, 200, {
				app: {
					approved_grants: ["net.fetch"],
					created_at: "2026-08-01T00:00:00Z",
					enabled: true,
					id,
					updated_at: "2026-08-02T00:00:00Z",
					version: "1.0.0",
				},
			});
		}
		if (action === "disable") {
			fixture.appEnabled.delete(id);
			return json(route, 200, {
				app: {
					approved_grants: [],
					created_at: "2026-08-01T00:00:00Z",
					enabled: false,
					id,
					updated_at: "2026-08-02T00:00:00Z",
					version: "1.0.0",
				},
			});
		}
		fixture.appsInstalled.delete(id);
		fixture.appEnabled.delete(id);
		return json(route, 200, { removed: id, success: true });
	}
	const appUpdateMatch = url.pathname.match(
		/^\/api\/plugins\/([^/]+)\/update$/
	);
	if (appUpdateMatch && method === "POST") {
		const id = decodeURIComponent(appUpdateMatch[1] ?? "");
		const update = storePluginUpdateSchema.parse(body ?? {});
		fixture.appChannels[id] = update.channel ?? null;
		return json(route, 200, {
			app: {
				approved_grants: [],
				created_at: "2026-08-01T00:00:00Z",
				enabled: fixture.appEnabled.has(id),
				id,
				updated_at: "2026-08-02T00:00:00Z",
				version: "1.0.0",
			},
		});
	}
	if (url.pathname === "/api/plugins/catalog/install" && method === "POST") {
		if (fixture.pluginInstallFailures > 0) {
			fixture.pluginInstallFailures -= 1;
			return json(route, 503, { error: "Fixture plugin install failed" });
		}
		const install = storePluginInstallSchema.parse(body);
		fixture.appsInstalled.add(install.id);
		fixture.appChannels[install.id] = install.channel ?? null;
		return json(route, 200, { success: true });
	}
	if (url.pathname === "/api/plugins/install" && method === "POST") {
		if (fixture.appUrlInstallFailures > 0) {
			fixture.appUrlInstallFailures -= 1;
			return json(route, 503, { error: "Fixture URL install failed" });
		}
		const install = storeUrlInstallSchema.parse(body);
		fixture.appsInstalled.add(
			install.url.includes("community-plugin")
				? IDS.communityPlugin
				: IDS.urlPlugin
		);
		return json(route, 200, { success: true });
	}
	if (url.pathname === "/api/catalog/scan" && method === "POST") {
		if (fixture.auditFailures > 0) {
			fixture.auditFailures -= 1;
			return json(route, 503, { error: "Fixture audit unavailable" });
		}
		const gate = fixture.auditGate;
		if (gate) {
			fixture.auditGate = null;
			await gate.promise;
		}
		return json(route, 200, {
			agent_id: "fixture-reviewer",
			assessment: {
				confidence: "high",
				evidence: ["The fixture README is present."],
				limitations: ["Local fixture evidence only."],
				recommendations: [
					{
						priority: "low",
						action: "Review the repository.",
						reason: "Confirm the listing before installing.",
					},
				],
				score: 88,
				summary: "Local fixture audit result.",
			},
			conversationId: "fixture-audit-conversation",
			model: "fixture-reviewer-model",
			report: "Local fixture report.",
			status: "complete",
		});
	}

	// Each chat and speech engine's native launch-option catalog (Core's
	// GET /api/engines/{engine}/launch-options). The fixture node advertises no
	// engine-native options, so the editors render their typed fields only.
	const launchOptions = url.pathname.match(
		/^\/api\/engines\/([^/]+)\/launch-options$/
	);
	if (launchOptions && method === "GET") {
		return json(route, 200, {
			engine: decodeURIComponent(launchOptions[1] ?? ""),
			options: [],
		});
	}

	if (strictEngines) {
		diagnostic.unknown.push({
			method,
			path: url.pathname,
			search: url.search,
			body,
		});
		return json(route, 501, {
			error: `Unmapped Engines fixture contract: ${method} ${url.pathname}${url.search}`,
		});
	}
	return json(route, 200, {});
}
