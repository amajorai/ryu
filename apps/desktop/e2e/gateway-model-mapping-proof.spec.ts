import path from "node:path";
import { expect, test } from "@playwright/test";

interface GatewayModelMappingSnapshot {
	config: {
		routing: {
			default_provider: string;
			eval_routing?: {
				candidates: string[];
				enabled: boolean;
				explore_ratio: number;
			};
			fallback_chain: string[];
			modality_map?: Record<string, { model?: string; provider: string }>;
			model_map: Record<string, { provider: string; provider_model?: string }>;
			provider_tiers?: Record<string, number>;
			smart_routing?: {
				cache_by_session: boolean;
				classifier_model: string;
				embedding_model: string;
				enabled: boolean;
				rules: { description: string; model: string }[];
				similarity_threshold: number;
				strategy: string;
				timeout_ms: number;
			};
		};
	};
	requests: { body: unknown; method: string; path: string }[];
}

function screenshotPath(name: string): string {
	// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
	// the tracked proof ledger; without it the committed evidence is refreshed.
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, `${name}.png`);
	}
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function readProofState(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-model-mapping-proof.tsx installs __gatewayModelMappingProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayModelMappingProof: {
						snapshot: () => GatewayModelMappingSnapshot;
					};
				}
			).__gatewayModelMappingProof;
		return proof.snapshot();
	});
}

function configWrites(snapshot: GatewayModelMappingSnapshot) {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
}

function gatewayConfigRequests(snapshot: GatewayModelMappingSnapshot) {
	return snapshot.requests.filter((request) =>
		request.path.endsWith("/api/gateway/config")
	);
}

async function visibleFallbackProviderOrder(
	page: import("@playwright/test").Page
) {
	const fallbackGroup = page.locator('[data-slot="item-group"]').filter({
		has: page.getByRole("button", {
			name: /Remove .* from fallback chain/,
		}),
	});
	return (
		await fallbackGroup.locator('[data-slot="item-title"]').allTextContents()
	).map((provider) => provider.trim());
}

test.describe.configure({ timeout: 60_000 });

test("validates and creates a trimmed mapping while preserving full routing state and reload", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/gateway-model-mapping-proof.html");
	await expect(
		page.getByText("friendly-code-model", { exact: true })
	).toBeVisible();

	const before = await readProofState(page);
	await page.getByRole("button", { name: "Add mapping" }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Add model mapping" })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog.getByText("Model name is required.")).toBeVisible();
	expect((await readProofState(page)).requests).toHaveLength(
		before.requests.length
	);

	await dialog.getByLabel("Model name (request)").fill(" openrouter/auto ");
	await dialog.getByRole("combobox", { name: "Provider" }).click();
	await page.getByRole("option", { name: "OpenRouter" }).click();
	await dialog
		.getByLabel("Provider model name (optional)")
		.fill(" google/gemini-2.5-pro ");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Edit mapping for openrouter/auto" })
	).toBeVisible();

	const expected = structuredClone(before.config.routing);
	expected.model_map["openrouter/auto"] = {
		provider: "openrouter",
		provider_model: "google/gemini-2.5-pro",
	};
	const saved = await readProofState(page);
	expect(saved.config.routing).toEqual(expected);
	const writes = configWrites(saved);
	expect(writes).toHaveLength(1);
	expect(writes[0]?.body).toEqual({ routing: expected });
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-created-and-persisted"),
	});

	await page.reload();
	await expect(
		page.getByRole("button", { name: "Edit mapping for openrouter/auto" })
	).toBeVisible();
	expect((await readProofState(page)).config.routing).toEqual(expected);
	expect(browserErrors).toEqual([]);
});

