// Store home fixture routes, part 2 of 3: tried in order by
// installLocalFixture until one answers the request.

import { IDS, json, modelCard } from "./marketplace-store-home.fixture.ts";
import {
	mcpFixtureCards,
	skillFixtureCards,
} from "./marketplace-store-home.fixture-cards.ts";
import {
	NEXT_ROUTE,
	type StoreRouteContext,
} from "./marketplace-store-home.routes-context.ts";
import {
	gatewayMarketplaceUpdateObservation,
	storeLikeRequestSchema,
	storeLikesBatchSchema,
	storeModelInstallSchema,
	storeReviewRequestSchema,
	storeSkillActivationSchema,
	storeSkillDistributionSchema,
	storeSkillInstallSchema,
} from "./marketplace-store-home-proof.contracts.ts";

export async function routeStoreHome2(
	ctx: StoreRouteContext
): Promise<unknown> {
	const { route, url, method, body, fixture } = ctx;
	if (url.pathname === "/api/gateway/config" && method === "PUT") {
		const policy = gatewayMarketplaceUpdateObservation(body);
		if (policy.cadence) {
			fixture.recommendations.cadence = policy.cadence;
		}
		return json(route, 200, { ok: true });
	}
	if (url.pathname === "/api/marketplace/likes/batch" && method === "POST") {
		const namespaces = storeLikesBatchSchema.parse(body).namespaces ?? [];
		return json(route, 200, {
			items: namespaces.map((namespace) => {
				let like = fixture.likes[namespace];
				if (!like) {
					like = { count: 2, liked: false };
					fixture.likes[namespace] = like;
				}
				return { ...like, namespace };
			}),
		});
	}
	if (url.pathname === "/api/marketplace/likes") {
		const namespace = storeLikeRequestSchema.parse(body).namespace;
		let like = fixture.likes[namespace];
		if (!like) {
			like = { count: 2, liked: false };
			fixture.likes[namespace] = like;
		}
		if (method === "POST") {
			like.count += 1;
			like.liked = true;
		} else if (method === "DELETE") {
			like.count = Math.max(0, like.count - 1);
			like.liked = false;
		}
		return json(route, 200, { ...like, namespace });
	}
	if (url.pathname === "/api/marketplace/reviews") {
		if (method === "GET") {
			if (fixture.reviewListFailures > 0) {
				fixture.reviewListFailures -= 1;
				return json(route, 503, {
					error: "Fixture review list unavailable",
				});
			}
			const cursor = url.searchParams.get("cursor");
			const pageReviews = cursor
				? fixture.reviewExtraRows.slice(20)
				: [
						...(fixture.review ? [fixture.review] : []),
						...fixture.reviewExtraRows.slice(0, 20),
					];
			return json(route, 200, {
				nextCursor:
					!cursor && fixture.reviewExtraRows.length > 20
						? "fixture-review-next"
						: null,
				ratingAverage: pageReviews[0]?.rating ?? fixture.review?.rating ?? 0,
				ratingCount: fixture.reviewExtraRows.length + (fixture.review ? 1 : 0),
				reviews: pageReviews,
			});
		}
		if (method === "POST") {
			if (fixture.reviewWriteFailures > 0) {
				fixture.reviewWriteFailures -= 1;
				return json(route, 503, {
					error: "Fixture review write unavailable",
				});
			}
			const input = storeReviewRequestSchema.parse(body);
			fixture.review = {
				body: input.body ?? null,
				createdAt: "2026-08-20T00:00:00Z",
				id: "fixture-review",
				mine: true,
				rating: input.rating,
				title: input.title ?? null,
				userName: "Fixture Reviewer",
				verifiedPurchase: false,
			};
			return json(route, 200, {
				ratingAverage: input.rating,
				ratingCount: 1,
			});
		}
		if (method === "DELETE") {
			if (fixture.reviewDeleteFailures > 0) {
				fixture.reviewDeleteFailures -= 1;
				return json(route, 503, {
					error: "Fixture review delete unavailable",
				});
			}
			fixture.review = null;
			return json(route, 200, { success: true });
		}
	}

	if (url.pathname === "/api/models/catalog") {
		const query = url.searchParams.get("query")?.toLowerCase() ?? "";
		const all = [
			modelCard(
				IDS.model,
				"Home GGUF Candidate",
				fixture.modelInstalled.has(IDS.model)
			),
			modelCard(
				"fixture/home-safetensors",
				"Home Safetensors Snapshot",
				fixture.modelInstalled.has("fixture/home-safetensors"),
				"safetensors"
			),
			modelCard(
				"fixture/home-mlx",
				"Home MLX Snapshot",
				fixture.modelInstalled.has("fixture/home-mlx"),
				"mlx"
			),
			modelCard(
				IDS.recommendation,
				"For You Gemma",
				fixture.modelInstalled.has(IDS.recommendation)
			),
		];
		const models = query
			? query.includes("heading needle")
				? [modelCard("fixture/heading-match", "Heading Needle Model")]
				: []
			: all;
		return json(route, 200, {
			models,
			next_cursor: null,
			total: models.length,
		});
	}
	if (url.pathname === "/api/models/catalog/detail" && method === "GET") {
		const id = url.searchParams.get("id") ?? IDS.model;
		const name =
			id === IDS.recommendation ? "For You Gemma" : "Home GGUF Candidate";
		return json(route, 200, {
			card: modelCard(id, name, fixture.modelInstalled.has(id)),
			device: {
				gpu_name: "Fixture GPU",
				os: "linux",
				ram_human: "16 GB",
				total_ram_bytes: 16_000_000_000,
				unified_memory: false,
				vram_bytes: 8_000_000_000,
				vram_human: "8 GB",
			},
			files: [
				{
					filename: "home-gemma-Q4_K_M.gguf",
					fit: "great",
					fit_label: "Fits your device",
					quant: "Q4_K_M",
					size_bytes: 2_400_000_000,
					size_human: "2.4 GB",
					url: "https://fixture.invalid/home-gemma-q4.gguf",
				},
				{
					filename: "home-gemma-Q8_0.gguf",
					fit: "partial",
					fit_label: "Fits with reduced context",
					quant: "Q8_0",
					size_bytes: 4_800_000_000,
					size_human: "4.8 GB",
					url: "https://fixture.invalid/home-gemma-q8.gguf",
				},
			],
			format: "gguf",
			readme:
				id === IDS.recommendation
					? "Recommendation selected fixture detail."
					: null,
			repo_fit: "",
			repo_fit_label: "",
		});
	}
	if (url.pathname === "/api/models/catalog/install" && method === "POST") {
		const install = storeModelInstallSchema.parse(body);
		const gate = fixture.installGate;
		if (gate) {
			fixture.installGate = null;
			await gate.promise;
		}
		if (fixture.installFailures[url.pathname] > 0) {
			fixture.installFailures[url.pathname] -= 1;
			return json(route, 503, { error: "Local install fixture failure" });
		}
		if (install.format === "gguf" && !install.file) {
			return json(route, 422, { error: "A GGUF filename is required" });
		}
		fixture.modelInstalled.add(install.id);
		return json(route, 200, {
			result: {
				filename: install.file ?? `${install.id}.snapshot`,
				path: `/fixture/models/${install.id}`,
				repo_id: install.id,
			},
			success: true,
		});
	}

	if (url.pathname === "/api/skills" && method === "GET") {
		const cards = skillFixtureCards(fixture);
		return json(route, 200, {
			skills: cards
				.filter((card) => fixture.skillInstalled.has(card.id))
				.map((card) => ({
					allowed_tools: [],
					description: card.description,
					enabled: fixture.skillActiveById[card.id] ?? false,
					id: card.id,
					name: card.name,
				})),
		});
	}
	if (url.pathname === "/api/skills/targets" && method === "GET") {
		return json(route, 200, {
			droppedTargetIds: [],
			preferences: fixture.skillTargetPreferences,
			targets: [
				{
					detected: true,
					featured: true,
					globalSkillsDir: "/fixture/agents/code/skills",
					id: "fixture-code-agent",
					name: "Fixture Code Agent",
					projectSkillsDir: "/fixture/project/.agents/skills",
					resolvedGlobalPath: "/fixture/agents/code/skills",
					selectable: true,
					unavailableReason: null,
				},
				{
					detected: false,
					featured: false,
					globalSkillsDir: null,
					id: "fixture-unavailable-agent",
					name: "Unavailable Fixture Agent",
					projectSkillsDir: "/fixture/project/.agents/skills",
					resolvedGlobalPath: null,
					selectable: false,
					unavailableReason: "The agent is not installed.",
				},
			],
			warning: null,
		});
	}
	if (url.pathname.endsWith("/distribute") && method === "POST") {
		const distribution = storeSkillDistributionSchema.parse(body);
		const skillId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
		if (distribution.rememberTargetIds) {
			fixture.skillTargetPreferences = {
				configured: true,
				targetIds: distribution.targetIds,
				version: 1,
			};
		}
		return json(route, 200, {
			distribution: {
				skillId,
				targets: distribution.targetIds.map((targetId) => ({
					message: null,
					path: `/fixture/agents/${targetId}/skills/${skillId}`,
					status: "copied",
					targetId,
				})),
			},
			success: true,
		});
	}
	if (url.pathname === "/api/skills/activate" && method === "POST") {
		const activation = storeSkillActivationSchema.parse(body);
		fixture.skillActiveById[activation.id] = activation.active;
		return json(route, 200, { success: true });
	}
	if (url.pathname === "/api/skills/catalog" && method === "GET") {
		const searchQuery = url.searchParams.get("query")?.toLowerCase() ?? "";
		const source = url.searchParams.get("source") ?? "all";
		const installedOnly = url.searchParams.get("installed_only") === "true";
		const limit = url.searchParams.get("limit");
		if (limit === "120" && fixture.skillCatalogFailures > 0) {
			fixture.skillCatalogFailures -= 1;
			return json(route, 503, {
				error: "Fixture skills catalog is unavailable",
			});
		}
		let skills = skillFixtureCards(fixture);
		if (limit === "12" && !searchQuery) {
			skills = skills.filter((card) => card.id === IDS.skill);
		}
		if (source !== "all") {
			skills = skills.filter((card) => card.catalog_source_id === source);
		}
		if (searchQuery) {
			skills = skills.filter((card) =>
				[card.id, card.name, card.description, card.source].some((field) =>
					field.toLowerCase().includes(searchQuery)
				)
			);
		}
		if (installedOnly) {
			skills = skills.filter((card) => fixture.skillInstalled.has(card.id));
		}
		return json(route, 200, {
			next_cursor: null,
			skills,
			total: skills.length,
		});
	}
	if (url.pathname === "/api/skills/catalog/detail" && method === "GET") {
		const id = url.searchParams.get("id") ?? IDS.skill;
		const card = skillFixtureCards(fixture).find((skill) => skill.id === id);
		return json(route, 200, {
			card: card ?? skillFixtureCards(fixture)[0],
			description: card?.description ?? "Selected skill fixture detail.",
			files: [
				{ contents: "Local fixture instructions.", path: "SKILL.md" },
				{
					contents: "Reference content for selection proof.",
					path: "references/DETAIL.md",
				},
			],
			metadata: {
				installs: "22",
				repository_url: "https://fixture.invalid/skills",
			},
			readme: "Selected skill detail from the local fixture.",
			url: "https://fixture.invalid/home-skill",
		});
	}
	if (url.pathname === "/api/skills/catalog/install" && method === "POST") {
		const install = storeSkillInstallSchema.parse(body);
		if (fixture.skillInstallFailures > 0) {
			fixture.skillInstallFailures -= 1;
			return json(route, 503, { error: "Fixture skill install failed" });
		}
		fixture.skillInstalled.add(install.id);
		fixture.skillActiveById[install.id] = false;
		return json(route, 200, {
			result: {
				path: `/fixture/skills/${install.id}`,
				slug: "home-skill-fixture",
			},
			success: true,
		});
	}
	if (url.pathname === "/api/skills/packs" && method === "GET") {
		return json(route, 200, { packs: fixture.skillPacks });
	}
	if (url.pathname === "/api/skills/packs/detail" && method === "GET") {
		const id = url.searchParams.get("id") ?? "fixture/productivity-pack";
		const members =
			id === "fixture/research-pack"
				? [
						{
							description: "An installed active skill.",
							id: IDS.skillInstalled,
							installed: fixture.skillInstalled.has(IDS.skillInstalled),
							name: "Installed Skill",
						},
					]
				: [
						{
							description: "An alpha skill used for search and sort proof.",
							id: IDS.skillAlpha,
							installed: fixture.skillInstalled.has(IDS.skillAlpha),
							name: "alpha assistant",
						},
						{
							description: "A custom-source skill.",
							id: IDS.skillCustom,
							installed: fixture.skillInstalled.has(IDS.skillCustom),
							name: "custom helper",
						},
					];
		return json(route, 200, {
			builtin: true,
			description:
				id === "fixture/research-pack"
					? "A second local fixture pack for focus tasks."
					: "A local fixture pack for productivity tasks.",
			id,
			members,
			name:
				id === "fixture/research-pack"
					? "Fixture Research Pack"
					: "Fixture Productivity Pack",
		});
	}
	if (url.pathname === "/api/skills/packs/install" && method === "POST") {
		if (fixture.skillPackInstallFailures > 0) {
			fixture.skillPackInstallFailures -= 1;
			return json(route, 503, { error: "Fixture pack install failed" });
		}
		fixture.skillInstalled.add(IDS.skillAlpha);
		fixture.skillInstalled.add(IDS.skillCustom);
		fixture.skillActiveById[IDS.skillAlpha] = false;
		fixture.skillActiveById[IDS.skillCustom] = false;
		return json(route, 200, {
			installed: ["alpha-assistant", "custom-helper"],
			success: true,
		});
	}

	if (url.pathname === "/api/mcp/servers" && method === "GET") {
		return json(route, 200, {
			servers: [...fixture.mcpInstalled].map((id) => ({
				args: ["fixture"],
				command: "node",
				description: "An installed local MCP fixture.",
				enabled: false,
				name: id,
				transport: "stdio",
				url: null,
			})),
		});
	}
	if (url.pathname === "/api/mcp/catalog" && method === "GET") {
		const searchQuery = url.searchParams.get("query")?.toLowerCase() ?? "";
		const limit = url.searchParams.get("limit");
		if (limit === "40" && fixture.mcpCatalogFailures > 0) {
			fixture.mcpCatalogFailures -= 1;
			return json(route, 503, {
				error: "Fixture MCP catalog is unavailable",
			});
		}
		let servers: ReturnType<typeof mcpFixtureCards>[number][] = mcpFixtureCards(
			fixture,
			fixture.mcpActiveSource
		);
		if (limit === "12") {
			servers = servers.filter((server) => server.id === IDS.mcp);
		}
		if (searchQuery) {
			servers = servers.filter((server) =>
				[server.id, server.name, server.description].some((field) =>
					field.toLowerCase().includes(searchQuery)
				)
			);
		}
		return json(route, 200, {
			next_cursor: null,
			servers,
			total: servers.length,
		});
	}
	return NEXT_ROUTE;
}
