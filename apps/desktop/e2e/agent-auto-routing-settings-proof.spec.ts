import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { AgentAutoRoutingConfig } from "../src/lib/api/preferences.ts";
import {
	decodeAutoRoutingConfig,
	decodeAutoRoutingWrite,
} from "./agent-auto-routing-proof.contracts.ts";
import type { NodeSelectorApiCall } from "./harness/node-selector-proof.mock.ts";

const PROOF_URL = "/node-selector-proof.html";
const PREF_PATH = "/api/preferences/agent-auto-routing";
const PREF_STORAGE_KEY = "node-selector-proof-agent-auto-routing";
const CLASSIFY_MODEL_ID = "gemma-3-270m-it-qat-Q4_0";
const NODE_TOKEN = "local-node-selector-token";
const EVIDENCE_DIR = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence"
);

const DEFAULT_CONFIG: AgentAutoRoutingConfig = {
	enabled: false,
	strategy: "llm",
	classifier_model: "",
	embedding_model: "",
	similarity_threshold: 0.35,
	rules: [],
	default_agent_id: "ryu",
	cache_by_session: true,
};

function apiCallsFrom(page: Page): Promise<NodeSelectorApiCall[]> {
	return page.evaluate(() => {
		const state = window.__NODE_SELECTOR_PROOF__;
		if (!state) {
			throw new Error("Node selector proof state is missing");
		}
		return state.snapshot().apiCalls;
	});
}

