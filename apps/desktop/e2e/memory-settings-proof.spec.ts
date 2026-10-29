import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { preferenceValueProofSchema } from "./settings-domain-proof.contracts.ts";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number | null;
}

interface MemoryFixtureRow {
	content: string;
	id: string;
	sensitive_topics: string[];
}

interface MemoryProofSnapshot {
	includeSensitiveTopics: boolean;
	longTermEnabled: string | null;
	memories: MemoryFixtureRow[];
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	tauriCalls: Array<{ args: unknown; command: string }>;
}

interface MemoryProofWindow extends Window {
	__memorySettingsProof: {
		armFailure: (method: string, path: string, status?: number) => void;
		snapshot: () => MemoryProofSnapshot;
	};
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidence = (name: string) =>
	process.env.RYU_PROOF_EVIDENCE_DIR
		? path.join(process.env.RYU_PROOF_EVIDENCE_DIR, name)
		: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence",
				name
			);

async function readSnapshot(page: Page): Promise<MemoryProofSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: memory-settings-proof.tsx installs __memorySettingsProof before this proof page is evaluated. */ (
			window as MemoryProofWindow
		).__memorySettingsProof.snapshot()
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
			/* SAFETY: memory-settings-proof.tsx installs __memorySettingsProof before this proof page is evaluated. */ (
				window as MemoryProofWindow
			).__memorySettingsProof.armFailure(
				requestMethod,
				requestPath,
				responseStatus
			),
		{ requestMethod: method, requestPath: path, responseStatus: status }
	);
}

async function openMemory(
	page: Page,
	url = "/memory-settings-proof.html?reset=true"
): Promise<Locator> {
	await page.goto(url);
	await page.getByRole("button", { name: "Open Gateway settings" }).click();
	const dialog = page.getByRole("dialog").first();
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Memory", exact: true }).click();
	await expect(
		dialog.getByRole("heading", { name: "Long-term memory" })
	).toBeVisible();
	return dialog;
}

async function chooseOption(
	page: Page,
	dialog: Locator,
	label: string,
	option: RegExp | string
): Promise<void> {
	await dialog.getByRole("combobox", { name: label }).click();
	await page.getByRole("option", { name: option }).click();
}

async function chooseCustomModel(
	page: Page,
	dialog: Locator,
	model: string
): Promise<void> {
	await dialog.getByRole("button", { name: "Model", exact: true }).click();
	const picker = page.getByRole("dialog").last();
	await picker.getByLabel("Custom model id").fill(model);
	await picker.getByRole("button", { name: "Use this model" }).click();
	await expect(
		dialog.getByRole("button", { name: "Model", exact: true })
	).toContainText(model);
}

function preferenceWrites(snapshot: MemoryProofSnapshot, key: string) {
	return snapshot.requests.filter(
		(request) =>
			request.path === `/api/preferences/${key}` && request.method === "PUT"
	);
}

test.describe.configure({ timeout: 120_000 });