test("edits the provider and clears an optional provider-model rewrite", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html");
	const before = await readProofState(page);
	await page
		.getByRole("button", { name: "Edit mapping for friendly-code-model" })
		.click();
	const dialog = page.getByRole("dialog");
	const model = dialog.getByLabel("Model name (request)");
	await expect(model).toBeDisabled();
	await expect(model).toHaveValue("friendly-code-model");
	await dialog.getByRole("combobox", { name: "Provider" }).click();
	await page.getByRole("option", { name: "Anthropic" }).click();
	await dialog.getByLabel("Provider model name (optional)").fill("   ");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);

	const expected = structuredClone(before.config.routing);
	expected.model_map["friendly-code-model"] = { provider: "anthropic" };
	const saved = await readProofState(page);
	expect(saved.config.routing).toEqual(expected);
	expect(configWrites(saved)).toHaveLength(1);
	expect(configWrites(saved)[0]?.body).toEqual({ routing: expected });
	await expect(
		page.getByRole("button", {
			name: "Edit mapping for friendly-code-model",
		})
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-edited-provider"),
	});

	await page.reload();
	await page
		.getByRole("button", { name: "Edit mapping for friendly-code-model" })
		.click();
	const reloadedDialog = page.getByRole("dialog");
	await expect(
		reloadedDialog.getByLabel("Provider model name (optional)")
	).toHaveValue("");
	await expect(
		reloadedDialog.getByRole("combobox", { name: "Provider" })
	).toContainText("Anthropic");
});

test("canceling a model-mapping edit discards its draft and reopening restores the saved values", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html");
	const before = await readProofState(page);

	await page
		.getByRole("button", { name: "Edit mapping for friendly-code-model" })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("combobox", { name: "Provider" }).click();
	await page.getByRole("option", { name: "Anthropic", exact: true }).click();
	await dialog
		.getByLabel("Provider model name (optional)")
		.fill("discard-this-rewrite");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);

	const afterCancel = await readProofState(page);
	expect(afterCancel.config.routing).toEqual(before.config.routing);
	expect(configWrites(afterCancel)).toHaveLength(0);

	await page
		.getByRole("button", { name: "Edit mapping for friendly-code-model" })
		.click();
	const reopened = page.getByRole("dialog");
	await expect(reopened.getByLabel("Model name (request)")).toHaveValue(
		"friendly-code-model"
	);
	await expect(
		reopened.getByRole("combobox", { name: "Provider" })
	).toContainText("OpenAI");
	await expect(
		reopened.getByLabel("Provider model name (optional)")
	).toHaveValue("gpt-4.1-mini");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-edit-cancel-restored"),
	});
	expect(gatewayConfigRequests(await readProofState(page))).toEqual(
		gatewayConfigRequests(before)
	);
});