async function openProof(
	page: Page,
	classifier: "ready" | "unweighted" | "absent" = "ready"
) {
	const externalRequests: string[] = [];
	const runtimeErrors: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).origin !== "http://127.0.0.1:5421") {
			externalRequests.push(request.url());
		}
	});
	page.on("pageerror", (error) =>
		runtimeErrors.push(error.stack ?? error.message)
	);
	await page.goto(
		`${PROOF_URL}?reset=true&agentAuto=true&classifier=${classifier}`
	);
	try {
		await expect(
			page.getByRole("heading", { name: "Node selector" })
		).toBeVisible();
		await expect(page.getByTestId("agent-auto-routing-composer")).toBeVisible();
	} catch (error) {
		const body = await page.locator("body").innerText();
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nBody: ${body}\nRuntime errors: ${runtimeErrors.join("\n")}`
		);
	}
	return { externalRequests, runtimeErrors };
}

async function openAutoDialog(page: Page) {
	await page.getByRole("button", { name: /Chat settings/u }).click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: "Auto", exact: true }).click();
	await expect(page.getByTestId("selected-agent")).toHaveText("auto");
	await page.getByRole("button", { name: /Chat settings.*Auto/u }).click();
	// Model management and Auto routing share the picker's one "Settings…" row.
	await page
		.getByRole("menu")
		.getByRole("menuitem", { name: "Settings…", exact: true })
		.click();
	const configure = page.getByRole("menuitem", {
		name: "Configure Auto",
		exact: true,
	});
	await expect(configure).toBeVisible();
	await configure.click();
	const dialog = page.getByRole("dialog", { name: "Auto agent routing" });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function waitForLoaded(dialog: Locator) {
	await expect(
		dialog.getByRole("switch", { name: "Enable auto routing" })
	).toBeVisible();
}

async function chooseOption(page: Page, name: RegExp | string) {
	await page
		.locator('[role="listbox"]:visible')
		.getByRole("option", { name })
		.click();
}

async function saveEvidence(page: Page, name: string) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, `${name}.png`),
	});
}

function preferenceCalls(
	calls: NodeSelectorApiCall[],
	method?: "GET" | "PUT"
): NodeSelectorApiCall[] {
	return calls.filter(
		(call) => call.path === PREF_PATH && (!method || call.method === method)
	);
}

async function savedConfig(page: Page): Promise<AgentAutoRoutingConfig | null> {
	const raw = await page.evaluate(
		(key) => localStorage.getItem(key),
		PREF_STORAGE_KEY
	);
	return raw ? decodeAutoRoutingConfig(raw) : null;
}

function parsedWrite(
	call: NodeSelectorApiCall | undefined
): AgentAutoRoutingConfig {
	if (!call) {
		throw new Error("Expected an agent-auto-routing preference write");
	}
	return decodeAutoRoutingWrite(call.body);
}

async function armApiFailure(page: Page, method: "GET" | "PUT", status = 503) {
	await page.evaluate(
		({ method, path, status }) => {
			const state = window.__NODE_SELECTOR_PROOF__;
			if (!state) {
				throw new Error("Node selector proof state is missing");
			}
			state.armApiFailure(method, path, status);
		},
		{ method, path: PREF_PATH, status }
	);
}

function expectPreferenceAuthentication(calls: NodeSelectorApiCall[]) {
	const preferences = preferenceCalls(calls);
	expect(preferences.length).toBeGreaterThan(0);
	for (const call of preferences) {
		expect(call.url).toBe("http://127.0.0.1:7980");
		expect(call.authorization).toBe(`Bearer ${NODE_TOKEN}`);
	}
}

test.describe.configure({ timeout: 60_000 });

test("opens from the real composer Configure Auto action and cancel discards an unsaved draft", async ({
	page,
}) => {
	const { externalRequests, runtimeErrors } = await openProof(page);
	const dialog = await openAutoDialog(page);
	await waitForLoaded(dialog);

	const enabled = dialog.getByRole("switch", { name: "Enable auto routing" });
	const strategy = dialog.getByRole("combobox", {
		name: "How to choose a rule",
	});
	const cache = dialog.getByRole("switch", {
		name: "Resolve once per conversation",
	});
	await expect(enabled).not.toBeChecked();
	await expect(strategy).toContainText("Let a model decide");
	await expect(
		dialog.getByText("No rules yet.", { exact: false })
	).toBeVisible();
	await expect(
		dialog.getByRole("combobox", {
			name: "Default agent when no rule matches",
		})
	).toContainText("Ryu");
	await expect(cache).toBeChecked();
	await expect(dialog.getByText(/No classifier model is picked/u)).toHaveCount(
		0
	);
	await saveEvidence(page, "desktop-agent-auto-routing-defaults");

	await enabled.click();
	await dialog.getByRole("button", { name: "Add rule", exact: true }).click();
	await dialog
		.getByPlaceholder(/When the request is about/u)
		.fill("Unsaved rule");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(preferenceCalls(await apiCallsFrom(page), "PUT")).toEqual([]);

	const reopened = await openAutoDialog(page);
	await waitForLoaded(reopened);
	await expect(
		reopened.getByRole("switch", { name: "Enable auto routing" })
	).not.toBeChecked();
	await expect(
		reopened.getByText("No rules yet.", { exact: false })
	).toBeVisible();
	await reopened.getByRole("switch", { name: "Enable auto routing" }).click();
	await reopened.getByRole("button", { name: "Add rule", exact: true }).click();
	await reopened
		.getByPlaceholder(/When the request is about/u)
		.fill("Escape should discard this draft");
	await page.keyboard.press("Escape");
	await expect(reopened).toBeHidden();
	expect(preferenceCalls(await apiCallsFrom(page), "PUT")).toEqual([]);

	const afterEscape = await openAutoDialog(page);
	await waitForLoaded(afterEscape);
	await expect(
		afterEscape.getByRole("switch", { name: "Enable auto routing" })
	).not.toBeChecked();
	await expect(
		afterEscape.getByText("No rules yet.", { exact: false })
	).toBeVisible();
	const calls = await apiCallsFrom(page);
	expect(preferenceCalls(calls, "GET")).toHaveLength(3);
	expect(await savedConfig(page)).toBeNull();
	expect(externalRequests).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expectPreferenceAuthentication(calls);
});

test("edits strategies, model IDs, rules, default agent, threshold, and resolve-once then persists after reload", async ({
	page,
}) => {
	const { externalRequests, runtimeErrors } = await openProof(page);
	let dialog = await openAutoDialog(page);
	await waitForLoaded(dialog);

	const enabled = dialog.getByRole("switch", { name: "Enable auto routing" });
	await enabled.click();
	const strategy = dialog.getByRole("combobox", {
		name: "How to choose a rule",
	});
	await strategy.click();
	await chooseOption(page, /Match on meaning/u);
	await expect(
		dialog.getByLabel("Embedding model", { exact: true })
	).toBeVisible();
	const threshold = dialog.getByRole("slider", {
		name: "Similarity threshold",
	});
	await expect(threshold).toHaveAttribute("aria-valuenow", "0.35");

	const embedding = dialog.getByLabel("Embedding model", { exact: true });
	await embedding.fill("  nomic-embed-text-v1.5  ");
	for (let step = 0; step < 5; step += 1) {
		await threshold.press("ArrowRight");
	}
	await expect(threshold).toHaveAttribute("aria-valuenow", "0.6");
	await expect(dialog.getByText("0.60", { exact: true })).toHaveCount(2);

	await strategy.click();
	await chooseOption(page, /Match on words/u);
	await expect(dialog.getByLabel("Classifier model")).toHaveCount(0);
	await expect(dialog.getByLabel("Embedding model")).toHaveCount(0);
	await expect(
		dialog.getByRole("slider", { name: "Similarity threshold" })
	).toHaveCount(0);
	await strategy.click();
	await chooseOption(page, /Let a model decide/u);
	const classifier = dialog.getByLabel("Classifier model", { exact: true });
	await classifier.fill("  openrouter/qwen3-8b  ");
	await expect(dialog.getByLabel("Embedding model")).toHaveCount(0);
	await strategy.click();
	await chooseOption(page, /Match on meaning/u);
	await expect(embedding).toHaveValue("  nomic-embed-text-v1.5  ");

	const addRule = dialog.getByRole("button", { name: "Add rule", exact: true });
	await addRule.click();
	let descriptionFields = dialog.getByPlaceholder(/When the request is about/u);
	await expect(descriptionFields).toHaveCount(1);
	await descriptionFields.nth(0).fill("  code and debugging  ");
	const firstRule = dialog
		.getByRole("button", { name: "Remove rule 1" })
		.locator("..");
	const firstTarget = firstRule.getByRole("combobox");
	await firstTarget.click();
	await expect(
		page.getByRole("option", { name: /Claude Code/u })
	).toBeVisible();
	await expect(page.getByRole("option", { name: /Draft only/u })).toHaveCount(
		0
	);
	await chooseOption(page, /Claude Code/u);
	await expect(firstTarget).toContainText("Claude Code");

	await addRule.click();
	descriptionFields = dialog.getByPlaceholder(/When the request is about/u);
	await descriptionFields.nth(1).fill("remove this rule");
	const secondRule = dialog
		.getByRole("button", { name: "Remove rule 2" })
		.locator("..");
	await secondRule.getByRole("combobox").click();
	await chooseOption(page, /^Ryu/u);
	await secondRule.getByRole("button", { name: "Remove rule 2" }).click();
	await expect(
		dialog.getByPlaceholder(/When the request is about/u)
	).toHaveCount(1);

	await addRule.click();
	await expect(
		dialog.getByPlaceholder(/When the request is about/u)
	).toHaveCount(2);
	const defaultAgent = dialog.getByRole("combobox", {
		name: "Default agent when no rule matches",
	});
	await defaultAgent.click();
	await chooseOption(page, /Claude Code/u);
	await expect(defaultAgent).toContainText("Claude Code");
	const cache = dialog.getByRole("switch", {
		name: "Resolve once per conversation",
	});
	await expect(cache).toBeChecked();
	await cache.click();
	await expect(cache).not.toBeChecked();
	await saveEvidence(page, "desktop-agent-auto-routing-rules-edited");

	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toBeHidden();
	let calls = await apiCallsFrom(page);
	const writes = preferenceCalls(calls, "PUT");
	expect(writes).toHaveLength(1);
	expect(parsedWrite(writes[0])).toEqual({
		cache_by_session: false,
		classifier_model: "openrouter/qwen3-8b",
		default_agent_id: "claude-code",
		embedding_model: "nomic-embed-text-v1.5",
		enabled: true,
		rules: [{ agent_id: "claude-code", description: "code and debugging" }],
		similarity_threshold: 0.6,
		strategy: "embedding",
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-agent-auto-routing-saved.png"),
	});

	await page.reload();
	dialog = await openAutoDialog(page);
	await waitForLoaded(dialog);
	await expect(
		dialog.getByRole("switch", { name: "Enable auto routing" })
	).toBeChecked();
	await expect(
		dialog.getByRole("combobox", { name: "How to choose a rule" })
	).toContainText("Match on meaning");
	await expect(dialog.getByLabel("Embedding model")).toHaveValue(
		"nomic-embed-text-v1.5"
	);
	await expect(
		dialog.getByRole("slider", { name: "Similarity threshold" })
	).toHaveAttribute("aria-valuenow", "0.6");
	await expect(
		dialog.getByPlaceholder(/When the request is about/u)
	).toHaveValue("code and debugging");
	await expect(
		dialog.getByRole("combobox", {
			name: "Default agent when no rule matches",
		})
	).toContainText("Claude Code");
	await expect(
		dialog.getByRole("switch", { name: "Resolve once per conversation" })
	).not.toBeChecked();
	calls = await apiCallsFrom(page);
	expect(await savedConfig(page)).toEqual(parsedWrite(writes[0]));
	expect(externalRequests).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expectPreferenceAuthentication(calls);
});

test("keeps the full draft after a failed Core write and retries the identical payload", async ({
	page,
}) => {
	const { externalRequests, runtimeErrors } = await openProof(page);
	const dialog = await openAutoDialog(page);
	await waitForLoaded(dialog);
	await dialog.getByRole("switch", { name: "Enable auto routing" }).click();
	await dialog
		.getByLabel("Classifier model", { exact: true })
		.fill("local-fast");
	await dialog.getByRole("button", { name: "Add rule", exact: true }).click();
	await dialog
		.getByPlaceholder(/When the request is about/u)
		.fill("research and summarize");
	const target = dialog
		.getByRole("button", { name: "Remove rule 1" })
		.locator("..")
		.getByRole("combobox");
	await target.click();
	await chooseOption(page, /Claude Code/u);
	await armApiFailure(page, "PUT");

	const save = dialog.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("alert")).toContainText(
		"/api/preferences/agent-auto-routing failed: 503"
	);
	await expect(
		dialog.getByRole("switch", { name: "Enable auto routing" })
	).toBeChecked();
	await expect(dialog.getByLabel("Classifier model")).toHaveValue("local-fast");
	await expect(
		dialog.getByPlaceholder(/When the request is about/u)
	).toHaveValue("research and summarize");
	await expect(target).toContainText("Claude Code");
	await expect(save).toBeEnabled();
	await expect(await savedConfig(page)).toBeNull();
	await saveEvidence(page, "desktop-agent-auto-routing-save-error");

	await save.click();
	await expect(dialog).toBeHidden();
	let calls = await apiCallsFrom(page);
	const writes = preferenceCalls(calls, "PUT");
	expect(writes).toHaveLength(2);
	expect(parsedWrite(writes[0])).toEqual(parsedWrite(writes[1]));
	expect(await savedConfig(page)).toEqual({
		...DEFAULT_CONFIG,
		enabled: true,
		classifier_model: "local-fast",
		rules: [{ agent_id: "claude-code", description: "research and summarize" }],
	});
	await page.reload();
	const reopened = await openAutoDialog(page);
	await waitForLoaded(reopened);
	await expect(reopened.getByLabel("Classifier model")).toHaveValue(
		"local-fast"
	);
	await expect(
		reopened.getByPlaceholder(/When the request is about/u)
	).toHaveValue("research and summarize");
	calls = await apiCallsFrom(page);
	expect(externalRequests).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expectPreferenceAuthentication(calls);
});

test("shows a preference-read failure and Retry recovers the saved defaults", async ({
	page,
}) => {
	const { externalRequests, runtimeErrors } = await openProof(page);
	const dialog = await openAutoDialog(page);
	await waitForLoaded(dialog);
	await armApiFailure(page, "GET");
	// A second open makes the next preference read fail without changing the saved
	// state; closing via Cancel is the same public dialog path users can take.
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	const reopened = await openAutoDialog(page);
	await expect(reopened.getByRole("alert")).toContainText(
		"Auto routing settings could not be loaded"
	);
	await expect(
		reopened.getByRole("switch", { name: "Enable auto routing" })
	).toHaveCount(0);
	await saveEvidence(page, "desktop-agent-auto-routing-load-error");
	await reopened.getByRole("button", { name: "Retry", exact: true }).click();
	await waitForLoaded(reopened);
	await expect(
		reopened.getByRole("switch", { name: "Enable auto routing" })
	).not.toBeChecked();
	expect(
		preferenceCalls(await apiCallsFrom(page), "GET").map((call) => call.status)
	).toEqual([404, 503, 404]);
	expect(externalRequests).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expectPreferenceAuthentication(await apiCallsFrom(page));
});

test("adopts the ready local classifier and explains an unweighted classifier", async ({
	page,
}) => {
	const { externalRequests, runtimeErrors } = await openProof(page, "ready");
	const dialog = await openAutoDialog(page);
	await waitForLoaded(dialog);
	await dialog.getByRole("switch", { name: "Enable auto routing" }).click();
	await expect(dialog.getByText("Local classifier running")).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Use it", exact: true })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Use it", exact: true }).click();
	await expect(dialog.getByLabel("Classifier model")).toHaveValue(
		CLASSIFY_MODEL_ID
	);
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(await savedConfig(page)).toMatchObject({
		enabled: true,
		classifier_model: CLASSIFY_MODEL_ID,
	});

	await page.goto(
		`${PROOF_URL}?reset=true&agentAuto=true&classifier=unweighted`
	);
	const unavailable = await openAutoDialog(page);
	await waitForLoaded(unavailable);
	await unavailable
		.getByRole("switch", { name: "Enable auto routing" })
		.click();
	await expect(
		unavailable.getByText("Local classifier not downloaded")
	).toBeVisible();
	await expect(
		unavailable.getByText(/every turn will quietly fall back/u)
	).toBeVisible();
	await expect(
		unavailable.getByRole("button", { name: "Use it", exact: true })
	).toHaveCount(0);
	await unavailable.getByRole("button", { name: "Save", exact: true }).click();
	await expect(unavailable).toBeHidden();
	await expect(
		page.getByText("Auto routing saved, but it will not run")
	).toBeVisible();
	expect(preferenceCalls(await apiCallsFrom(page), "PUT")).toHaveLength(1);
	expect(externalRequests).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expectPreferenceAuthentication(await apiCallsFrom(page));
});
