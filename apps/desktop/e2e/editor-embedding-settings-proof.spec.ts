import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";

interface ReindexStatusWire {
	current_dims: number;
	current_model: string;
	pending_chunks: number;
	running: boolean;
	total_chunks: number;
}

interface CapturedRequest {
	body: unknown;
	headers: {
		authorization: string | null;
		userJwt: string | null;
	};
	method: string;
	path: string;
	status: number;
}

interface EditorEmbeddingSnapshot {
	editorAi: {
		agentId?: string;
		apiKey?: string;
		baseUrl: string | null;
		enabled: boolean;
		model: string;
	};
	embeddingModel: { base_url: string; dims: number; model_id: string };
	preferences: Record<string, string>;
	reindexStatus: ReindexStatusWire;
	requests: CapturedRequest[];
}

interface EditorEmbeddingWindow extends Window {
	__editorEmbeddingSettingsProof: {
		armFailure: (method: string, path: string, status?: number) => void;
		queueStatusReads: (statuses: ReindexStatusWire[]) => void;
		snapshot: () => EditorEmbeddingSnapshot;
	};
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const EVIDENCE_DIR =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);
const NODE_TOKEN = "editor-embedding-proof-node-token";
const USER_JWT = "editor-embedding-proof-user-jwt";
const NODE_GATEWAY_BASE = "http://127.0.0.1:7974/v1";
const INITIAL_EMBEDDING_MODEL = {
	base_url: "http://127.0.0.1:8081",
	dims: 768,
	model_id: "nomic-embed-text-v1.5",
};

test.describe.configure({ timeout: 120_000 });

async function readSnapshot(page: Page): Promise<EditorEmbeddingSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: editor-embedding-settings-proof.tsx installs __editorEmbeddingSettingsProof before this proof page is evaluated. */ (
			window as EditorEmbeddingWindow
		).__editorEmbeddingSettingsProof.snapshot()
	);
}

async function armFailure(
	page: Page,
	method: string,
	path: string,
	status = 503
): Promise<void> {
	await page.evaluate(
		({ requestMethod, requestPath, responseStatus }) =>
			/* SAFETY: editor-embedding-settings-proof.tsx installs __editorEmbeddingSettingsProof before this proof page is evaluated. */ (
				window as EditorEmbeddingWindow
			).__editorEmbeddingSettingsProof.armFailure(
				requestMethod,
				requestPath,
				responseStatus
			),
		{ requestMethod: method, requestPath: path, responseStatus: status }
	);
}

async function queueStatusReads(
	page: Page,
	statuses: ReindexStatusWire[]
): Promise<void> {
	await page.evaluate(
		(nextStatuses) =>
			/* SAFETY: editor-embedding-settings-proof.tsx installs __editorEmbeddingSettingsProof before this proof page is evaluated. */ (
				window as EditorEmbeddingWindow
			).__editorEmbeddingSettingsProof.queueStatusReads(nextStatuses),
		statuses
	);
}

async function openSettings(
	page: Page,
	query = "?reset=true"
): Promise<{ embedding: Locator; inlineAi: Locator }> {
	await page.goto(`/editor-embedding-settings-proof.html${query}`);
	const inlineAi = page.getByRole("region", { name: "Inline AI editing" });
	const embedding = page.getByRole("region", {
		name: "Default embedding model",
	});
	await expect(inlineAi).toBeVisible();
	await expect(embedding).toBeVisible();
	return { embedding, inlineAi };
}

function requestsFor(
	snapshot: EditorEmbeddingSnapshot,
	path: string,
	method?: string
): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path === path &&
			(method === undefined || request.method === method)
	);
}

function expectNodeCredentials(requests: CapturedRequest[]): void {
	expect(requests.length).toBeGreaterThan(0);
	for (const request of requests) {
		expect(request.headers.authorization).toBe(`Bearer ${NODE_TOKEN}`);
		expect(request.headers.userJwt).toBe(USER_JWT);
	}
}

async function saveScreenshot(page: Page, name: string): Promise<void> {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, name),
	});
}

