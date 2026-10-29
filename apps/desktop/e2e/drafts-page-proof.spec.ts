import type { useTabsContext } from "../src/contexts/TabsContext.tsx";

type OpenTabOptions = NonNullable<
	Parameters<ReturnType<typeof useTabsContext>["openTab"]>[1]
>;

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

interface DraftTrigger {
	agent_id?: string;
	below?: number;
	below_percent?: number;
	epoch_ms?: number;
	kind: "manual" | "all_done" | "concurrency" | "usage_reset" | "at";
}

interface DraftRow {
	agent_id?: string;
	claimed_at?: number;
	conversation_id?: string;
	created_at: number;
	error?: string;
	folder_path?: string;
	id: string;
	model?: string;
	preview: string;
	sent_at?: number;
	source: "composer-autosave" | "manual" | "auto-queue";
	state: "draft" | "armed" | "sending" | "sent" | "failed";
	state_label: string;
	text: string;
	trigger: DraftTrigger;
	updated_at: number;
	waiting_for: string;
}

interface DraftsSettings {
	auto_queue_enabled: boolean;
	autosave_enabled: boolean;
	autosave_min_chars: number;
	max_concurrent: number;
}

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface DraftsSnapshot {
	drafts: DraftRow[];
	sent: DraftRow[];
	settings: DraftsSettings;
}

interface DraftsPageProof {
	armFailure: (method: string, path: string, status?: number) => void;
	openedTabs: Array<{ options: OpenTabOptions; path: string }>;
	requests: CapturedRequest[];
	snapshot: () => DraftsSnapshot;
}

interface DraftsPageWindow extends Window {
	__draftsPageProof: DraftsPageProof;
}

const AGENT_ID = "drafts-proof-agent";
const DRAFT_ID = "drafts-proof-armed";
const ORIGINAL_TEXT = "Review the release notes after the Atlas run";
const UPDATED_TEXT =
	"Review the release notes after the Atlas run and note blockers";
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

async function openDrafts(
	page: Page,
	seed: "empty" | "armed" | "hand"
): Promise<void> {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto(`/drafts-page-proof.html?seed=${seed}`);
	await expect(
		page.getByRole("heading", { name: "Drafts", exact: true })
	).toBeVisible();
	await page.waitForFunction(
		() =>
			Boolean(
				/* SAFETY: drafts-page-proof.tsx installs __draftsPageProof before this proof page is evaluated. */ (
					window as DraftsPageWindow
				).__draftsPageProof
			),
		undefined,
		{ timeout: 5000 }
	);
	if (browserErrors.length > 0) {
		throw new Error(`Drafts route errors: ${browserErrors.join(" | ")}`);
	}
}

async function snapshot(page: Page): Promise<{
	fixture: DraftsPageProof;
	state: DraftsSnapshot;
}> {
	return await page.evaluate(() => {
		const fixture =
			/* SAFETY: drafts-page-proof.tsx installs __draftsPageProof before this proof page is evaluated. */ (
				window as DraftsPageWindow
			).__draftsPageProof;
		return { fixture, state: fixture.snapshot() };
	});
}

async function failNext(
	page: Page,
	method: string,
	requestPath: string,
	status = 503
): Promise<void> {
	await page.evaluate(
		({ method, requestPath, status }) =>
			/* SAFETY: drafts-page-proof.tsx installs __draftsPageProof before this proof page is evaluated. */ (
				window as DraftsPageWindow
			).__draftsPageProof.armFailure(method, requestPath, status),
		{ method, requestPath, status }
	);
}

async function capture(page: Page, filename: string): Promise<void> {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, filename),
	});
}

function draftCard(page: Page) {
	return page.getByRole("group", { name: /^Draft:/ }).first();
}

test.describe.configure({ timeout: 60_000 });

