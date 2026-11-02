// Store home fixture routes, part 1 of 3: tried in order by
// installLocalFixture until one answers the request.

import { expect } from "@playwright/test";
import {
	EMPTY_ENGINE_CONTRIBUTIONS,
	IDS,
	json,
} from "./marketplace-store-home.fixture.ts";
import { engineCatalogItems } from "./marketplace-store-home.fixture-cards.ts";
import {
	NEXT_ROUTE,
	type StoreRouteContext,
} from "./marketplace-store-home.routes-context.ts";
import {
	storeNameRequestSchema,
	storePreferenceRequestSchema,
	storeRecommendationPreferenceSchema,
	storeSourceMutationSchema,
	storeSourceReorderSchema,
	storeSourceSelectionSchema,
	storeVariantRequestSchema,
} from "./marketplace-store-home-proof.contracts.ts";

export async function routeStoreHome1(
	ctx: StoreRouteContext
): Promise<unknown> {
	const {
		route,
		request,
		url,
		method,
		body,
		fixture,
		diagnostic,
		strictEngines,
		apiOrigin,
	} = ctx;
	if (strictEngines) {
		if (url.origin !== apiOrigin) {
			diagnostic.unknown.push({
				method,
				path: `${url.origin}${url.pathname}`,
				search: url.search,
				body,
			});
			return json(route, 501, {
				error: "Engines fixture called an unexpected API origin",
			});
		}
		expect(
			request.headers().authorization,
			`${method} ${url.pathname} node authorization`
		).toBe("Bearer fixture-node-token");
		if (method === "GET") {
			expect(body).toBeNull();
		}
		const lifecycle = url.pathname.match(
			/^\/api\/(?:setup|sidecar)\/([^/]+)\/(install|uninstall|start|stop)$/
		);
		if (lifecycle) {
			expect(method).toBe("POST");
			expect(engineCatalogItems(fixture).map((item) => item.name)).toContain(
				decodeURIComponent(lifecycle[1] ?? "")
			);
			expect(body).toBeNull();
			expect(["", "?force=true"]).toContain(url.search);
			if (url.search) {
				expect(lifecycle[2]).toBe("install");
			}
		}
		if (method === "POST" && url.pathname === "/api/engine/active") {
			expect(body).toEqual({ name: expect.any(String) });
			expect(engineCatalogItems(fixture).map((item) => item.name)).toContain(
				storeNameRequestSchema.parse(body).name
			);
		}
		if (method === "POST" && url.pathname === "/api/sandbox/backend") {
			expect(body).toEqual({
				name: expect.stringMatching(/^(wasmtime|docker|opensandbox)$/),
			});
		}
		if (
			method === "POST" &&
			url.pathname === "/api/engine/llamacpp/acceleration"
		) {
			expect(body).toEqual({ variant: expect.any(String) });
			expect([
				"auto",
				...fixture.acceleration.options.map((option) => option.id),
			]).toContain(storeVariantRequestSchema.parse(body).variant);
		}
	}
	if (
		strictEngines &&
		method === "GET" &&
		url.pathname === "/api/plugins/contributions"
	) {
		expect(url.search).toBe("");
		return json(route, 200, EMPTY_ENGINE_CONTRIBUTIONS);
	}
	if (
		strictEngines &&
		method === "GET" &&
		url.pathname === "/api/gateway/org-features"
	) {
		expect(url.search).toBe("");
		// An organization-free node: Core reports no feature policy, so the
		// Engines catalog and update controls stay available.
		return json(route, 200, {
			available: true,
			features: {},
			managed: false,
		});
	}
	const preferencePath = url.pathname.match(/^\/api\/preferences\/([^/]+)$/);
	if (preferencePath) {
		const key = decodeURIComponent(preferencePath[1] ?? "");
		if (method === "GET") {
			return json(route, 200, {
				key,
				value: fixture.preferences[key] ?? null,
			});
		}
		if (method === "PUT") {
			if (strictEngines) {
				expect(body).toEqual({ value: expect.any(String) });
			}
			fixture.preferences[key] = storePreferenceRequestSchema.parse(body).value;
			return json(route, 200, { key, value: fixture.preferences[key] });
		}
	}

	if (url.pathname === "/api/catalog/sources/select" && method === "POST") {
		const selection = storeSourceSelectionSchema.parse(body);
		if (selection.kind === "mcp") {
			fixture.mcpActiveSource = selection.id;
		}
		return json(route, 200, { ok: true });
	}
	if (url.pathname === "/api/catalog/sources") {
		const kind = url.searchParams.get("kind");
		if (method === "GET") {
			const sources =
				kind === "mcp"
					? fixture.mcpSources
					: kind === "plugin"
						? fixture.pluginSources
						: fixture.skillSources;
			const active =
				kind === "mcp" ? fixture.mcpActiveSource : fixture.skillActiveSource;
			return json(route, 200, { active, sources });
		}
		const mutation = storeSourceMutationSchema.parse(body);
		const sourceKind = mutation.kind ?? kind;
		if (method === "POST" && sourceKind !== "mcp") {
			const pluginSource = sourceKind === "plugin";
			const failures = pluginSource
				? fixture.pluginSourceAddFailures
				: fixture.skillSourceAddFailures;
			if (failures > 0) {
				if (pluginSource) {
					fixture.pluginSourceAddFailures -= 1;
				} else {
					fixture.skillSourceAddFailures -= 1;
				}
				return json(route, pluginSource ? 200 : 503, {
					ok: false,
					error: "Fixture source add failed",
				});
			}
			const source = {
				base_url: mutation.base_url ?? null,
				builtin: false,
				display_name: mutation.display_name ?? mutation.id,
				id: mutation.id,
			};
			if (pluginSource) {
				fixture.pluginSources.push(source);
			} else {
				fixture.skillSources.push(source);
			}
			return json(route, 200, { ok: true });
		}
		if (method === "DELETE" && mutation.kind === "skill") {
			fixture.skillSources = fixture.skillSources.filter(
				(source) => source.id !== mutation.id
			);
			return json(route, 200, { ok: true });
		}
	}
	if (url.pathname === "/api/catalog/sources/reorder" && method === "POST") {
		const mutation = storeSourceReorderSchema.parse(body);
		if (mutation.kind === "skill") {
			const index = fixture.skillSources.findIndex(
				(source) => source.id === mutation.id
			);
			const targetIndex = mutation.direction === "up" ? index - 1 : index + 1;
			if (
				index >= 0 &&
				targetIndex >= 0 &&
				targetIndex < fixture.skillSources.length
			) {
				const [source] = fixture.skillSources.splice(index, 1);
				if (source) {
					fixture.skillSources.splice(targetIndex, 0, source);
				}
			}
		}
		return json(route, 200, { ok: true });
	}
	if (url.pathname === "/api/catalog" && method === "GET") {
		if (fixture.engineCatalogFailures > 0) {
			fixture.engineCatalogFailures -= 1;
			return json(route, 503, {
				error: "Fixture engine catalog unavailable",
			});
		}
		return json(route, 200, { sidecars: engineCatalogItems(fixture) });
	}
	if (url.pathname === "/api/engine/active") {
		if (method === "GET") {
			return json(route, 200, {
				active: fixture.engineActive,
				available: [IDS.engineActive, IDS.engineUpdate],
				llamacpp_variant: fixture.acceleration.installed,
				running: true,
			});
		}
		if (method === "POST") {
			const next = storeNameRequestSchema.parse(body).name;
			if ((fixture.engineActionFailures[`${next}:activate`] ?? 0) > 0) {
				fixture.engineActionFailures[`${next}:activate`] -= 1;
				return json(route, 503, {
					error: "Fixture engine activation failed",
				});
			}
			if (fixture.engineActionGates[`${next}:activate`]) {
				const gate = fixture.engineActionGates[`${next}:activate`];
				delete fixture.engineActionGates[`${next}:activate`];
				await gate?.promise;
			}
			const stopped = fixture.engineActive;
			fixture.engineActive = next;
			return json(route, 200, {
				active: next,
				gateway_refreshed: fixture.engineGatewayRefreshed,
				running: true,
				stopped,
				success: true,
				unchanged: stopped === next,
			});
		}
	}
	if (url.pathname === "/api/sidecar/status" && method === "GET") {
		return json(route, 200, {
			sidecars: Object.entries(fixture.engineRunning).map(
				([name, running]) => ({
					name,
					running,
				})
			),
		});
	}
	const engineLifecycle = url.pathname.match(
		/^\/api\/setup\/([^/]+)\/(install|uninstall)$/
	);
	if (engineLifecycle && method === "POST") {
		const name = decodeURIComponent(engineLifecycle[1] ?? "");
		const action = engineLifecycle[2] ?? "";
		const failureKey = `${name}:${action}`;
		if ((fixture.engineActionFailures[failureKey] ?? 0) > 0) {
			fixture.engineActionFailures[failureKey] -= 1;
			return json(route, 503, { error: `Fixture ${action} failed` });
		}
		const gate = fixture.engineActionGates[failureKey];
		if (gate) {
			delete fixture.engineActionGates[failureKey];
			await gate.promise;
		}
		if (action === "install") {
			fixture.engineInstalled.add(name);
			fixture.engineInstalledVersions[name] =
				name === IDS.engineUpdate ? "0.3.0" : "1.0.0";
			// Core's accepted-install reply: the force flag it honored and the
			// background-install notice the native setup contract requires.
			return json(route, 200, {
				success: true,
				forced: url.searchParams.get("force") === "true",
				message: `Sidecar '${name}' installation started in background`,
			});
		}
		fixture.engineInstalled.delete(name);
		delete fixture.engineInstalledVersions[name];
		return json(route, 200, {
			success: true,
			message: `Sidecar '${name}' uninstalled`,
		});
	}
	const sidecarControl = url.pathname.match(
		/^\/api\/sidecar\/([^/]+)\/(start|stop)$/
	);
	if (sidecarControl && method === "POST") {
		const name = decodeURIComponent(sidecarControl[1] ?? "");
		const action = sidecarControl[2] ?? "";
		const failureKey = `${name}:${action}`;
		if ((fixture.engineActionFailures[failureKey] ?? 0) > 0) {
			fixture.engineActionFailures[failureKey] -= 1;
			return json(route, 503, { error: `Fixture ${action} failed` });
		}
		const gate = fixture.engineActionGates[failureKey];
		if (gate) {
			delete fixture.engineActionGates[failureKey];
			await gate.promise;
		}
		fixture.engineRunning[name] = action === "start";
		return json(route, 200, { success: true });
	}
	if (url.pathname === "/api/sandbox/backend") {
		if (method === "GET") {
			if (fixture.sandboxListFailures > 0) {
				fixture.sandboxListFailures -= 1;
				return json(route, 503, {
					error: "Fixture sandbox list unavailable",
				});
			}
			return json(route, 200, {
				active: fixture.sandboxDefault,
				available: [
					{
						detected: true,
						display_name: "WasmTime Fixture",
						name: "wasmtime",
						supported: true,
					},
					{
						detected: false,
						display_name: "Docker Fixture",
						name: "docker",
						supported: true,
					},
					{
						detected: false,
						display_name: "OpenSandbox Fixture",
						name: "opensandbox",
						supported: false,
					},
				],
			});
		}
		if (method === "POST") {
			if (fixture.sandboxSetFailures > 0) {
				fixture.sandboxSetFailures -= 1;
				return json(route, 503, {
					error: "Fixture sandbox selection failed",
				});
			}
			if (fixture.sandboxSetGate) {
				const gate = fixture.sandboxSetGate;
				fixture.sandboxSetGate = null;
				await gate.promise;
			}
			fixture.sandboxDefault = storeNameRequestSchema.parse(body).name;
			return json(route, 200, {
				active: fixture.sandboxDefault,
				success: true,
			});
		}
	}
	if (url.pathname === "/api/engine/llamacpp/acceleration") {
		if (method === "GET") {
			return json(route, 200, {
				selected: fixture.acceleration.selected,
				resolved: fixture.acceleration.resolved,
				resolved_label: fixture.acceleration.resolvedLabel,
				installed: fixture.acceleration.installed,
				has_gpu: fixture.acceleration.hasGpu,
				gpu_name: fixture.acceleration.gpuName,
				vram: fixture.acceleration.vram,
				options: fixture.acceleration.options.map((option) => ({
					...option,
					unavailable_reason: option.unavailable_reason,
				})),
			});
		}
		if (method === "POST") {
			if (fixture.accelerationFailures > 0) {
				fixture.accelerationFailures -= 1;
				return json(route, 503, {
					error: "Fixture acceleration switch failed",
				});
			}
			if (fixture.accelerationGate) {
				const gate = fixture.accelerationGate;
				fixture.accelerationGate = null;
				await gate.promise;
			}
			fixture.acceleration.selected =
				storeVariantRequestSchema.parse(body).variant;
			fixture.acceleration.resolved = fixture.acceleration.selected;
			fixture.acceleration.resolvedLabel =
				fixture.acceleration.selected === "auto"
					? "Automatic (Metal)"
					: fixture.acceleration.selected;
			return json(route, 200, { success: true });
		}
	}

	if (url.pathname === "/api/voice/tts-engines" && method === "GET") {
		return json(route, 200, {
			data: [
				{
					default_voice: "",
					description: "The bundled OuteTTS engine fixture.",
					display_name: "OuteTTS Fixture",
					id: "outetts",
					installed: true,
					languages: ["en"],
					loaded: false,
					sample_rate: 24_000,
					size_mb: 0,
					supports_cloning: false,
					voices: [],
				},
				{
					default_voice: "af_heart",
					description: "The Kokoro speech generation fixture.",
					display_name: "Kokoro Fixture",
					id: "kokoro",
					installed: true,
					languages: ["en"],
					loaded: true,
					sample_rate: 24_000,
					size_mb: 82,
					supports_cloning: false,
					voices: ["af_heart", "af_bella"],
				},
				{
					default_voice: "alba",
					description: "The cloning-capable Pocket speech fixture.",
					display_name: "Pocket Fixture",
					id: "pocket",
					installed: true,
					languages: ["en"],
					loaded: true,
					sample_rate: 24_000,
					size_mb: 100,
					supports_cloning: true,
					voices: ["alba"],
				},
			],
		});
	}
	if (url.pathname === "/api/voice/tts-models" && method === "GET") {
		return json(route, 200, { data: [] });
	}
	if (url.pathname === "/api/voice/speak" && method === "POST") {
		return route.fulfill({
			status: 200,
			contentType: "audio/wav",
			body: "",
		});
	}
	if (url.pathname === "/api/marketplace/recommendations") {
		if (method === "POST" && url.searchParams.get("refresh") === "true") {
			if (fixture.refreshFailures > 0) {
				fixture.refreshFailures -= 1;
				return json(route, 503, { error: "Local refresh fixture failure" });
			}
			fixture.recommendations.items = [
				{
					...fixture.recommendations.items[0],
					name: "Refreshed For You Gemma",
				},
			];
			return json(route, 200, { success: true });
		}
		if (method === "GET") {
			return json(route, 200, fixture.recommendations);
		}
	}
	if (
		url.pathname === "/api/marketplace/recommendations/preference" &&
		method === "PUT"
	) {
		const patch = storeRecommendationPreferenceSchema.parse(body);
		fixture.recommendations.hidden = patch.hidden === true;
		return json(route, 200, { success: true });
	}
	return NEXT_ROUTE;
}