test("opens Memory through the real Gateway plugin tab and gates sensitive search on consent", async ({
	page,
}) => {
	const dialog = await openMemory(page);
	const longTermMemory = dialog.getByRole("switch", {
		name: "Remember facts across conversations",
	});
	const sensitiveMemory = dialog.getByRole("switch", {
		name: "Include sensitive topics in memory",
	});
	await expect(longTermMemory).not.toBeChecked();
	await expect(sensitiveMemory).not.toBeChecked();
	await longTermMemory.click();
	await expect(longTermMemory).toBeChecked();

	const search = dialog.getByLabel("Search query");
	await search.fill("health condition");
	await search.press("Enter");
	await expect(
		dialog.getByText("No matches found", { exact: true })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Clear search" }).click();
	await expect(search).toHaveValue("");
	await expect(
		dialog.getByText("No matches found", { exact: true })
	).toHaveCount(0);

	await armFailure(page, "PUT", "/api/memory/settings", 403);
	await sensitiveMemory.click();
	await expect(
		page.getByText("Couldn't save sensitive-memory consent")
	).toBeVisible();
	await expect(sensitiveMemory).not.toBeChecked();
	await sensitiveMemory.click();
	await expect(sensitiveMemory).toBeChecked();
	await search.fill("health condition");
	await search.press("Enter");
	await expect(
		dialog.getByText(
			"Sensitive fixture: a health condition requires accommodation.",
			{
				exact: true,
			}
		)
	).toBeVisible();

	const snapshot = await readSnapshot(page);
	expect(snapshot.longTermEnabled).toBe("true");
	expect(snapshot.includeSensitiveTopics).toBe(true);
	expect(
		snapshot.requests
			.filter(
				(request) =>
					request.path === "/api/memory/settings" && request.method === "PUT"
			)
			.map((request) => ({ body: request.body, status: request.status }))
	).toEqual([
		{ body: { include_sensitive_topics: true }, status: 403 },
		{ body: { include_sensitive_topics: true }, status: 200 },
	]);
	expect(
		snapshot.requests
			.filter(
				(request) =>
					request.path === "/api/retrieval/search" && request.method === "POST"
			)
			.map((request) => request.body)
	).toEqual([
		{ query: "health condition", include_memory: true },
		{ query: "health condition", include_memory: true },
	]);
	await page.reload();
	const reloaded = await openMemory(page, "/memory-settings-proof.html");
	await expect(
		reloaded.getByRole("switch", {
			name: "Remember facts across conversations",
		})
	).toBeChecked();
	await expect(
		reloaded.getByRole("switch", { name: "Include sensitive topics in memory" })
	).toBeChecked();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-memory-sensitive-consent.png"),
	});
});

test("configures context budget, reply reserve, auto-compact model and ranker with failure recovery", async ({
	page,
}) => {
	let dialog = await openMemory(page);
	const budget = dialog.getByRole("combobox", { name: "Context budget" });
	const reserve = dialog.getByLabel("Reserved for the reply (tokens)");
	const autoCompact = dialog.getByRole("switch", {
		name: "Summarize older turns instead of dropping them",
	});
	await expect(budget).toContainText("Off — send the whole conversation");
	await expect(reserve).toBeDisabled();
	await expect(autoCompact).toBeDisabled();

	await armFailure(page, "PUT", "/api/preferences/context.max-tokens");
	await chooseOption(page, dialog, "Context budget", /8,192 tokens/);
	await expect(
		page.getByText("Couldn't save the context budget")
	).toBeVisible();
	await expect(budget).toContainText("Off — send the whole conversation");
	await chooseOption(page, dialog, "Context budget", /8,192 tokens/);
	await expect(reserve).toBeEnabled();
	await expect(autoCompact).toBeEnabled();
	await chooseOption(page, dialog, "Context budget", "Custom…");
	const customBudget = dialog.getByLabel("Custom budget (tokens)");
	await customBudget.fill("100");
	await customBudget.press("Tab");
	await expect(customBudget).toHaveValue("2048");
	await reserve.fill("99999");
	await reserve.press("Tab");
	await expect(reserve).toHaveValue("32768");
	await autoCompact.click();
	await chooseCustomModel(page, dialog, "summary-local-model");
	const effortPicker = dialog
		.getByText("Thinking / effort level", { exact: true })
		.locator("..")
		.getByRole("combobox");
	await effortPicker.click();
	await page.getByRole("option", { name: "high", exact: true }).click();
	await dialog
		.getByRole("heading", { name: "Conversation context" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-memory-context-settings.png"),
	});
	await chooseOption(page, dialog, "Ranking", "Meaning (embeddings)");

	let snapshot = await readSnapshot(page);
	expect(
		preferenceWrites(snapshot, "context.max-tokens").map(
			(request) => request.status
		)
	).toEqual([503, 200, 200, 200]);
	expect(
		preferenceWrites(snapshot, "context.max-tokens").map(
			(request) => preferenceValueProofSchema.parse(request.body).value
		)
	).toEqual(["8192", "8192", "8192", "2048"]);
	expect(
		preferenceWrites(snapshot, "context.max-output-tokens").at(-1)?.body
	).toEqual({ value: "32768" });
	expect(
		preferenceWrites(snapshot, "context.auto-compact").at(-1)?.body
	).toEqual({ value: "true" });
	expect(
		preferenceWrites(snapshot, "context.compact-model").at(-1)?.body
	).toEqual({ value: "summary-local-model" });
	expect(
		preferenceWrites(snapshot, "context.compact-effort").at(-1)?.body
	).toEqual({ value: "high" });
	expect(
		preferenceWrites(snapshot, "tools.active_ranker").at(-1)?.body
	).toEqual({ value: "semantic" });

	await page.reload();
	dialog = await openMemory(page, "/memory-settings-proof.html");
	await expect(dialog.getByLabel("Custom budget (tokens)")).toHaveValue("2048");
	await expect(
		dialog.getByLabel("Reserved for the reply (tokens)")
	).toHaveValue("32768");
	await expect(
		dialog.getByRole("switch", {
			name: "Summarize older turns instead of dropping them",
		})
	).toBeChecked();
	await expect(
		dialog.getByRole("button", { name: "Model", exact: true })
	).toContainText("summary-local-model");
	await expect(dialog.getByRole("combobox", { name: "Ranking" })).toContainText(
		"Meaning (embeddings)"
	);
	snapshot = await readSnapshot(page);
	expect(snapshot.preferences).toMatchObject({
		"context.max-tokens": "2048",
		"context.max-output-tokens": "32768",
		"context.auto-compact": "true",
		"context.compact-model": "summary-local-model",
		"context.compact-effort": "high",
		"tools.active_ranker": "semantic",
	});
});

