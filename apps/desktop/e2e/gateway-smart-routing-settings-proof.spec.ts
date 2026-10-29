import { expect, type Page, test } from "@playwright/test";
import type {
	GatewayRoutingConfig,
	SmartRoutingConfig,
} from "../src/lib/api/gateway.ts";

const CLASSIFY_MODEL_ID = "gemma-3-270m-it-qat-Q4_0";

interface SmartRoutingProofSnapshot {
	config: {
		routing: GatewayRoutingConfig;
	};
	requests: { body: unknown; method: string; path: string }[];
}

function screenshotPath(name: string): string {
	return test.info().outputPath(`${name}.png`);
}

async function readProofState(page: Page) {
	// Vite's module graph can finish after page.goto's load event. A snapshot
	// requires the fixture to be installed, not merely the HTML to be loaded.
	await page.waitForFunction(() => {
		const proof = (
			window as Window & { __gatewaySmartRoutingProof?: { snapshot?: unknown } }
		).__gatewaySmartRoutingProof;
		return typeof proof?.snapshot === "function";
	});
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-smart-routing-settings-proof.tsx installs __gatewaySmartRoutingProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewaySmartRoutingProof: {
						snapshot: () => SmartRoutingProofSnapshot;
					};
				}
			).__gatewaySmartRoutingProof;
		return proof.snapshot();
	});
}

async function chooseSelect(
	page: Page,
	name: string,
	option: RegExp
): Promise<void> {
	await page.getByRole("combobox", { name }).click();
	await page.getByRole("option", { name: option }).click();
	await page.keyboard.press("Escape");
	await page
		.getByRole("heading", { name: "Gateway smart routing settings" })
		.click();
	await expect(page.getByRole("combobox", { name })).toHaveAttribute(
		"aria-expanded",
		"false"
	);
	await expect(page.getByRole("listbox")).toBeHidden();
}

async function chooseCustomModel(
	page: Page,
	fieldName: string,
	modelId: string
): Promise<void> {
	const field = page.getByRole("button", { name: fieldName, exact: true });
	await field.click();
	const dialog = page.getByRole("dialog");
	const customModel = dialog.getByRole("textbox", { name: "Custom model id" });
	await customModel.fill(modelId);
	await customModel.press("Enter");
	await expect(field).toContainText(modelId.trim());
}

async function chooseCatalogModel(
	page: Page,
	fieldName: string,
	providerName: string,
	modelId: string
): Promise<void> {
	const field = page.getByRole("button", { name: fieldName, exact: true });
	await field.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("option", { name: providerName, exact: true }).click();
	await dialog.getByRole("option", { name: /^Model /u }).click();
	await dialog.getByRole("option", { name: modelId, exact: true }).click();
	await expect(field).toContainText(modelId);
}

function writeRequests(snapshot: SmartRoutingProofSnapshot) {
	return snapshot.requests.filter(
		(request) =>
			request.method === "PUT" && request.path === "/api/gateway/config"
	);
}

function configRequests(snapshot: SmartRoutingProofSnapshot) {
	return snapshot.requests.filter((request) =>
		request.path.endsWith("/api/gateway/config")
	);
}

async function rejectIncompleteRule(page: Page) {
	const before = await readProofState(page);
	await page.getByRole("button", { name: "Add rule", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Remove rule 2" })
	).toBeVisible();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Complete or remove each incomplete rule."
	);
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-incomplete-rule-blocked"),
	});
	const after = await readProofState(page);
	expect(configRequests(after)).toEqual(configRequests(before));
	expect(after.config.routing).toEqual(before.config.routing);
	return before;
}

function requireSmartRouting(
	routing: GatewayRoutingConfig
): SmartRoutingConfig {
	const smartRouting = routing.smart_routing;
	if (!smartRouting) {
		throw new Error("The local Gateway fixture did not report smart routing.");
	}
	return smartRouting;
}

// The first case opens the page on a cold dev server, which compiles the whole
// Gateway dialog graph on first request and again on its reload; on a loaded
// host that alone took 33-59 s of the old 60 s budget.
test.describe.configure({ timeout: 120_000 });