test("empty outbox opens a new chat; manual create retains its draft on 503 and reads back", async ({
	page,
}) => {
	await openDrafts(page, "empty");
	await expect(page.getByText("No drafts", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
	await capture(page, "desktop-drafts-empty-state.png");
	await page.getByRole("button", { name: "Open a new chat" }).click();
	await expect
		.poll(async () => (await snapshot(page)).fixture.openedTabs)
		.toContainEqual({ options: { forceNew: true }, path: "/chat" });

	const composer = page.getByPlaceholder("Write a draft to send later…");
	await composer.fill("A note to send after the release review");
	const saveDraft = page.getByRole("button", { name: "Save draft" });
	await expect(saveDraft).toBeEnabled();
	await failNext(page, "POST", "/api/drafts/drafts");
	await saveDraft.click();
	await expect(page.getByRole("alert")).toContainText("503");
	await expect(composer).toHaveValue("A note to send after the release review");
	await capture(page, "desktop-drafts-create-error-retained.png");

	await saveDraft.click();
	await expect(composer).toHaveValue("");
	await expect(
		page.getByRole("textbox", { name: "Draft message" })
	).toHaveValue("A note to send after the release review");
	const created = await snapshot(page);
	const creates = created.fixture.requests.filter(
		(request) =>
			request.method === "POST" && request.path === "/api/drafts/drafts"
	);
	expect(creates.map((request) => request.status)).toEqual([503, 200]);
	expect(creates.map((request) => request.body)).toEqual([
		{
			text: "A note to send after the release review",
			source: "manual",
		},
		{
			text: "A note to send after the release review",
			source: "manual",
		},
	]);
	expect(created.state.drafts[0]).toMatchObject({
		id: "drafts-proof-created",
		source: "manual",
		state: "draft",
		text: "A note to send after the release review",
		trigger: { kind: "manual" },
	});
	await page.reload();
	await expect(
		page.getByRole("textbox", { name: "Draft message" })
	).toHaveValue("A note to send after the release review");
	await capture(page, "desktop-drafts-create-readback.png");
});

test("editing preserves armed draft context; usage-reset queue, disarm, and delete recover and persist", async ({
	page,
}) => {
	await openDrafts(page, "armed");
	const card = draftCard(page);
	const editor = card.getByRole("textbox", { name: "Draft message" });
	await expect(editor).toHaveValue(ORIGINAL_TEXT);
	await editor.fill(UPDATED_TEXT);
	const save = card.getByRole("button", { name: "Save", exact: true });
	await failNext(page, "POST", "/api/drafts/drafts");
	await save.click();
	await expect(card.getByRole("alert")).toContainText("503");
	await expect(editor).toHaveValue(UPDATED_TEXT);
	await capture(page, "desktop-drafts-edit-error-retained.png");

	await save.click();
	await expect(card.getByText("Queued", { exact: true })).toBeVisible();
	await expect(card.getByRole("button", { name: "Unqueue" })).toBeVisible();
	const saved = await snapshot(page);
	expect(saved.state.drafts[0]).toMatchObject({
		id: DRAFT_ID,
		agent_id: AGENT_ID,
		conversation_id: "conversation-atlas",
		folder_path: "/work/atlas",
		model: "gpt-4.1",
		source: "composer-autosave",
		state: "armed",
		text: UPDATED_TEXT,
		trigger: {
			kind: "usage_reset",
			agent_id: AGENT_ID,
			below_percent: 90,
		},
	});
	const saveRequests = saved.fixture.requests.filter(
		(request) =>
			request.method === "POST" && request.path === "/api/drafts/drafts"
	);
	expect(saveRequests.map((request) => request.status)).toEqual([503, 200]);
	expect(saveRequests.map((request) => request.body)).toEqual([
		{
			id: DRAFT_ID,
			text: UPDATED_TEXT,
			conversation_id: "conversation-atlas",
			agent_id: AGENT_ID,
			model: "gpt-4.1",
			folder_path: "/work/atlas",
			source: "composer-autosave",
			trigger: {
				kind: "usage_reset",
				agent_id: AGENT_ID,
				below_percent: 90,
			},
		},
		{
			id: DRAFT_ID,
			text: UPDATED_TEXT,
			conversation_id: "conversation-atlas",
			agent_id: AGENT_ID,
			model: "gpt-4.1",
			folder_path: "/work/atlas",
			source: "composer-autosave",
			trigger: {
				kind: "usage_reset",
				agent_id: AGENT_ID,
				below_percent: 90,
			},
		},
	]);
	await page.reload();
	await expect(
		draftCard(page).getByText("Queued", { exact: true })
	).toBeVisible();
	await expect(
		draftCard(page).getByText(
			"Waiting for Atlas Research Agent to drop under 90% used",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		draftCard(page).getByRole("textbox", { name: "Draft message" })
	).toHaveValue(UPDATED_TEXT);
	await capture(page, "desktop-drafts-armed-context-readback.png");

	await draftCard(page).getByRole("button", { name: "Unqueue" }).click();
	await expect(
		draftCard(page).getByRole("button", { name: "Queue it" })
	).toBeVisible();
	await draftCard(page)
		.getByRole("combobox", { name: "Queue condition" })
		.click();
	await page.getByRole("option", { name: "when a limit lifts" }).click();
	await draftCard(page)
		.getByRole("combobox", { name: "Agent for usage reset" })
		.click();
	await page.getByRole("option", { name: "Atlas Research Agent" }).click();
	await failNext(page, "POST", `/api/drafts/drafts/${DRAFT_ID}/arm`);
	await draftCard(page).getByRole("button", { name: "Queue it" }).click();
	await expect(draftCard(page).getByRole("alert")).toContainText("503");
	await capture(page, "desktop-drafts-queue-error-retry.png");
	await draftCard(page).getByRole("button", { name: "Queue it" }).click();
	await expect(
		draftCard(page).getByText("Queued", { exact: true })
	).toBeVisible();
	const armed = await snapshot(page);
	const armRequests = armed.fixture.requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === `/api/drafts/drafts/${DRAFT_ID}/arm`
	);
	expect(armRequests.map((request) => request.status)).toEqual([503, 200]);
	expect(armRequests.map((request) => request.body)).toEqual([
		{ trigger: { kind: "usage_reset", agent_id: AGENT_ID, below_percent: 90 } },
		{ trigger: { kind: "usage_reset", agent_id: AGENT_ID, below_percent: 90 } },
	]);

	await failNext(page, "DELETE", `/api/drafts/drafts/${DRAFT_ID}`);
	await draftCard(page)
		.getByRole("button", { name: `Delete draft: ${UPDATED_TEXT}` })
		.click();
	await expect
		.poll(async () =>
			(await snapshot(page)).fixture.requests
				.filter(
					(request) =>
						request.method === "DELETE" &&
						request.path === `/api/drafts/drafts/${DRAFT_ID}`
				)
				.map((request) => request.status)
		)
		.toEqual([503]);
	await expect(draftCard(page).getByRole("alert")).toContainText("503");
	await expect(
		draftCard(page).getByRole("textbox", { name: "Draft message" })
	).toHaveValue(UPDATED_TEXT);
	await capture(page, "desktop-drafts-delete-error-retained.png");
	await draftCard(page)
		.getByRole("button", { name: `Delete draft: ${UPDATED_TEXT}` })
		.click();
	await expect(page.getByText("No drafts", { exact: true })).toBeVisible();
	const afterDelete = await snapshot(page);
	const deletes = afterDelete.fixture.requests.filter(
		(request) =>
			request.method === "DELETE" &&
			request.path === `/api/drafts/drafts/${DRAFT_ID}`
	);
	expect(deletes.map((request) => request.status)).toEqual([503, 200]);
	expect(deletes.map((request) => request.body)).toEqual([null, null]);
	expect(afterDelete.state.drafts).toEqual([]);
	await page.reload();
	await expect(page.getByText("No drafts", { exact: true })).toBeVisible();
	await capture(page, "desktop-drafts-delete-readback.png");
});

test("node-wide Drafts settings retain failures, retry exact values, and read back after reload", async ({
	page,
}) => {
	await openDrafts(page, "empty");
	const autoQueue = page.getByRole("switch", {
		name: "Queue sends when already busy",
	});
	await expect(autoQueue).toHaveAttribute("aria-checked", "false");
	await failNext(page, "PUT", "/api/drafts/settings");
	await autoQueue.click();
	await expect(page.getByRole("alert")).toContainText("503");
	await expect(autoQueue).toHaveAttribute("aria-checked", "false");
	await capture(page, "desktop-drafts-settings-error-retry.png");
	await autoQueue.click();
	await expect(autoQueue).toHaveAttribute("aria-checked", "true");

	const autosave = page.getByRole("switch", {
		name: "Keep unsent composer text",
	});
	await autosave.click();
	await expect(autosave).toHaveAttribute("aria-checked", "false");
	const concurrency = page.getByRole("spinbutton", {
		name: "Concurrent runs allowed",
	});
	await concurrency.fill("5");
	await expect(concurrency).toHaveValue("5");

	const persisted = await snapshot(page);
	expect(persisted.state.settings).toEqual({
		autosave_enabled: false,
		autosave_min_chars: 4,
		auto_queue_enabled: true,
		max_concurrent: 5,
	});
	const settingWrites = persisted.fixture.requests.filter(
		(request) =>
			request.method === "PUT" && request.path === "/api/drafts/settings"
	);
	expect(
		settingWrites.map((request) => request.status),
		JSON.stringify(settingWrites)
	).toEqual([503, 200, 200, 200]);
	expect(settingWrites.map((request) => request.body)).toEqual([
		{
			autosave_enabled: true,
			autosave_min_chars: 4,
			auto_queue_enabled: true,
			max_concurrent: 3,
		},
		{
			autosave_enabled: true,
			autosave_min_chars: 4,
			auto_queue_enabled: true,
			max_concurrent: 3,
		},
		{
			autosave_enabled: false,
			autosave_min_chars: 4,
			auto_queue_enabled: true,
			max_concurrent: 3,
		},
		{
			autosave_enabled: false,
			autosave_min_chars: 4,
			auto_queue_enabled: true,
			max_concurrent: 5,
		},
	]);
	await page.reload();
	await expect(
		page.getByRole("switch", { name: "Keep unsent composer text" })
	).toHaveAttribute("aria-checked", "false");
	await expect(
		page.getByRole("switch", { name: "Queue sends when already busy" })
	).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByRole("spinbutton", { name: "Concurrent runs allowed" })
	).toHaveValue("5");
	await capture(page, "desktop-drafts-settings-readback.png");
});

test("card spread deals drafts, piles a selection, and sends it through an `at: now` arm with failed cards returned", async ({
	page,
}) => {
	const first = "Ship the changelog once the Atlas run is green";
	const third = "Draft the migration note for the settings rename";
	await openDrafts(page, "hand");
	await page.getByRole("button", { name: "Deal as cards" }).click();
	const table = page.getByRole("dialog", { name: "Deal your drafts" });
	await expect(table).toBeVisible();
	const toPile = table.getByRole("button", { name: /^Add to send pile:/ });
	await expect(toPile).toHaveCount(5);
	await expect(
		table.getByRole("button", { name: "Send", exact: true })
	).toBeDisabled();
	await table
		.getByRole("button", { name: `Add to send pile: ${third}` })
		.hover();
	await page.waitForTimeout(600);
	await page.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-drafts-card-spread-hand.png"),
	});

	await table
		.getByRole("button", { name: `Add to send pile: ${first}` })
		.click();
	await table
		.getByRole("button", { name: `Add to send pile: ${third}` })
		.click();
	await expect(toPile).toHaveCount(3);
	await expect(table.getByText("2 on the pile")).toBeVisible();
	// The top card of the pile goes back to the hand on click, and can be re-picked.
	await table.getByRole("button", { name: `Return to hand: ${third}` }).click();
	await expect(toPile).toHaveCount(4);
	await table
		.getByRole("button", { name: `Add to send pile: ${third}` })
		.click();
	await expect(table.getByText("2 on the pile")).toBeVisible();
	await page.waitForTimeout(600);
	await page.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-drafts-card-spread-pile.png"),
	});

	await failNext(page, "POST", "/api/drafts/drafts/drafts-proof-hand-3/arm");
	await table.getByRole("button", { name: "Send 2" }).click();
	await page.waitForTimeout(250);
	await page.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-drafts-card-spread-flight.png"),
	});
	await expect(table.getByRole("status")).toContainText("1 sent, 1 came back");
	await expect(
		table.getByRole("button", { name: `Return to hand: ${third}` })
	).toBeVisible();
	await expect(
		table.getByRole("button", { name: new RegExp(first) })
	).toHaveCount(0);

	await table.getByRole("button", { name: "Send", exact: true }).click();
	await expect(table.getByRole("status")).toContainText(
		"1 draft handed to the outbox"
	);
	await expect(toPile).toHaveCount(3);
	await page.waitForTimeout(400);
	await page.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-drafts-card-spread-sent.png"),
	});

	const sent = await snapshot(page);
	const arms = sent.fixture.requests.filter(
		(request) => request.method === "POST" && request.path.endsWith("/arm")
	);
	// The pile's arms run in parallel, so only the set of outcomes is stable.
	expect(
		arms.map((request) => `${request.path} ${request.status}`).sort()
	).toEqual([
		"/api/drafts/drafts/drafts-proof-hand-1/arm 200",
		"/api/drafts/drafts/drafts-proof-hand-3/arm 200",
		"/api/drafts/drafts/drafts-proof-hand-3/arm 503",
	]);
	for (const request of arms) {
		expect(request.body).toMatchObject({
			trigger: { kind: "at", epoch_ms: expect.any(Number) },
		});
	}
	expect(
		sent.state.drafts
			.filter((draft) => draft.trigger.kind === "at")
			.map((draft) => draft.id)
			.sort()
	).toEqual(["drafts-proof-hand-1", "drafts-proof-hand-3"]);

	await page.keyboard.press("Escape");
	await expect(table).toBeHidden();
	// Reopening deals a fresh hand without the drafts already on their way.
	await page.getByRole("button", { name: "Deal as cards" }).click();
	await expect(
		page
			.getByRole("dialog", { name: "Deal your drafts" })
			.getByRole("button", { name: /^Add to send pile:/ })
	).toHaveCount(3);
});