test("gates auto-recall limits, clamps top-k, and persists skill disclosure", async ({
	page,
}) => {
	let dialog = await openMemory(page);
	const autoRecall = dialog.getByRole("switch", {
		name: "Automatically recall relevant context",
	});
	const topK = dialog.getByLabel("Snippets recalled per reply");
	const skills = dialog.getByRole("switch", { name: "Load skills on demand" });
	await expect(autoRecall).toBeChecked();
	await expect(topK).toHaveValue("5");
	await expect(skills).toBeChecked();

	await armFailure(page, "PUT", "/api/preferences/auto-recall-enabled");
	await autoRecall.click();
	await expect(page.getByText("Couldn't save auto-recall")).toBeVisible();
	await expect(autoRecall).toBeChecked();
	await autoRecall.click();
	await expect(autoRecall).not.toBeChecked();
	await expect(topK).toBeDisabled();
	await autoRecall.click();
	await expect(topK).toBeEnabled();
	await topK.fill("999");
	await topK.press("Tab");
	await expect(topK).toHaveValue("50");

	await armFailure(page, "PUT", "/api/preferences/skills-disclosure");
	await skills.click();
	await expect(page.getByText("Couldn't save skill loading")).toBeVisible();
	await expect(skills).toBeChecked();
	await skills.click();
	await expect(skills).not.toBeChecked();

	const snapshot = await readSnapshot(page);
	expect(
		preferenceWrites(snapshot, "auto-recall-enabled").map((request) => ({
			status: request.status,
			body: request.body,
		}))
	).toEqual([
		{ status: 503, body: { value: "false" } },
		{ status: 200, body: { value: "false" } },
		{ status: 200, body: { value: "true" } },
	]);
	expect(preferenceWrites(snapshot, "auto-recall-top-k").at(-1)?.body).toEqual({
		value: "50",
	});
	expect(
		preferenceWrites(snapshot, "skills-disclosure").map((request) => ({
			status: request.status,
			body: request.body,
		}))
	).toEqual([
		{ status: 503, body: { value: "full" } },
		{ status: 200, body: { value: "full" } },
	]);

	await page.reload();
	dialog = await openMemory(page, "/memory-settings-proof.html");
	await expect(
		dialog.getByRole("switch", {
			name: "Automatically recall relevant context",
		})
	).toBeChecked();
	await expect(dialog.getByLabel("Snippets recalled per reply")).toHaveValue(
		"50"
	);
	await expect(
		dialog.getByRole("switch", { name: "Load skills on demand" })
	).not.toBeChecked();
});