test("saves smart-routing enablement and threshold with complete routing state", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) =>
		browserErrors.push(`${error.name}: ${error.message}`)
	);
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(
				JSON.stringify({ location: message.location(), text: message.text() })
			);
		}
	});
	await page.goto("/gateway-smart-routing-settings-proof.html");
	expect(browserErrors).toEqual([]);

	const enable = page.getByRole("switch", { name: "Enable smart routing" });
	const threshold = page.getByRole("slider", {
		name: "Similarity threshold",
	});
	await expect(enable).toBeVisible();
	await expect(enable).not.toBeChecked();
	await expect(threshold).toHaveAttribute("aria-valuenow", "0.35");
	const before = await readProofState(page);

	await enable.click();
	await threshold.press("ArrowRight");
	await expect(threshold).toHaveAttribute("aria-valuenow", "0.4");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();

	const saved = await readProofState(page);
	const put = saved.requests.find(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
	expect(put, "save reaches the Gateway config endpoint").toBeDefined();
	const payload = put?.body;
	const initialSmartRouting = before.config.routing.smart_routing;
	expect(initialSmartRouting).toBeDefined();
	if (!initialSmartRouting) {
		throw new Error("Smart routing fixture is missing");
	}
	const expectedRouting: GatewayRoutingConfig = {
		...before.config.routing,
		smart_routing: {
			...initialSmartRouting,
			enabled: true,
			similarity_threshold: 0.4,
		},
	};
	expect(put).toEqual({
		body: { routing: expectedRouting },
		method: "PUT",
		path: "/api/gateway/config",
	});
	expect(payload).toMatchObject({
		routing: {
			smart_routing: {
				enabled: true,
				similarity_threshold: 0.4,
				strategy: "embedding",
			},
			default_provider: "anthropic",
			fallback_chain: ["openai"],
			model_map: {
				"friendly-code-model": {
					provider: "openai",
					provider_model: "gpt-4.1-mini",
				},
			},
		},
	});
	expect(payload).toMatchObject({
		routing: { provider_tiers: { anthropic: 0, openai: 1 } },
	});

	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-saved"),
	});
	await page.reload();
	await expect(
		page.getByRole("switch", { name: "Enable smart routing" })
	).toBeChecked();
	await expect(
		page.getByRole("slider", { name: "Similarity threshold" })
	).toHaveAttribute("aria-valuenow", "0.4");
	expect(browserErrors).toEqual([]);
});