test("card spread works by keyboard at phone width in dark mode with reduced motion", async ({
	page,
}) => {
	const second = "Ask the reviewer to re-run the flaky upload suite";
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await openDrafts(page, "hand");
	await page.evaluate(() => {
		document.documentElement.classList.remove("light");
		document.documentElement.classList.add("dark");
	});
	await page.getByRole("button", { name: "Deal as cards" }).click();
	const table = page.getByRole("dialog", { name: "Deal your drafts" });
	await expect(
		table.getByRole("button", { name: /^Add to send pile:/ })
	).toHaveCount(5);

	await table
		.getByRole("button", { name: `Add to send pile: ${second}` })
		.focus();
	await page.keyboard.press("Enter");
	await expect(
		table.getByRole("button", { name: `Return to hand: ${second}` })
	).toHaveAttribute("aria-pressed", "true");
	await page.screenshot({
		path: path.join(EVIDENCE_DIR, "desktop-drafts-card-spread-narrow-dark.png"),
	});

	await table.getByRole("button", { name: "Send", exact: true }).click();
	await expect(table.getByRole("status")).toContainText(
		"1 draft handed to the outbox"
	);
	const sent = await snapshot(page);
	expect(
		sent.state.drafts.find((draft) => draft.id === "drafts-proof-hand-2")
			?.trigger.kind
	).toBe("at");
	await page.keyboard.press("Escape");
	await expect(table).toBeHidden();
});