test("searches and adds fixture memory with exact Core requests, retry and reload", async ({
	page,
}) => {
	let dialog = await openMemory(page);
	const search = dialog.getByLabel("Search query");
	const searchButton = dialog.getByRole("button", {
		name: "Search",
		exact: true,
	});
	await expect(searchButton).toBeDisabled();
	await armFailure(page, "POST", "/api/retrieval/search");
	await search.fill("project");
	await search.press("Enter");
	await expect(
		dialog.getByText("Couldn't search memory. Please try again.")
	).toBeVisible();
	await expect(search).toHaveValue("project");
	await searchButton.click();
	await expect(
		dialog.getByText("Project Atlas uses concise weekly status summaries.", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		dialog.getByText("Space · Fixture docs", { exact: true })
	).toBeVisible();
	let snapshot = await readSnapshot(page);
	const searchCalls = snapshot.requests.filter(
		(request) =>
			request.method === "POST" && request.path === "/api/retrieval/search"
	);
	expect(
		searchCalls.map((request) => ({
			status: request.status,
			body: request.body,
		}))
	).toEqual([
		{ status: 503, body: { query: "project", include_memory: true } },
		{ status: 200, body: { query: "project", include_memory: true } },
	]);

	await search.fill("no-match");
	await searchButton.click();
	await expect(
		dialog.getByText("No matches found", { exact: true })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Clear search" }).click();
	await expect(search).toHaveValue("");
	await expect(
		dialog.getByText("No matches found", { exact: true })
	).toHaveCount(0);

	const addButton = dialog.getByRole("button", {
		name: "Add to memory",
		exact: true,
	});
	const memoryText = dialog.getByLabel("Text to remember");
	await expect(addButton).toBeDisabled();
	await memoryText.fill("  Remember that I prefer concise summaries.  ");
	await armFailure(page, "POST", "/api/memory");
	await addButton.click();
	await expect(
		dialog.getByText("Couldn't save that to memory. Please try again.")
	).toBeVisible();
	await expect(memoryText).toHaveValue(
		"  Remember that I prefer concise summaries.  "
	);
	await addButton.click();
	await expect(dialog.getByText("Saved to memory.")).toBeVisible();
	await expect(memoryText).toHaveValue("");
	snapshot = await readSnapshot(page);
	const createCalls = snapshot.requests.filter(
		(request) => request.method === "POST" && request.path === "/api/memory"
	);
	expect(
		createCalls.map((request) => ({
			status: request.status,
			body: request.body,
		}))
	).toEqual([
		{
			status: 503,
			body: { content: "Remember that I prefer concise summaries." },
		},
		{
			status: 201,
			body: { content: "Remember that I prefer concise summaries." },
		},
	]);
	expect(
		snapshot.memories.some(
			(memory) => memory.content === "Remember that I prefer concise summaries."
		)
	).toBe(true);

	await page.reload();
	dialog = await openMemory(page, "/memory-settings-proof.html");
	await dialog.getByLabel("Search query").fill("concise");
	await dialog.getByRole("button", { name: "Search", exact: true }).click();
	await expect(
		dialog.getByText("Remember that I prefer concise summaries.", {
			exact: true,
		})
	).toBeVisible();
	await dialog
		.getByText("Remember that I prefer concise summaries.", { exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-memory-search-add.png"),
	});
	snapshot = await readSnapshot(page);
	expect(
		snapshot.memories.some(
			(memory) => memory.content === "Remember that I prefer concise summaries."
		)
	).toBe(true);
});

declare global {
	interface Window {
		__memorySettingsProof: {
			armFailure: (method: string, path: string, status?: number) => void;
			snapshot: () => MemoryProofSnapshot;
		};
	}
}