test("initial Core read errors are visible and Retry recovers both settings cards", async ({
	page,
}) => {
	const { embedding, inlineAi } = await openSettings(
		page,
		"?reset=true&failInitialReads=true"
	);

	await expect(inlineAi.getByRole("alert")).toHaveText(
		"Couldn't load editor AI settings."
	);
	await expect(embedding.getByRole("alert")).toContainText(
		"Couldn't load embedding model or reindex status."
	);

	await inlineAi.getByRole("button", { name: "Retry", exact: true }).click();
	await embedding.getByRole("button", { name: "Retry", exact: true }).click();

	await expect(
		inlineAi.getByRole("switch", { name: "Enable editor AI" })
	).toBeVisible();
	await expect(embedding.getByLabel("Model id")).toHaveValue(
		INITIAL_EMBEDDING_MODEL.model_id
	);
	await expect(
		embedding.getByText("All embeddings up to date", { exact: true })
	).toBeVisible();
	await saveScreenshot(page, "desktop-editor-embedding-load-retry.png");

	const snapshot = await readSnapshot(page);
	expect(
		requestsFor(snapshot, "/api/preferences/editor-ai", "GET").map(
			(request) => request.status
		)
	).toEqual([503, 404]);
	expect(
		requestsFor(snapshot, "/api/embeddings/model", "GET").map(
			(request) => request.status
		)
	).toEqual([503, 200]);
	expect(
		requestsFor(snapshot, "/api/embeddings/reindex/status", "GET").map(
			(request) => request.status
		)
	).toEqual([503, 200]);
	expectNodeCredentials(
		snapshot.requests.filter((request) => request.path.startsWith("/api/"))
	);
});

test("custom editor model save failure retains the draft, retries, defaults the Gateway URL, and persists", async ({
	page,
}) => {
	const { inlineAi } = await openSettings(page);
	const enabled = inlineAi.getByRole("switch", { name: "Enable editor AI" });
	const agent = inlineAi.getByRole("combobox", { name: "Agent" });
	const model = inlineAi.getByLabel("Model");
	const baseUrl = inlineAi.getByLabel("Gateway base URL (optional)");
	const save = inlineAi.getByRole("button", { name: "Save", exact: true });

	await expect(enabled).not.toBeChecked();
	await expect(agent).toContainText("Custom model");
	await expect(baseUrl).toHaveAttribute("placeholder", NODE_GATEWAY_BASE);
	await enabled.click();
	await model.fill("  custom-chat-model  ");
	await baseUrl.fill("  https://gateway-override.example.test/v1  ");

	await armFailure(page, "PUT", "/api/preferences/editor-ai", 503);
	await save.click();
	await expect(
		page.getByText("Couldn't save editor AI settings")
	).toBeVisible();
	await expect(save).toBeEnabled();
	await expect(enabled).toBeChecked();
	await expect(model).toHaveValue("  custom-chat-model  ");
	await expect(baseUrl).toHaveValue(
		"  https://gateway-override.example.test/v1  "
	);
	let snapshot = await readSnapshot(page);
	expect(snapshot.preferences["editor-ai"]).toBeUndefined();
	expect(snapshot.editorAi).toMatchObject({
		baseUrl: null,
		enabled: false,
		model: "",
	});

	await save.click();
	await expect(page.getByText("Editor AI settings saved")).toBeVisible();
	snapshot = await readSnapshot(page);
	const savedPreference: unknown = JSON.parse(
		snapshot.preferences["editor-ai"] ?? "{}"
	);
	expect(savedPreference).toEqual({
		baseUrl: "https://gateway-override.example.test/v1",
		enabled: true,
		model: "custom-chat-model",
	});
	expect(snapshot.editorAi).toEqual({
		agentId: undefined,
		apiKey: NODE_TOKEN,
		baseUrl: "https://gateway-override.example.test/v1",
		enabled: true,
		model: "custom-chat-model",
	});

	const writes = requestsFor(snapshot, "/api/preferences/editor-ai", "PUT");
	expect(writes.map((request) => request.status)).toEqual([503, 200]);
	expect(
		writes.map((request) =>
			JSON.parse(z.object({ value: z.string() }).parse(request.body).value)
		)
	).toEqual([
		{
			baseUrl: "https://gateway-override.example.test/v1",
			enabled: true,
			model: "custom-chat-model",
		},
		{
			baseUrl: "https://gateway-override.example.test/v1",
			enabled: true,
			model: "custom-chat-model",
		},
	]);
	expectNodeCredentials(writes);

	await page.reload();
	const reloaded = page.getByRole("region", { name: "Inline AI editing" });
	await expect(
		reloaded.getByRole("switch", { name: "Enable editor AI" })
	).toBeChecked();
	await expect(reloaded.getByLabel("Model")).toHaveValue("custom-chat-model");
	await expect(reloaded.getByLabel("Gateway base URL (optional)")).toHaveValue(
		"https://gateway-override.example.test/v1"
	);
	await saveScreenshot(page, "desktop-editor-ai-custom-persisted.png");
});