test("a failed model-mapping edit preserves the draft and retries the exact saved routing payload", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/gateway-model-mapping-proof.html");
	const before = await readProofState(page);

	await page
		.getByRole("button", { name: "Edit mapping for friendly-code-model" })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("combobox", { name: "Provider" }).click();
	await page.getByRole("option", { name: "OpenRouter", exact: true }).click();
	await dialog
		.getByLabel("Provider model name (optional)")
		.fill("openrouter/auto");

	const expected = structuredClone(before.config.routing);
	expected.model_map["friendly-code-model"] = {
		provider: "openrouter",
		provider_model: "openrouter/auto",
	};
	await page.evaluate(() => {
		/* SAFETY: gateway-model-mapping-proof.tsx installs __gatewayModelMappingProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayModelMappingProof: { failNextConfigWrite: boolean };
			}
		).__gatewayModelMappingProof.failNextConfigWrite = true;
	});

	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		dialog.getByText("/api/gateway/config failed: 503")
	).toBeVisible();
	await expect(
		dialog.getByRole("combobox", { name: "Provider" })
	).toContainText("OpenRouter");
	await expect(dialog.getByLabel("Provider model name (optional)")).toHaveValue(
		"openrouter/auto"
	);
	const failed = await readProofState(page);
	expect(failed.config.routing).toEqual(before.config.routing);
	expect(configWrites(failed)).toEqual([
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-edit-save-error"),
	});

	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	const saved = await readProofState(page);
	expect(saved.config.routing).toEqual(expected);
	expect(configWrites(saved)).toEqual([
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.reload();
	await page
		.getByRole("button", { name: "Edit mapping for friendly-code-model" })
		.click();
	const reloadedDialog = page.getByRole("dialog");
	await expect(
		reloadedDialog.getByRole("combobox", { name: "Provider" })
	).toContainText("OpenRouter");
	await expect(
		reloadedDialog.getByLabel("Provider model name (optional)")
	).toHaveValue("openrouter/auto");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-edit-retry-persisted"),
	});
	expect((await readProofState(page)).config.routing).toEqual(expected);
	expect(browserErrors).toEqual([]);
});

test("Move up changes the visible fallback order and the exact order survives a failed-save retry and reload", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html");
	const before = await readProofState(page);
	expect(before.config.routing.fallback_chain).toEqual(["openai", "local"]);
	await expect
		.poll(() => visibleFallbackProviderOrder(page))
		.toEqual(["OpenAI", "Local"]);

	const moveUp = page.getByRole("button", { name: "Move up" });
	await expect(moveUp.first()).toBeDisabled();
	await expect(moveUp.nth(1)).toBeEnabled();
	await moveUp.nth(1).click();
	const movedOrder = ["Local", "OpenAI"];
	await expect
		.poll(() => visibleFallbackProviderOrder(page))
		.toEqual(movedOrder);

	const expected = structuredClone(before.config.routing);
	expected.fallback_chain = ["local", "openai"];
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-routing-move-up-draft"),
	});
	await page.evaluate(() => {
		/* SAFETY: gateway-model-mapping-proof.tsx installs __gatewayModelMappingProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayModelMappingProof: { failNextConfigWrite: boolean };
			}
		).__gatewayModelMappingProof.failNextConfigWrite = true;
	});

	const save = page.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(page.getByText("/api/gateway/config failed: 503")).toBeVisible();
	await expect
		.poll(() => visibleFallbackProviderOrder(page))
		.toEqual(movedOrder);
	const failed = await readProofState(page);
	expect(failed.config.routing).toEqual(before.config.routing);
	expect(configWrites(failed)).toEqual([
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-model-routing-move-up-save-error"),
	});

	await save.click();
	await expect(
		page.getByText("Saved. Gateway will apply on next restart.")
	).toBeVisible();
	const saved = await readProofState(page);
	expect(saved.config.routing).toEqual(expected);
	expect(configWrites(saved)).toEqual([
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.reload();
	expect((await readProofState(page)).config.routing).toEqual(expected);
	await expect
		.poll(() => visibleFallbackProviderOrder(page))
		.toEqual(movedOrder);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-routing-move-up-reloaded"),
	});
});

test("reorders, removes, and adds fallback providers; a failed exact save retries and persists", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html");
	const before = await readProofState(page);
	const defaultProvider = page.getByRole("combobox", {
		name: "Default provider",
	});
	await expect(defaultProvider).toContainText("Anthropic");
	await defaultProvider.click();
	await page.getByRole("option", { name: "OpenRouter", exact: true }).click();
	await page.keyboard.press("Escape");
	await page.getByRole("heading", { name: "Gateway model mappings" }).click();
	await expect(page.getByRole("listbox")).toBeHidden();

	const moveDown = page.getByRole("button", { name: "Move down" });
	const moveUp = page.getByRole("button", { name: "Move up" });
	await expect(moveUp.first()).toBeDisabled();
	await expect(moveDown.nth(1)).toBeDisabled();
	await moveDown.first().click();
	await moveUp.nth(1).click();
	await page
		.getByRole("button", { name: "Remove local from fallback chain" })
		.click();
	await page.getByRole("button", { name: "OpenRouter", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "OpenRouter", exact: true })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Move down" }).first().click();
	await expect(
		page.getByRole("button", { name: "Move up" }).first()
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Move down" }).nth(1)
	).toBeDisabled();

	const expected = structuredClone(before.config.routing);
	expected.default_provider = "openrouter";
	expected.fallback_chain = ["openrouter", "openai"];
	await page.evaluate(() => {
		/* SAFETY: gateway-model-mapping-proof.tsx installs __gatewayModelMappingProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayModelMappingProof: { failNextConfigWrite: boolean };
			}
		).__gatewayModelMappingProof.failNextConfigWrite = true;
	});
	const save = page.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(page.getByText("/api/gateway/config failed: 503")).toBeVisible();
	await expect(save).toBeEnabled();
	const failed = await readProofState(page);
	expect(failed.config.routing).toEqual(before.config.routing);
	expect(configWrites(failed)).toEqual([
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-model-routing-fallback-save-error"),
	});

	await save.click();
	await expect(
		page.getByText("Saved. Gateway will apply on next restart.")
	).toBeVisible();
	const saved = await readProofState(page);
	expect(saved.config.routing).toEqual(expected);
	expect(configWrites(saved)).toEqual([
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
		{
			body: { routing: expected },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-routing-fallback-saved"),
	});
	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Default provider" })
	).toContainText("OpenRouter");
	expect((await readProofState(page)).config.routing).toEqual(expected);
});

test("removes a model mapping, reports a failed write, and allows retry", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html");
	const before = await readProofState(page);
	await page.evaluate(() => {
		/* SAFETY: gateway-model-mapping-proof.tsx installs __gatewayModelMappingProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayModelMappingProof: { failNextConfigWrite: boolean };
			}
		).__gatewayModelMappingProof.failNextConfigWrite = true;
	});
	await page
		.getByRole("button", { name: "Remove mapping for friendly-code-model" })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"/api/gateway/config failed: 503"
	);
	await expect(
		page.getByText("friendly-code-model", { exact: true })
	).toBeVisible();
	expect((await readProofState(page)).config.routing).toEqual(
		before.config.routing
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-delete-retry-error"),
	});

	await page
		.getByRole("button", { name: "Remove mapping for friendly-code-model" })
		.click();
	await expect(
		page.getByText("friendly-code-model", { exact: true })
	).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveCount(0);
	const expected = structuredClone(before.config.routing);
	expected.model_map = Object.fromEntries(
		Object.entries(expected.model_map).filter(
			([modelName]) => modelName !== "friendly-code-model"
		)
	);
	const saved = await readProofState(page);
	expect(saved.config.routing).toEqual(expected);
	expect(configWrites(saved)).toHaveLength(2);
	expect(configWrites(saved)[1]?.body).toEqual({ routing: expected });
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-deleted-and-persisted"),
	});
	await page.reload();
	await expect(
		page.getByText("friendly-code-model", { exact: true })
	).toHaveCount(0);
	expect((await readProofState(page)).config.routing).toEqual(expected);
});

test("canceling the add dialog changes neither server state nor request history", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html");
	const before = await readProofState(page);
	await page.getByRole("button", { name: "Add mapping" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Model name (request)").fill("discard-me");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	const after = await readProofState(page);
	expect(after.config.routing).toEqual(before.config.routing);
	expect(gatewayConfigRequests(after)).toEqual(gatewayConfigRequests(before));
	await expect(page.getByText("discard-me", { exact: true })).toHaveCount(0);
});

test("read-only permission disables add, edit, and remove without sending writes", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html?readOnly=true");
	await expect(
		page.getByText("friendly-code-model", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add mapping" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Edit mapping for friendly-code-model" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove mapping for friendly-code-model" })
	).toBeDisabled();
	await expect(
		page.getByRole("combobox", { name: "Default provider" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Move up" }).nth(1)
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Move down" }).first()
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove openai from fallback chain" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove local from fallback chain" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "OpenRouter", exact: true })
	).toBeDisabled();
	const proof = await readProofState(page);
	expect(configWrites(proof)).toHaveLength(0);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-routing-read-only-controls"),
	});

	await page.goto("/gateway-model-mapping-proof.html?unreachable=true");
	await expect(page.getByText(/Gateway unreachable/)).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add mapping" })
	).toBeDisabled();
	const unreachable = await readProofState(page);
	expect(gatewayConfigRequests(unreachable)).toEqual([]);
});

test("keeps provider-dependent routing controls disabled until a provider is configured", async ({
	page,
}) => {
	await page.goto("/gateway-model-mapping-proof.html?noProviders=true");
	await expect(
		page.getByRole("combobox", { name: "Default provider" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Add mapping", exact: true })
	).toBeDisabled();
	const proof = await readProofState(page);
	expect(configWrites(proof)).toHaveLength(0);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-routing-no-configured-providers"),
	});
});

test("retries a failed initial Gateway config read", async ({ page }) => {
	await page.goto("/gateway-model-mapping-proof.html?failRead=true");
	await expect(page.getByRole("alert")).toContainText(
		"/api/gateway/config failed: 503"
	);
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByText("friendly-code-model", { exact: true })
	).toBeVisible();
	const proof = await readProofState(page);
	expect(
		proof.requests.filter(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method === "GET"
		)
	).toHaveLength(2);
	expect(configWrites(proof)).toHaveLength(0);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-model-mapping-config-read-retried"),
	});
});