test("keeps the draft after a rejected write and persists it on retry", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const enable = page.getByRole("switch", { name: "Enable smart routing" });
	const threshold = page.getByRole("slider", {
		name: "Similarity threshold",
	});
	await expect(enable).toBeVisible();
	await enable.click();
	await threshold.press("ArrowRight");
	await page.evaluate(() => {
		/* SAFETY: gateway-smart-routing-settings-proof.tsx installs __gatewaySmartRoutingProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewaySmartRoutingProof: { failNextConfigWrite: boolean };
			}
		).__gatewaySmartRoutingProof.failNextConfigWrite = true;
	});

	const save = page.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(page.getByText("/api/gateway/config failed: 503")).toBeVisible();
	await expect(enable).toBeChecked();
	await expect(threshold).toHaveAttribute("aria-valuenow", "0.4");
	await expect(save).toBeEnabled();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-write-error"),
	});

	await save.click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	const saved = await readProofState(page);
	expect(saved.config.routing.smart_routing).toMatchObject({
		enabled: true,
		similarity_threshold: 0.4,
	});
	const writes = saved.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
	expect(writes).toHaveLength(2);
	expect(writes[0]?.body).toEqual(writes[1]?.body);
});

test("offers a real config reload retry after the initial Gateway read fails", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html?failRead=true");
	await expect(page.getByRole("alert")).toContainText(
		"/api/gateway/config failed: 503"
	);
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
	await page.evaluate(() => {
		/* SAFETY: gateway-smart-routing-settings-proof.tsx installs __gatewaySmartRoutingProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewaySmartRoutingProof: {
					setRemoteSmartRoutingEnabled: (enabled: boolean) => void;
				};
			}
		).__gatewaySmartRoutingProof.setRemoteSmartRoutingEnabled(true);
	});
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByRole("switch", { name: "Enable smart routing" })
	).toBeChecked();
	const proof = await readProofState(page);
	expect(
		proof.requests.filter(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method === "GET"
		)
	).toHaveLength(2);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-load-retry"),
	});
});

test("does not fabricate an off switch when the Gateway omits smart-routing config", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html?missing=smart");
	const enable = page.getByRole("switch", { name: "Enable smart routing" });
	await expect(
		page.getByText(/does not report its smart-routing config/)
	).toBeVisible();
	await expect(enable).not.toBeChecked();
	await expect(enable).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	const proof = await readProofState(page);
	expect(proof.config.routing).not.toHaveProperty("smart_routing");
	expect(
		proof.requests.some(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method === "PUT"
		)
	).toBe(false);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-unreported-config"),
	});
});

test("refuses a save if the fresh Gateway read no longer reports smart routing", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const enable = page.getByRole("switch", { name: "Enable smart routing" });
	await expect(enable).toBeVisible();
	await enable.click();
	await page.evaluate(() => {
		/* SAFETY: gateway-smart-routing-settings-proof.tsx installs __gatewaySmartRoutingProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewaySmartRoutingProof: {
					omitSmartRoutingOnNextConfigRead: boolean;
				};
			}
		).__gatewaySmartRoutingProof.omitSmartRoutingOnNextConfigRead = true;
	});
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText(/no longer reports its smart-routing config/)
	).toBeVisible();
	await expect(enable).toBeDisabled();
	const proof = await readProofState(page);
	expect(
		proof.requests.some(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method === "PUT"
		)
	).toBe(false);
	expect(proof.config.routing.smart_routing?.enabled).toBe(false);
});

test("edits strategy, model, embedding threshold, rules, and fallback in the saved routing payload", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const strategy = page.getByRole("combobox", { name: "Strategy" });
	await expect(strategy).toContainText("Match on meaning");
	const before = await readProofState(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);

	await page.getByRole("switch", { name: "Enable smart routing" }).click();
	await chooseSelect(page, "Strategy", /^Let a model decide/u);
	await chooseCatalogModel(page, "Classifier model", "OpenAI", "gpt-4o-mini");
	await chooseSelect(page, "Strategy", /^Match on meaning/u);
	await page.getByLabel("Embedding model").fill("  nomic-embed-large  ");
	await page
		.getByRole("slider", { name: "Similarity threshold" })
		.press("ArrowRight");
	await expect(
		page.getByRole("slider", { name: "Similarity threshold" })
	).toHaveAttribute("aria-valuenow", "0.4");
	await page
		.getByPlaceholder("When the request is about… (plain language)")
		.fill("  research requests  ");
	await chooseCustomModel(
		page,
		"Route to model for rule 1",
		"  anthropic/claude-haiku-4-5  "
	);
	await chooseCatalogModel(
		page,
		"Default model when no rule matches",
		"OpenAI",
		"gpt-4.1-mini"
	);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();

	const expectedSmartRouting: SmartRoutingConfig = {
		...initialSmartRouting,
		enabled: true,
		strategy: "embedding",
		classifier_model: "gpt-4o-mini",
		embedding_model: "nomic-embed-large",
		similarity_threshold: 0.4,
		rules: [
			{
				description: "research requests",
				model: "anthropic/claude-haiku-4-5",
				weight: 1,
			},
		],
		default_model: "gpt-4.1-mini",
	};
	const expectedRouting: GatewayRoutingConfig = {
		...before.config.routing,
		smart_routing: expectedSmartRouting,
	};
	const saved = await readProofState(page);
	expect(writeRequests(saved)).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-embedding-fields-saved"),
	});

	await page.reload();
	await expect(
		page.getByRole("switch", { name: "Enable smart routing" })
	).toBeChecked();
	await expect(page.getByLabel("Embedding model")).toHaveValue(
		"nomic-embed-large"
	);
	await expect(
		page.getByPlaceholder("When the request is about… (plain language)")
	).toHaveValue("research requests");
	await expect(
		page.getByRole("button", { name: "Route to model for rule 1" })
	).toContainText("anthropic/claude-haiku-4-5");
	await expect(
		page.getByRole("button", { name: "Default model when no rule matches" })
	).toContainText("gpt-4.1-mini");
});

test("keyword strategy saves exact routing config and reads back its applicable controls", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const before = await readProofState(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);
	await page.getByRole("switch", { name: "Enable smart routing" }).click();
	await chooseSelect(page, "Strategy", /^Match on words/u);

	await expect(page.getByLabel("Embedding model")).toHaveCount(0);
	await expect(
		page.getByRole("slider", { name: "Similarity threshold" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Classifier model" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Default model when no rule matches" })
	).toBeVisible();
	await page
		.getByPlaceholder("When the request is about… (plain language)")
		.fill("  account recovery  ");

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	const expectedSmartRouting: SmartRoutingConfig = {
		...initialSmartRouting,
		enabled: true,
		strategy: "keyword",
		rules: [
			{
				description: "account recovery",
				model: "claude-sonnet-4-5",
				weight: 1,
			},
		],
	};
	const expectedRouting: GatewayRoutingConfig = {
		...before.config.routing,
		smart_routing: expectedSmartRouting,
	};
	expect(writeRequests(await readProofState(page))).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-keyword-saved"),
	});

	await page.reload();
	await expect(page.getByRole("combobox", { name: "Strategy" })).toContainText(
		"Match on words"
	);
	await expect(
		page.getByPlaceholder("When the request is about… (plain language)")
	).toHaveValue("account recovery");
	await expect(
		page.getByRole("button", { name: "Route to model for rule 1" })
	).toContainText("claude-sonnet-4-5");
	await expect(
		page.getByRole("button", { name: "Default model when no rule matches" })
	).toBeVisible();
});

test("passthrough routing saves the full config and reads back without target controls", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const before = await readProofState(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);
	await page.getByRole("switch", { name: "Enable smart routing" }).click();
	await chooseSelect(page, "Router type", /^Passthrough/u);
	await expect(page.getByRole("combobox", { name: "Strategy" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Classifier model" })
	).toHaveCount(0);
	await expect(page.getByLabel("Embedding model")).toHaveCount(0);
	await expect(
		page.getByRole("slider", { name: "Similarity threshold" })
	).toHaveCount(0);
	await expect(page.getByLabel("Seed (optional)")).toHaveCount(0);
	for (const name of ["Stage capable model", "Stage efficient model"]) {
		await expect(page.getByRole("button", { name })).toHaveCount(0);
	}
	await expect(
		page.getByRole("combobox", { name: "Ambiguous-turn default" })
	).toHaveCount(0);
	await expect(
		page.getByRole("slider", { name: "Signal confidence threshold" })
	).toHaveCount(0);
	for (const name of [
		"Escalation weak model",
		"Escalation strong model",
		"Escalation judge model",
	]) {
		await expect(page.getByRole("button", { name })).toHaveCount(0);
	}
	await expect(page.getByLabel("Confirmations before escalation")).toHaveCount(
		0
	);
	await expect(page.getByRole("button", { name: "Add rule" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Default model when no rule matches" })
	).toHaveCount(0);
	await expect(
		page.getByPlaceholder("When the request is about… (plain language)")
	).toHaveCount(0);

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	const expectedRouting: GatewayRoutingConfig = {
		...before.config.routing,
		smart_routing: {
			...initialSmartRouting,
			enabled: true,
			router_type: "passthrough",
		},
	};
	expect(writeRequests(await readProofState(page))).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-passthrough-saved"),
	});

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Router type" })
	).toContainText("Passthrough");
	await expect(page.getByRole("combobox", { name: "Strategy" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeEnabled();
});

test("an incomplete classifier rule cannot be saved until it is completed", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const before = await rejectIncompleteRule(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);
	await page
		.getByPlaceholder("When the request is about… (plain language)")
		.nth(1)
		.fill("account recovery");
	await chooseCustomModel(
		page,
		"Route to model for rule 2",
		"  openai/gpt-4o-mini  "
	);

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	const expectedSmartRouting: SmartRoutingConfig = {
		...initialSmartRouting,
		rules: [
			...initialSmartRouting.rules,
			{
				description: "account recovery",
				model: "openai/gpt-4o-mini",
				weight: 1,
			},
		],
	};
	const expectedRouting: GatewayRoutingConfig = {
		...before.config.routing,
		smart_routing: expectedSmartRouting,
	};
	expect(writeRequests(await readProofState(page))).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-incomplete-rule-completed"),
	});

	await page.reload();
	await expect(
		page.getByPlaceholder("When the request is about… (plain language)").nth(1)
	).toHaveValue("account recovery");
	await expect(
		page.getByRole("button", { name: "Route to model for rule 2" })
	).toContainText("openai/gpt-4o-mini");
});

test("an incomplete classifier rule can be removed before saving the remaining config", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const before = await rejectIncompleteRule(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);
	await page.getByRole("button", { name: "Remove rule 2" }).click();
	await expect(page.getByRole("button", { name: "Remove rule 2" })).toHaveCount(
		0
	);
	await expect(page.getByRole("alert")).toHaveCount(0);

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	const expectedRouting: GatewayRoutingConfig = {
		...before.config.routing,
		smart_routing: initialSmartRouting,
	};
	expect(writeRequests(await readProofState(page))).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.reload();
	await expect(
		page.getByPlaceholder("When the request is about… (plain language)")
	).toHaveCount(1);
});

test("the local classifier Use it action saves and reads back the exact local model", async ({
	page,
}) => {
	await page.goto(
		"/gateway-smart-routing-settings-proof.html?classifyTier=idle"
	);
	const before = await readProofState(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);
	await page.getByRole("switch", { name: "Enable smart routing" }).click();
	await chooseSelect(page, "Strategy", /^Let a model decide/u);
	await expect(page.getByText("Local classifier ready")).toBeVisible();
	const useClassifier = page.getByRole("button", {
		name: "Use it",
		exact: true,
	});
	await expect(useClassifier).toBeVisible();
	await useClassifier.click();
	const classifier = page.getByRole("button", {
		name: "Classifier model",
		exact: true,
	});
	await expect(classifier).toContainText(CLASSIFY_MODEL_ID);
	await expect(useClassifier).toHaveCount(0);

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	const expectedSmartRouting: SmartRoutingConfig = {
		...initialSmartRouting,
		enabled: true,
		strategy: "llm",
		classifier_model: CLASSIFY_MODEL_ID,
	};
	const expectedRouting: GatewayRoutingConfig = {
		...before.config.routing,
		smart_routing: expectedSmartRouting,
	};
	expect(writeRequests(await readProofState(page))).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-classifier-use-local"),
	});

	await page.reload();
	await expect(page.getByRole("combobox", { name: "Strategy" })).toContainText(
		"Let a model decide"
	);
	await expect(
		page.getByRole("button", { name: "Classifier model", exact: true })
	).toContainText(CLASSIFY_MODEL_ID);
	await expect(page.getByRole("button", { name: "Use it" })).toHaveCount(0);
});

test("the local classifier shortcut is disabled without gateway.configure", async ({
	page,
}) => {
	await page.goto(
		"/gateway-smart-routing-settings-proof.html?canConfigure=false&classifyTier=idle&withLocalClassifier=true"
	);
	await expect(page.getByText("Local classifier ready")).toBeVisible();
	const useClassifier = page.getByRole("button", {
		name: "Use it",
		exact: true,
	});
	await expect(useClassifier).toBeVisible();
	await expect(useClassifier).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Enable smart routing" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	const proof = await readProofState(page);
	expect(proof.config.routing.smart_routing).toMatchObject({
		enabled: true,
		strategy: "llm",
		classifier_model: "",
	});
	expect(writeRequests(proof)).toEqual([]);
});

test("weighted random requires two positive-weight targets and persists add/remove retries", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const before = await readProofState(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);
	await page.getByRole("switch", { name: "Enable smart routing" }).click();
	await chooseSelect(page, "Router type", /^Weighted random/u);

	const seed = page.getByLabel("Seed (optional)");
	await seed.fill("-4");
	await expect(seed).toHaveValue("");
	await seed.fill("42");
	await page
		.getByPlaceholder("Optional target label")
		.fill("  primary target  ");
	await chooseCustomModel(
		page,
		"Route to model for rule 1",
		"  openai/gpt-4.1-mini  "
	);
	const firstWeight = page.getByPlaceholder("Relative weight (default 1)");
	await firstWeight.fill("0");
	const zeroWeightSnapshot = await readProofState(page);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Random targets need a model and positive weight."
	);
	const zeroWeightAttempt = await readProofState(page);
	expect(configRequests(zeroWeightAttempt)).toEqual(
		configRequests(zeroWeightSnapshot)
	);
	expect(writeRequests(zeroWeightAttempt)).toEqual([]);
	expect(zeroWeightAttempt.config.routing).toEqual(before.config.routing);

	await firstWeight.fill("2.5");

	const oneTargetSnapshot = await readProofState(page);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Weighted random needs at least two targets with positive weights."
	);
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-random-insufficient-targets"),
	});
	const oneTargetAttempt = await readProofState(page);
	expect(configRequests(oneTargetAttempt)).toEqual(
		configRequests(oneTargetSnapshot)
	);
	expect(writeRequests(oneTargetAttempt)).toEqual([]);
	expect(oneTargetAttempt.config.routing).toEqual(before.config.routing);

	await page.getByRole("button", { name: "Add rule", exact: true }).click();
	const removeRuleTwo = page.getByRole("button", { name: "Remove rule 2" });
	await expect(removeRuleTwo).toBeVisible();
	await page
		.getByPlaceholder("Optional target label")
		.nth(1)
		.fill("  backup target  ");
	await chooseCustomModel(
		page,
		"Route to model for rule 2",
		"  anthropic/claude-haiku-4-5  "
	);
	await page.getByPlaceholder("Relative weight (default 1)").nth(1).fill("1.5");

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	const expectedSmartRouting: SmartRoutingConfig = {
		...initialSmartRouting,
		enabled: true,
		router_type: "random",
		random_seed: 42,
		rules: [
			{
				description: "primary target",
				model: "openai/gpt-4.1-mini",
				weight: 2.5,
			},
			{
				description: "backup target",
				model: "anthropic/claude-haiku-4-5",
				weight: 1.5,
			},
		],
	};
	const expectedRouting: GatewayRoutingConfig = {
		...before.config.routing,
		smart_routing: expectedSmartRouting,
	};
	const saved = await readProofState(page);
	expect(writeRequests(saved)).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-random-rules-saved"),
	});

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Router type" })
	).toContainText("Weighted random");
	await expect(page.getByLabel("Seed (optional)")).toHaveValue("42");
	await expect(
		page.getByPlaceholder("Optional target label").nth(0)
	).toHaveValue("primary target");
	await expect(
		page.getByRole("button", { name: "Route to model for rule 1" })
	).toContainText("openai/gpt-4.1-mini");
	await expect(
		page.getByPlaceholder("Relative weight (default 1)").nth(0)
	).toHaveValue("2.5");
	await expect(
		page.getByRole("button", { name: "Route to model for rule 2" })
	).toContainText("anthropic/claude-haiku-4-5");
	await expect(
		page.getByPlaceholder("Optional target label").nth(1)
	).toHaveValue("backup target");
	await expect(
		page.getByPlaceholder("Relative weight (default 1)").nth(1)
	).toHaveValue("1.5");

	await page.getByRole("button", { name: "Remove rule 2" }).click();
	const oneRemainingTarget = await readProofState(page);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Weighted random needs at least two targets with positive weights."
	);
	const removeAttempt = await readProofState(page);
	expect(configRequests(removeAttempt)).toEqual(
		configRequests(oneRemainingTarget)
	);
	expect(writeRequests(removeAttempt)).toEqual([]);
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toHaveCount(0);

	await page.getByRole("button", { name: "Add rule", exact: true }).click();
	await page
		.getByPlaceholder("Optional target label")
		.nth(1)
		.fill("backup target");
	await chooseCustomModel(
		page,
		"Route to model for rule 2",
		"anthropic/claude-haiku-4-5"
	);
	await page.getByPlaceholder("Relative weight (default 1)").nth(1).fill("1.5");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	const retried = await readProofState(page);
	const writes = writeRequests(retried);
	expect(writes).toEqual([
		{
			body: { routing: expectedRouting },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-random-rules-retried"),
	});
	await page.reload();
	await expect(page.getByLabel("Seed (optional)")).toHaveValue("42");
	await expect(
		page.getByRole("button", { name: "Route to model for rule 2" })
	).toContainText("anthropic/claude-haiku-4-5");
});

test("stage routing saves both model targets, picker order, and confidence threshold", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const before = await readProofState(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);
	await page.getByRole("switch", { name: "Enable smart routing" }).click();
	await chooseSelect(page, "Router type", /^Stage router/u);
	await chooseCustomModel(
		page,
		"Stage capable model",
		"  anthropic/claude-sonnet-4-5  "
	);
	await chooseCustomModel(
		page,
		"Stage efficient model",
		"  openai/gpt-4.1-mini  "
	);
	await chooseSelect(page, "Ambiguous-turn default", /^Efficient first$/u);
	const threshold = page.getByRole("slider", {
		name: "Signal confidence threshold",
	});
	await threshold.press("ArrowRight");
	await expect(threshold).toHaveAttribute("aria-valuenow", "0.55");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();

	const expectedSmartRouting: SmartRoutingConfig = {
		...initialSmartRouting,
		enabled: true,
		router_type: "stage_router",
		stage_capable_model: "anthropic/claude-sonnet-4-5",
		stage_efficient_model: "openai/gpt-4.1-mini",
		stage_picker: "efficient_first",
		stage_confidence_threshold: 0.55,
	};
	const saved = await readProofState(page);
	expect(writeRequests(saved)).toEqual([
		{
			body: {
				routing: {
					...before.config.routing,
					smart_routing: expectedSmartRouting,
				},
			},
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-stage-settings-saved"),
	});

	await page.reload();
	await expect(
		page.getByRole("button", { name: "Stage capable model" })
	).toContainText("anthropic/claude-sonnet-4-5");
	await expect(
		page.getByRole("button", { name: "Stage efficient model" })
	).toContainText("openai/gpt-4.1-mini");
	await expect(
		page.getByRole("combobox", { name: "Ambiguous-turn default" })
	).toContainText("Efficient first");
	await expect(
		page.getByRole("slider", { name: "Signal confidence threshold" })
	).toHaveAttribute("aria-valuenow", "0.55");
});

test("escalation model controls preserve the draft and reflect the validated saved confirmation count", async ({
	page,
}) => {
	await page.goto("/gateway-smart-routing-settings-proof.html");
	const before = await readProofState(page);
	const initialSmartRouting = requireSmartRouting(before.config.routing);
	await page.getByRole("switch", { name: "Enable smart routing" }).click();
	await chooseSelect(page, "Router type", /^Escalation/u);
	await chooseCustomModel(
		page,
		"Escalation weak model",
		"  openai/gpt-4.1-mini  "
	);
	await chooseCustomModel(
		page,
		"Escalation strong model",
		"  anthropic/claude-sonnet-4-5  "
	);
	await chooseCustomModel(
		page,
		"Escalation judge model",
		"  openai/gpt-4o-mini  "
	);
	const confirmations = page.getByLabel("Confirmations before escalation");
	await expect(confirmations).toHaveAttribute("min", "1");
	await confirmations.fill("0");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved. New requests use the updated router.")
	).toBeVisible();
	await expect(confirmations).toHaveValue("2");

	const expectedSmartRouting: SmartRoutingConfig = {
		...initialSmartRouting,
		enabled: true,
		router_type: "escalation",
		escalation_weak_model: "openai/gpt-4.1-mini",
		escalation_strong_model: "anthropic/claude-sonnet-4-5",
		escalation_judge_model: "openai/gpt-4o-mini",
		escalation_confirmations: 2,
	};
	const saved = await readProofState(page);
	expect(writeRequests(saved)).toEqual([
		{
			body: {
				routing: {
					...before.config.routing,
					smart_routing: expectedSmartRouting,
				},
			},
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-escalation-saved"),
	});
	await page.reload();
	await expect(page.getByLabel("Confirmations before escalation")).toHaveValue(
		"2"
	);
	for (const [fieldName, modelId] of [
		["Escalation weak model", "openai/gpt-4.1-mini"],
		["Escalation strong model", "anthropic/claude-sonnet-4-5"],
		["Escalation judge model", "openai/gpt-4o-mini"],
	]) {
		await expect(page.getByRole("button", { name: fieldName })).toContainText(
			modelId
		);
	}
});

test("read-only Gateway settings disable fields and every rule action without issuing a write", async ({
	page,
}) => {
	await page.goto(
		"/gateway-smart-routing-settings-proof.html?canConfigure=false"
	);
	const before = await readProofState(page);
	await expect(
		page.getByRole("switch", { name: "Enable smart routing" })
	).toBeDisabled();
	await expect(
		page.getByRole("combobox", { name: "Router type" })
	).toBeDisabled();
	await expect(page.getByRole("combobox", { name: "Strategy" })).toBeDisabled();
	await expect(page.getByLabel("Embedding model")).toBeDisabled();
	await expect(
		page.getByRole("slider", { name: "Similarity threshold" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Route to model for rule 1" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Add rule", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove rule 1" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();

	const after = await readProofState(page);
	expect(writeRequests(after)).toEqual([]);
	expect(after.config.routing).toEqual(before.config.routing);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-smart-routing-read-only"),
	});
});