test("agent-backed routing uses the agent model, preserves the custom draft, and uses the active node Gateway by default", async ({
	page,
}) => {
	const { inlineAi } = await openSettings(page);
	const enabled = inlineAi.getByRole("switch", { name: "Enable editor AI" });
	const agent = inlineAi.getByRole("combobox", { name: "Agent" });
	const model = inlineAi.getByLabel("Model");
	const baseUrl = inlineAi.getByLabel("Gateway base URL (optional)");
	await model.fill("manual-custom-model");

	await agent.click();
	await page.getByRole("option", { name: "Writer Agent", exact: true }).click();
	await expect(inlineAi.getByLabel("Model")).toHaveCount(0);
	await expect(inlineAi.getByText(/Uses Writer Agent's model:/)).toBeVisible();
	await agent.click();
	await page.getByRole("option", { name: "Custom model", exact: true }).click();
	await expect(model).toHaveValue("manual-custom-model");
	await agent.click();
	await page.getByRole("option", { name: "Writer Agent", exact: true }).click();
	await enabled.click();
	await expect(baseUrl).toHaveValue("");
	await expect(baseUrl).toHaveAttribute("placeholder", NODE_GATEWAY_BASE);
	await inlineAi.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Editor AI settings saved")).toBeVisible();

	let snapshot = await readSnapshot(page);
	let savedPreference: unknown = JSON.parse(
		snapshot.preferences["editor-ai"] ?? "{}"
	);
	expect(savedPreference).toEqual({
		baseUrl: "",
		enabled: true,
		model: "writer-model-v3",
		agentId: "agent-writer",
	});
	expect(snapshot.editorAi).toMatchObject({
		agentId: "agent-writer",
		apiKey: NODE_TOKEN,
		baseUrl: NODE_GATEWAY_BASE,
		enabled: true,
		model: "writer-model-v3",
	});
	await saveScreenshot(page, "desktop-editor-ai-agent-backed.png");

	await agent.click();
	await page
		.getByRole("option", { name: "No Model Agent", exact: true })
		.click();
	await expect(
		inlineAi.getByText(/has no model set yet/, { exact: false })
	).toBeVisible();
	await inlineAi.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Saved, but inline AI isn't active yet")
	).toBeVisible();
	snapshot = await readSnapshot(page);
	savedPreference = JSON.parse(snapshot.preferences["editor-ai"] ?? "{}");
	expect(savedPreference).toEqual({
		baseUrl: "",
		enabled: true,
		model: "",
		agentId: "agent-no-model",
	});
	expect(snapshot.editorAi).toMatchObject({
		agentId: "agent-no-model",
		baseUrl: NODE_GATEWAY_BASE,
		enabled: false,
		model: "",
	});
	expectNodeCredentials(
		requestsFor(snapshot, "/api/preferences/editor-ai", "PUT")
	);
});

test("embedding dimensions reject invalid values and Change & reindex retries with exact model settings", async ({
	page,
}) => {
	const { embedding } = await openSettings(page);
	const model = embedding.getByLabel("Model id");
	const baseUrl = embedding.getByLabel("Base URL (optional)");
	const dims = embedding.getByLabel("Dimensions (optional)");
	const change = embedding.getByRole("button", {
		name: "Change & reindex",
		exact: true,
	});

	await expect(model).toHaveValue(INITIAL_EMBEDDING_MODEL.model_id);
	// Core's GET /api/embeddings/model publishes only model_id and dims, so the
	// Base URL field loads empty instead of failing the whole model read.
	await expect(baseUrl).toHaveValue("");
	await expect(embedding.getByText(/Couldn't load/)).toHaveCount(0);
	await expect(dims).toHaveValue("768");
	await expect(
		embedding.getByText("All embeddings up to date", { exact: true })
	).toBeVisible();
	await model.fill("  text-embedding-3-small  ");
	await baseUrl.fill("  http://127.0.0.1:8081/v1  ");
	for (const invalidDimensions of ["0", "1.5", "not-a-number"]) {
		await dims.fill(invalidDimensions);
		await change.click();
		await expect(embedding.getByRole("alert")).toHaveText(
			"Dimensions must be a positive whole number"
		);
		const validationSnapshot = await readSnapshot(page);
		expect(
			requestsFor(validationSnapshot, "/api/embeddings/model", "POST")
		).toEqual([]);
	}

	await dims.fill("512");
	await armFailure(page, "POST", "/api/embeddings/model", 503);
	await change.click();
	await expect(
		page.getByText(/\/api\/embeddings\/model failed: 503/)
	).toBeVisible();
	await expect(change).toBeEnabled();
	await expect(model).toHaveValue("  text-embedding-3-small  ");
	await expect(baseUrl).toHaveValue("  http://127.0.0.1:8081/v1  ");
	await expect(dims).toHaveValue("512");
	let snapshot = await readSnapshot(page);
	expect(snapshot.embeddingModel).toEqual(INITIAL_EMBEDDING_MODEL);

	await queueStatusReads(page, [
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 8,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 512,
			current_model: "text-embedding-3-small",
			pending_chunks: 0,
			running: false,
			total_chunks: 8,
		},
	]);
	await change.click();
	await expect(page.getByText("Reindexing…", { exact: true })).toBeVisible();
	const stale = embedding.getByRole("button", { name: /Reindex stale/ });
	await expect(stale).toBeDisabled();
	await expect(embedding.getByText("63%", { exact: true })).toBeVisible({
		timeout: 5000,
	});
	await Promise.all([
		expect(
			page.getByText("Dimensions must be a positive whole number")
		).toBeHidden({ timeout: 8000 }),
		expect(page.getByText(/\/api\/embeddings\/model failed: 503/)).toBeHidden({
			timeout: 8000,
		}),
		expect(
			page.getByText("Embedding model changed; reindexing in the background")
		).toBeHidden({ timeout: 8000 }),
	]);
	await expect(page.getByText("Reindexing…", { exact: true })).toBeVisible();
	await expect(embedding.getByText("63%", { exact: true })).toBeVisible();
	await saveScreenshot(page, "desktop-editor-embedding-reindex-running.png");
	await expect(
		embedding.getByText("All embeddings up to date", { exact: true })
	).toBeVisible({ timeout: 10_000 });
	await expect(stale).toBeDisabled();
	await saveScreenshot(page, "desktop-editor-embedding-reindex-complete.png");

	snapshot = await readSnapshot(page);
	const modelWrites = requestsFor(snapshot, "/api/embeddings/model", "POST");
	expect(modelWrites.map((request) => request.status)).toEqual([503, 200]);
	expect(modelWrites.map((request) => request.body)).toEqual([
		{
			model_id: "text-embedding-3-small",
			base_url: "http://127.0.0.1:8081/v1",
			dims: 512,
		},
		{
			model_id: "text-embedding-3-small",
			base_url: "http://127.0.0.1:8081/v1",
			dims: 512,
		},
	]);
	expect(requestsFor(snapshot, "/api/embeddings/reindex", "POST")).toEqual([]);
	expect(snapshot.embeddingModel).toEqual({
		base_url: "http://127.0.0.1:8081/v1",
		dims: 512,
		model_id: "text-embedding-3-small",
	});
	expectNodeCredentials(
		snapshot.requests.filter((request) =>
			request.path.startsWith("/api/embeddings/")
		)
	);

	await page.reload();
	const reloaded = page.getByRole("region", {
		name: "Default embedding model",
	});
	await expect(reloaded.getByLabel("Model id")).toHaveValue(
		"text-embedding-3-small"
	);
	await expect(reloaded.getByLabel("Dimensions (optional)")).toHaveValue("512");
	await expect(
		reloaded.getByText("All embeddings up to date", { exact: true })
	).toBeVisible();
});

test("Reindex stale failures stay retryable and a manual reindex polls through completion", async ({
	page,
}) => {
	const { embedding } = await openSettings(
		page,
		"?reset=true&staleInitial=true"
	);
	const reindex = embedding.getByRole("button", { name: /Reindex stale/ });
	await expect(
		embedding.getByText("3 of 8 chunks stale", { exact: true })
	).toBeVisible();
	await expect(reindex).toBeEnabled();

	await armFailure(page, "POST", "/api/embeddings/reindex", 503);
	await reindex.click();
	await expect(page.getByText("Couldn't start reindex")).toBeVisible();
	await expect(reindex).toBeEnabled();

	await queueStatusReads(page, [
		{
			current_dims: 768,
			current_model: "nomic-embed-text-v1.5",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 768,
			current_model: "nomic-embed-text-v1.5",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 768,
			current_model: "nomic-embed-text-v1.5",
			pending_chunks: 3,
			running: true,
			total_chunks: 8,
		},
		{
			current_dims: 768,
			current_model: "nomic-embed-text-v1.5",
			pending_chunks: 0,
			running: false,
			total_chunks: 8,
		},
	]);
	await reindex.click();
	await expect(
		embedding.getByText("Reindexing…", { exact: true })
	).toBeVisible();
	await expect(reindex).toBeDisabled();
	await expect(page.getByText("Couldn't start reindex")).toBeHidden({
		timeout: 8000,
	});
	await expect(
		embedding.getByText("All embeddings up to date", { exact: true })
	).toBeVisible({ timeout: 5000 });
	await saveScreenshot(
		page,
		"desktop-editor-embedding-stale-reindex-complete.png"
	);

	const snapshot = await readSnapshot(page);
	const reindexWrites = requestsFor(
		snapshot,
		"/api/embeddings/reindex",
		"POST"
	);
	expect(reindexWrites.map((request) => request.status)).toEqual([503, 200]);
	expect(reindexWrites.map((request) => request.body)).toEqual([null, null]);
	expect(requestsFor(snapshot, "/api/embeddings/model", "POST")).toEqual([]);
	expectNodeCredentials(
		snapshot.requests.filter((request) =>
			request.path.startsWith("/api/embeddings/")
		)
	);
});
