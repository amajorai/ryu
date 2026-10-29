import path from "node:path";
import { expect, test } from "@playwright/test";

interface GatewayRoutingProofState {
	config: {
		routing: {
			default_provider: string;
			fallback_chain: string[];
			modality_map?: Record<string, { model?: string; provider: string }>;
			model_map: Record<string, { provider: string; provider_model?: string }>;
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
	requests: Array<{ body: unknown; method: string; path: string }>;
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
			/* SAFETY: gateway-modality-routing-proof.tsx installs __gatewayModalityRoutingProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayModalityRoutingProof: {
						snapshot: () => GatewayRoutingProofState;
					};
				}
			).__gatewayModalityRoutingProof;
		return proof.snapshot();
	});
}

function configWrites(snapshot: GatewayRoutingProofState) {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
}

test("saves a modality route with the exact preserved routing payload and retries a rejected write", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/gateway-modality-routing-proof.html");
	await expect(
		page.getByText("Modality routing", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("fal.ai → flux-fast", { exact: true })
	).toBeVisible();

	const before = await readProofState(page);
	const liveRouting = structuredClone(before.config.routing);
	liveRouting.default_provider = "openrouter";
	liveRouting.provider_tiers = {
		...liveRouting.provider_tiers,
		openrouter: 3,
	};
	await page.evaluate((routing) => {
		localStorage.setItem(
			"gateway-modality-routing-proof-config",
			JSON.stringify({ routing })
		);
	}, liveRouting);
	const expectedRouting = structuredClone(liveRouting);
	expectedRouting.modality_map ??= {};
	expectedRouting.modality_map.stt = {
		model: "whisper-large-v3",
		provider: "fal",
	};

	await page
		.getByRole("button", { name: "Set Voice Recognition routing", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Voice Recognition routing" })
	).toBeVisible();
	const providerSelect = dialog.getByRole("combobox", { name: "Provider" });
	await providerSelect.click();
	await page.getByRole("option", { name: "fal.ai", exact: true }).click();
	await dialog.getByLabel("Model (optional)").fill(" whisper-large-v3 ");

	await page.evaluate(() => {
		/* SAFETY: gateway-modality-routing-proof.tsx installs __gatewayModalityRoutingProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayModalityRoutingProof: { failNextConfigWrite: boolean };
			}
		).__gatewayModalityRoutingProof.failNextConfigWrite = true;
	});
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog.getByText(/failed: 503/u)).toBeVisible();
	await expect(
		dialog.getByRole("heading", { name: "Voice Recognition routing" })
	).toBeVisible();
	await expect(providerSelect).toContainText("fal.ai");
	await expect(dialog.getByLabel("Model (optional)")).toHaveValue(
		" whisper-large-v3 "
	);
	const afterFailure = await readProofState(page);
	expect(afterFailure.config.routing).toEqual(liveRouting);
	expect(
		afterFailure.requests
			.filter((request) => request.path.endsWith("/api/gateway/config"))
			.map((request) => request.method)
	).toEqual(["GET", "GET", "PUT"]);
	expect(configWrites(afterFailure)).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);

	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("fal.ai → whisper-large-v3", { exact: true })
	).toBeVisible();
	const saved = await readProofState(page);
	expect(saved.config.routing).toEqual(expectedRouting);
	expect(
		saved.requests
			.filter((request) => request.path.endsWith("/api/gateway/config"))
			.map((request) => request.method)
	).toEqual(["GET", "GET", "PUT", "GET", "PUT"]);
	expect(configWrites(saved)).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await expect(
		page.getByRole("button", {
			name: "Clear Voice Recognition routing",
			exact: true,
		})
	).toBeEnabled();
	await expect(page.locator("#routing-default-provider")).toContainText(
		"OpenRouter"
	);
	await page.reload();
	await expect(
		page.getByText("fal.ai → whisper-large-v3", { exact: true })
	).toBeVisible();
	expect((await readProofState(page)).config.routing).toEqual(expectedRouting);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-modality-routing-retry-persisted"),
	});
	expect(browserErrors).toEqual([]);
});

test("cancel discards a modality draft and clear removes only that route from persisted config", async ({
	page,
}) => {
	await page.goto("/gateway-modality-routing-proof.html");
	const before = await readProofState(page);
	const originalRouting = structuredClone(before.config.routing);

	await page
		.getByRole("button", { name: "Edit Image generation routing", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Image generation routing" })
	).toBeVisible();
	const model = dialog.getByLabel("Model (optional)");
	await expect(model).toHaveValue("flux-fast");
	await model.fill("discard-this-image-model");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	const canceled = await readProofState(page);
	expect(canceled.config.routing).toEqual(originalRouting);
	expect(configWrites(canceled)).toEqual([]);

	await page
		.getByRole("button", {
			name: "Clear Image generation routing",
			exact: true,
		})
		.click();
	const expectedRouting = structuredClone(originalRouting);
	expectedRouting.modality_map = Object.fromEntries(
		Object.entries(expectedRouting.modality_map ?? {}).filter(
			([modality]) => modality !== "image"
		)
	);
	await expect(
		page.getByText("fal.ai → flux-fast", { exact: true })
	).toHaveCount(0);
	const cleared = await readProofState(page);
	expect(cleared.config.routing).toEqual(expectedRouting);
	expect(configWrites(cleared)).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath(
			"gateway-modality-routing-canceled-edit-cleared-route"
		),
	});

	await page.reload();
	expect((await readProofState(page)).config.routing).toEqual(expectedRouting);
	await expect(
		page.getByRole("button", {
			name: "Set Image generation routing",
			exact: true,
		})
	).toBeVisible();
});

test("the donated OpenAI credits provider is offered and shown under its own name, and saves its own id", async ({
	page,
}) => {
	// `openai-credits` is a separate registry id so donated spend never mixes
	// with the operator's own `openai` key. The editor must name the two apart
	// rather than show the raw id, and must still write the id itself.
	await page.goto("/gateway-modality-routing-proof.html");
	const before = await readProofState(page);
	const expectedRouting = structuredClone(before.config.routing);
	expectedRouting.modality_map ??= {};
	expectedRouting.modality_map.stt = {
		model: "whisper-1",
		provider: "openai-credits",
	};

	await page
		.getByRole("button", { name: "Set Voice Recognition routing", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("combobox", { name: "Provider" }).click();
	await expect(
		page.getByRole("option", { name: "OpenAI", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: "openai-credits", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("option", { name: "OpenAI (donated credits)", exact: true })
		.click();
	const provider = dialog.getByRole("combobox", { name: "Provider" });
	await expect(provider).toContainText("OpenAI (donated credits)");
	await expect(provider).not.toContainText("openai-credits");
	await dialog.getByLabel("Model (optional)").fill("whisper-1");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("OpenAI (donated credits) → whisper-1", { exact: true })
	).toBeVisible();
	const saved = await readProofState(page);
	expect(saved.config.routing).toEqual(expectedRouting);
	expect(configWrites(saved)).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);

	await page.reload();
	await expect(
		page.getByText("OpenAI (donated credits) → whisper-1", { exact: true })
	).toBeVisible();
	expect((await readProofState(page)).config.routing).toEqual(expectedRouting);
});
