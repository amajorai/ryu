import type { Page } from "@playwright/test";
import {
	BASE_URL,
	bodyOf,
	cardFor,
	type Fixture,
	installedKey,
	json,
	listFor,
	makeFixture,
	type RequestRecord,
} from "./marketplace-store-models.helpers.ts";

// Fixtures and helpers for marketplace-store-models.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export async function installModelFixture(page: Page): Promise<Fixture> {
	const fixture = makeFixture();
	await page.addInitScript(() => {
		localStorage.setItem("ryu_session_token", "local-model-fixture");
	});
	await page.route(`${BASE_URL}/api/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const body = await bodyOf(route);
		fixture.calls.push({
			body,
			method,
			path: url.pathname,
			search: url.search,
		});

		if (url.pathname === "/api/catalog/sources" && method === "GET") {
			await json(route, 200, {
				active: fixture.activeSource,
				sources: [
					{ builtin: true, display_name: "Hugging Face", id: "huggingface" },
					{
						builtin: false,
						base_url: "https://models.example.test",
						display_name: "Local mirror",
						id: fixture.communityMirrorSource,
					},
				],
			});
			return;
		}
		if (url.pathname === "/api/catalog/sources/select" && method === "POST") {
			// SAFETY: The mounted model source selector passes a fixture source string ID through useModelCatalog to selectModelSource, whose request serializes { id, kind } into this controlled POST.
			fixture.activeSource = (body as { id: string }).id;
			await json(route, 200, { success: true });
			return;
		}
		if (url.pathname === "/api/catalog" && method === "GET") {
			const installState = fixture.engineInstallState;
			if (installState === "installing") {
				fixture.engineInstallReads += 1;
				fixture.engineInstallState = "installed";
			}
			await json(route, 200, {
				sidecars: [
					{
						category: "provider",
						deprecated: false,
						description: "Local text inference",
						display_name: "llama.cpp",
						install_state: installState,
						installed_version: installState === "installed" ? "fixture" : null,
						latest_version: "fixture",
						name: "llamacpp",
						platforms: [],
						recommended: true,
						supported: true,
						update_available: false,
					},
				],
			});
			return;
		}
		if (url.pathname === "/api/models/engines" && method === "GET") {
			await json(route, 200, {
				formats: [
					{
						engines: [{ name: "llamacpp", supported: true }],
						format: "gguf",
						supported: true,
					},
				],
				resident: "llamacpp",
			});
			return;
		}
		if (url.pathname === "/api/setup/llamacpp/install" && method === "POST") {
			fixture.engineInstallState = "installing";
			fixture.engineInstallReads = 0;
			// Core's accepted-install reply: the force flag it honored and the
			// background-install notice the native setup contract requires.
			await json(route, 200, {
				success: true,
				forced: url.searchParams.get("force") === "true",
				message: "Sidecar 'llamacpp' installation started in background",
			});
			return;
		}
		if (url.pathname === "/api/models/catalog" && method === "GET") {
			if (fixture.modelListFailures > 0) {
				fixture.modelListFailures -= 1;
				await json(route, 503, { error: "Model catalog fixture is offline" });
				return;
			}
			const params = url.searchParams;
			const results = listFor(fixture, params);
			if (fixture.paginationEnabled) {
				const cursor = params.get("cursor");
				const page = cursor ? results.slice(4) : results.slice(0, 4);
				await json(route, 200, {
					models: page.map((entry) => cardFor(fixture, entry)),
					next_cursor: !cursor && results.length > 4 ? "page-two" : null,
					total: results.length,
				});
				return;
			}
			await json(route, 200, {
				models: results.map((entry) => cardFor(fixture, entry)),
				next_cursor: null,
				total: results.length,
			});
			return;
		}
		if (url.pathname === "/api/models/catalog/detail" && method === "GET") {
			if (fixture.detailFailures > 0) {
				fixture.detailFailures -= 1;
				await json(route, 503, { error: "Model detail fixture is offline" });
				return;
			}
			const id = url.searchParams.get("id") ?? "";
			const format = url.searchParams.get("format") ?? "gguf";
			const modelEntry = fixture.models.find((entry) => entry.id === id);
			if (!modelEntry) {
				await json(route, 404, { error: "Unknown model fixture" });
				return;
			}
			const modelCard = cardFor(fixture, modelEntry);
			const snapshot = format !== "gguf";
			await json(route, 200, {
				card: modelCard,
				device: {
					gpu_name: "Fixture GPU",
					os: "linux",
					ram_human: "64 GB",
					total_ram_bytes: 64_000_000_000,
					unified_memory: false,
					vram_bytes: 24_000_000_000,
					vram_human: "24 GB",
				},
				files: snapshot
					? []
					: (fixture.files[id] ?? []).map((file) => ({
							...file,
							installed: fixture.installedFiles.has(
								installedKey(id, file.filename)
							),
						})),
				format,
				readme:
					"Fixture model notes. See [the local usage guide](https://docs.example.test/model-usage).",
				repo_fit: "great",
				repo_fit_label: "Fits the fixture device.",
				repo_size_bytes: snapshot ? 7_200_000_000 : null,
				stats_api_key_present: false,
				vision: id === "meta/llama-8b-vision",
			});
			return;
		}
		if (url.pathname === "/api/models/catalog/install" && method === "POST") {
			// SAFETY: The mounted native model catalog calls installModelFile/installModelSnapshot with selected fixture string IDs and file/format strings; previewModelInstall adds only literal true dryRun before native request JSON serialization.
			const payload = body as {
				dryRun?: boolean;
				file?: string;
				format?: string;
				id: string;
			};
			if (payload.dryRun) {
				await json(route, 200, {
					action: "install",
					dryRun: true,
					success: true,
				});
				return;
			}
			if (payload.file) {
				if (fixture.installFailures > 0) {
					const gate = fixture.installGate;
					fixture.installGate = null;
					if (gate) {
						await gate;
					}
					fixture.installFailures -= 1;
					await json(route, 200, {
						error: "Fixture model transfer failed",
						success: false,
					});
					return;
				}
				fixture.installedFiles.add(installedKey(payload.id, payload.file));
				await json(route, 200, {
					result: {
						filename: payload.file,
						path: `/fixture/models/${payload.id}/${payload.file}`,
						repo_id: payload.id,
					},
					success: true,
				});
				return;
			}
			if (fixture.snapshotFailures > 0) {
				fixture.snapshotFailures -= 1;
				await json(route, 200, {
					error: "Fixture snapshot transfer failed",
					success: false,
				});
				return;
			}
			fixture.installedSnapshots.add(payload.id);
			await json(route, 200, {
				result: {
					filename: "snapshot",
					path: `/fixture/models/${payload.id}`,
					repo_id: payload.id,
				},
				success: true,
			});
			return;
		}
		if (url.pathname === "/api/models/catalog/uninstall" && method === "POST") {
			// SAFETY: The mounted native file remove action calls uninstallModelFile with selected fixture string ID and filename; previewModelUninstall uses the same fields plus literal true dryRun before native JSON serialization.
			const payload = body as { dryRun?: boolean; file: string; id: string };
			if (payload.dryRun) {
				await json(route, 200, {
					action: "uninstall",
					dryRun: true,
					success: true,
				});
				return;
			}
			if (fixture.uninstallFailures > 0) {
				fixture.uninstallFailures -= 1;
				await json(route, 200, {
					error: "Fixture model removal failed",
					success: false,
				});
				return;
			}
			fixture.installedFiles.delete(installedKey(payload.id, payload.file));
			await json(route, 200, { success: true });
			return;
		}
		if (url.pathname === "/api/models/active" && method === "GET") {
			await json(route, 200, {
				active: fixture.activeModel,
				default: "meta/llama-8b-chat",
				engine: "llama.cpp",
				format: "gguf",
				ref: fixture.activeModel,
				repo_id: fixture.activeModel,
			});
			return;
		}
		if (url.pathname === "/api/models/active" && method === "POST") {
			if (fixture.activeFailures > 0) {
				fixture.activeFailures -= 1;
				await json(route, 200, {
					error: "Fixture engine is temporarily unavailable",
					success: false,
				});
				return;
			}
			// SAFETY: The mounted ActiveModelControl passes the selected fixture string repository ID to setActiveModel; its native request serializes that id into this controlled POST.
			fixture.activeModel = (body as { id: string }).id;
			await json(route, 200, {
				active: fixture.activeModel,
				engine: "llama.cpp",
				format: "gguf",
				gateway_refreshed: true,
				restarted: false,
				success: true,
				swapped: true,
			});
			return;
		}
		if (url.pathname === "/api/models/llmfit-estimate" && method === "GET") {
			if (fixture.llmfitFailures > 0) {
				fixture.llmfitFailures -= 1;
				await json(route, 503, { error: "Fixture speed estimator offline" });
				return;
			}
			await json(route, 200, {
				fit_level: "great",
				installed: fixture.publishedLlmfit,
				matched: fixture.publishedLlmfit,
				min_vram_gb: 12,
				model_name: "Fixture Gemma",
				path: "fixture_catalog",
				tps: 42,
			});
			return;
		}
		if (url.pathname === "/api/setup/llmfit/install" && method === "POST") {
			if (fixture.sidecarFailures > 0) {
				fixture.sidecarFailures -= 1;
				await json(route, 200, {
					error: "Fixture speed estimator install failed",
					success: false,
				});
				return;
			}
			fixture.publishedLlmfit = true;
			await json(route, 200, {
				success: true,
				forced: url.searchParams.get("force") === "true",
				message: "Sidecar 'llmfit' installation started in background",
			});
			return;
		}
		if (url.pathname === "/api/models/installed" && method === "GET") {
			await json(route, 200, { models: [] });
			return;
		}
		await json(route, 200, {});
	});
	return fixture;
}

export function modelSearchCalls(fixture: Fixture): RequestRecord[] {
	return fixture.calls.filter(
		(call) => call.path === "/api/models/catalog" && call.method === "GET"
	);
}

export function latestSearch(fixture: Fixture): URLSearchParams {
	const call = modelSearchCalls(fixture).at(-1);
	return new URLSearchParams(call?.search ?? "");
}

export async function chooseSelectOption(
	page: Page,
	index: number,
	optionName: string
): Promise<void> {
	await page.getByRole("combobox").nth(index).click();
	await page.getByRole("option", { name: optionName, exact: true }).click();
}

export async function openFilters(page: Page): Promise<void> {
	const filters = page.getByRole("button", { name: "Filters", exact: true });
	if ((await filters.getAttribute("aria-expanded")) !== "true") {
		await filters.click();
	}
}

export async function closeFilters(page: Page): Promise<void> {
	const filters = page.getByRole("button", { name: "Filters", exact: true });
	if ((await filters.getAttribute("aria-expanded")) === "true") {
		await filters.click();
	}
}
