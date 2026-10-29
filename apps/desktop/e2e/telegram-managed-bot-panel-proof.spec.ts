import type { TelegramManagedBotPanelProofPublisher } from "./harness/telegram-managed-bot-panel-proof.tsx";

declare const window: Window & {
	__TELEGRAM_MANAGED_BOT_PANEL_PROOF__: TelegramManagedBotPanelProofPublisher;
};

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const FIXTURE_SETUP = "/__fixture/telegram-managed-bot/setup";
const FIXTURE_SNAPSHOT = "/__fixture/telegram-managed-bot/snapshot";
const NODE_TOKEN = "telegram-panel-node-token";
const PAIRING_DEEP_LINK =
	"https://t.me/ryu_managed_fixture_bot?start=mb_telegram-nonce-1";
const UNSUPPORTED_MESSAGE =
	"This node can't create Telegram bots for you yet — the hosted bot service hasn't been switched on.";
const EVIDENCE_DIR = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence/telegram-managed-bot"
);

interface ManagedBotRequestRecord {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}

interface ManagedBotFixtureSnapshot {
	confirmationAttempts: number;
	mode: string;
	pairAttempts: number;
	requests: ManagedBotRequestRecord[];
	statusPolls: number;
}

const EXPECTED_PAIRING_FORM = {
	agent_id: "agent-support",
	enabled: false,
	group_reply_mode: "all",
	model: "openai/gpt-4.1-mini",
	name: "Ryu Support",
	proactive_opening: true,
	proactive_target: "-1001234567890",
	reaction_learning: {
		allowGroup: true,
		enabled: true,
		negativeEmoji: ["👎", "💀"],
		positiveEmoji: ["👍", "❤️", "🎉"],
	},
	suggested_name: "Ryu Support",
	system_prompt: "Answer briefly and use the configured support agent.",
	team_id: "team-ops",
};

async function openPanel(page: Page, mode: string): Promise<void> {
	await page.goto("/telegram-managed-bot-panel-proof.html");
	await page.waitForFunction(() => document.body.dataset.harnessReady === "1");
	const response = await page.request.get(
		new URL(
			`${FIXTURE_SETUP}?mode=${encodeURIComponent(mode)}`,
			page.url()
		).toString()
	);
	expect(response.ok()).toBe(true);
}

async function readFixture(page: Page): Promise<ManagedBotFixtureSnapshot> {
	const response = await page.request.get(
		new URL(FIXTURE_SNAPSHOT, page.url()).toString()
	);
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function readyTokens(page: Page): Promise<(string | null)[]> {
	return page.evaluate(() => {
		const proofWindow =
			/* SAFETY: This fixture initialization defines __TELEGRAM_MANAGED_BOT_PANEL_PROOF__ on its own browser window. */ window as Window & {
				__TELEGRAM_MANAGED_BOT_PANEL_PROOF__: {
					readyTokens: (string | null)[];
				};
			};
		return proofWindow.__TELEGRAM_MANAGED_BOT_PANEL_PROOF__.readyTokens;
	});
}

async function unsupportedMessages(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const proofWindow =
			/* SAFETY: This fixture initialization defines __TELEGRAM_MANAGED_BOT_PANEL_PROOF__ on its own browser window. */ window as Window & {
				__TELEGRAM_MANAGED_BOT_PANEL_PROOF__: {
					unsupportedMessages: string[];
				};
			};
		return proofWindow.__TELEGRAM_MANAGED_BOT_PANEL_PROOF__.unsupportedMessages;
	});
}

async function capture(page: Page, name: string): Promise<void> {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, `${name}.png`),
	});
}

test.beforeAll(async () => {
	await mkdir(EVIDENCE_DIR, { recursive: true });
});

test("gate managed pairing, send the complete exact node request, safely link Telegram, and cancel", async ({
	page,
}) => {
	await openPanel(page, "waiting");
	const start = page.getByRole("button", { name: "Create a bot for me" });
	await expect(start).toBeDisabled();
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("checkbox", { name: "Proactive opening" }).check();
	await expect(start).toBeDisabled();
	await page
		.getByRole("textbox", { name: "Approved welcome target" })
		.fill("-1001234567890");
	await expect(start).toBeEnabled();
	await start.click();

	const link = page.getByRole("link", { name: PAIRING_DEEP_LINK });
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute("href", PAIRING_DEEP_LINK);
	await expect(link).toHaveAttribute("target", "_blank");
	await expect(link).toHaveAttribute("rel", "noopener noreferrer");
	await expect(page.getByRole("img", { name: "QR code" })).toBeVisible();
	await capture(page, "waiting-link");

	await expect
		.poll(
			async () =>
				(await readFixture(page)).requests.filter(
					(request) => request.method === "GET"
				).length
		)
		.toBeGreaterThan(0);
	const waiting = await readFixture(page);
	expect(waiting.requests[0].body).toEqual(EXPECTED_PAIRING_FORM);
	expect(waiting.requests[0]).toMatchObject({
		authorization: `Bearer ${NODE_TOKEN}`,
		body: EXPECTED_PAIRING_FORM,
		method: "POST",
		path: "/api/channels/managed-bot/pair",
	});
	expect(
		waiting.requests.filter((request) => request.method === "GET")
	).toEqual([
		expect.objectContaining({
			authorization: `Bearer ${NODE_TOKEN}`,
			body: null,
			path: "/api/channels/managed-bot/telegram-nonce-1",
		}),
	]);
	expect(JSON.stringify(waiting.requests)).not.toContain("claim_secret");

	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(start).toBeVisible();
	await page.waitForTimeout(3200);
	const cancelled = await readFixture(page);
	expect(cancelled.requests.map((request) => request.method)).toEqual([
		"POST",
		"GET",
		"DELETE",
	]);
	expect(cancelled.requests[2]).toMatchObject({
		authorization: `Bearer ${NODE_TOKEN}`,
		body: null,
		method: "DELETE",
		path: "/api/channels/managed-bot/telegram-nonce-1",
	});
});

test("reject an unsafe pairing URL and allow cancellation from the link error", async ({
	page,
}) => {
	await openPanel(page, "invalid-link");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(page.getByText(/invalid pairing link/iu)).toBeVisible();
	await expect(
		page.getByTestId("telegram-managed-bot-panel").locator("a")
	).toHaveCount(0);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();

	const fixture = await readFixture(page);
	expect(fixture.requests.map((request) => request.method)).toEqual([
		"POST",
		"DELETE",
	]);
	expect(fixture.requests[1]).toMatchObject({
		authorization: `Bearer ${NODE_TOKEN}`,
		method: "DELETE",
		path: "/api/channels/managed-bot/telegram-nonce-1",
	});
});

test("Connect @ confirms only the displayed owner bot and accepts the node-saved result", async ({
	page,
}) => {
	await openPanel(page, "connect");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(
		page.getByText(/Telegram created @ryu_fixture_bot/u)
	).toBeVisible();
	await expect(page.getByText(/account 7770001/u)).toBeVisible();
	await expect(page.getByText(/nothing has been saved yet/iu)).toBeVisible();
	await capture(page, "confirm-owner");
	await page.getByRole("button", { name: "Connect @ryu_fixture_bot" }).click();
	await expect(page.getByText("The node saved the bot.")).toBeVisible();
	expect(await readyTokens(page)).toEqual([null]);

	const fixture = await readFixture(page);
	expect(fixture.requests.map((request) => request.method)).toEqual([
		"POST",
		"GET",
		"POST",
	]);
	expect(fixture.requests[0].body).toEqual({
		...EXPECTED_PAIRING_FORM,
		proactive_opening: false,
		proactive_target: null,
		name: "Ryu Support",
		suggested_name: "Ryu Support",
	});
	expect(fixture.requests[1]).toMatchObject({
		authorization: `Bearer ${NODE_TOKEN}`,
		method: "GET",
		path: "/api/channels/managed-bot/telegram-nonce-1",
	});
	expect(fixture.requests[2]).toMatchObject({
		authorization: `Bearer ${NODE_TOKEN}`,
		body: null,
		method: "POST",
		path: "/api/channels/managed-bot/telegram-nonce-1/confirm",
	});
	expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(
		false
	);
});

test("a failed Connect @ confirmation stays on the displayed bot and retries the same request", async ({
	page,
}) => {
	await openPanel(page, "confirm-retry");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	const connect = page.getByRole("button", {
		name: "Connect @ryu_fixture_bot",
	});
	await expect(connect).toBeVisible();
	await connect.click();
	await expect(
		page.getByText("The local confirmation node is temporarily unavailable.")
	).toBeVisible();
	await expect(connect).toBeEnabled();
	await connect.click();
	await expect(page.getByText("The node saved the bot.")).toBeVisible();
	expect(await readyTokens(page)).toEqual([null]);

	const fixture = await readFixture(page);
	const confirmations = fixture.requests.filter((request) =>
		request.path.endsWith("/confirm")
	);
	expect(confirmations).toHaveLength(2);
	expect(confirmations.map((request) => request.method)).toEqual([
		"POST",
		"POST",
	]);
	expect(confirmations.map((request) => request.body)).toEqual([null, null]);
	expect(
		confirmations.every(
			(request) => request.authorization === `Bearer ${NODE_TOKEN}`
		)
	).toBe(true);
	expect(fixture.pairAttempts).toBe(1);
	expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(
		false
	);
});

test("Not mine discards and revokes the token without confirming or saving it", async ({
	page,
}) => {
	await openPanel(page, "not-mine");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(
		page.getByRole("button", { name: "Not mine, discard" })
	).toBeVisible();
	await page.getByRole("button", { name: "Not mine, discard" }).click();
	await expect(
		page.getByText(/Discarded — that bot was not connected/u)
	).toBeVisible();
	expect(await readyTokens(page)).toEqual([]);

	const fixture = await readFixture(page);
	expect(fixture.requests.map((request) => request.method)).toEqual([
		"POST",
		"GET",
		"DELETE",
	]);
	expect(fixture.requests.at(-1)).toMatchObject({
		authorization: `Bearer ${NODE_TOKEN}`,
		method: "DELETE",
		path: "/api/channels/managed-bot/telegram-nonce-1",
	});
});

test("leaving the active panel abandons a waiting pairing and resets its draft state", async ({
	page,
}) => {
	await openPanel(page, "waiting");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(
		page.getByRole("link", { name: PAIRING_DEEP_LINK })
	).toBeVisible();
	await page.getByRole("button", { name: "Close pairing panel" }).click();
	await expect(page.getByText("Pairing panel closed.")).toBeVisible();
	await expect
		.poll(async () =>
			(await readFixture(page)).requests.some(
				(request) => request.method === "DELETE"
			)
		)
		.toBe(true);
	await page.getByRole("button", { name: "Reopen pairing panel" }).click();
	await expect(
		page.getByRole("button", { name: "Create a bot for me" })
	).toBeVisible();

	const fixture = await readFixture(page);
	expect(fixture.requests.map((request) => request.method)).toEqual([
		"POST",
		"DELETE",
	]);
	expect(fixture.requests[1].path).toBe(
		"/api/channels/managed-bot/telegram-nonce-1"
	);
});

test("an expired nonce stops polling and Start over creates a fresh link", async ({
	page,
}) => {
	await openPanel(page, "expired");
	const name = page.getByRole("textbox", { name: "Name" });
	await name.fill("Ryu Support");
	await expect(name).toHaveValue("Ryu Support");
	const start = page.getByRole("button", { name: "Create a bot for me" });
	await expect(start).toBeEnabled();
	await start.click();
	await expect(page.getByRole("button", { name: "Start over" })).toBeVisible({
		timeout: 6000,
	});
	await expect(
		page.getByText(/link expired before the bot was created/u)
	).toBeVisible();
	await page.getByRole("button", { name: "Start over" }).click();
	const freshLink =
		"https://t.me/ryu_managed_fixture_bot?start=mb_telegram-nonce-2";
	await expect(page.getByRole("link", { name: freshLink })).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();

	const fixture = await readFixture(page);
	const starts = fixture.requests.filter(
		(request) => request.path === "/api/channels/managed-bot/pair"
	);
	expect(starts).toHaveLength(2);
	expect(starts.map((request) => request.body)).toEqual([
		{
			...EXPECTED_PAIRING_FORM,
			proactive_opening: false,
			proactive_target: null,
			name: "Ryu Support",
			suggested_name: "Ryu Support",
		},
		{
			...EXPECTED_PAIRING_FORM,
			proactive_opening: false,
			proactive_target: null,
			name: "Ryu Support",
			suggested_name: "Ryu Support",
		},
	]);
	expect(fixture.requests.map((request) => request.method)).toEqual([
		"POST",
		"POST",
		"DELETE",
	]);
});

test("a transient pairing start exposes Try again and retries the identical form", async ({
	page,
}) => {
	await openPanel(page, "pair-retry");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(
		page.getByText("The local pairing node is temporarily unavailable.")
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	const retryLink =
		"https://t.me/ryu_managed_fixture_bot?start=mb_telegram-nonce-2";
	await expect(page.getByRole("link", { name: retryLink })).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();

	const fixture = await readFixture(page);
	const starts = fixture.requests.filter(
		(request) => request.path === "/api/channels/managed-bot/pair"
	);
	expect(starts).toHaveLength(2);
	expect(starts[0].body).toEqual({
		...EXPECTED_PAIRING_FORM,
		proactive_opening: false,
		proactive_target: null,
		name: "Ryu Support",
		suggested_name: "Ryu Support",
	});
	expect(starts[1].body).toEqual(starts[0].body);
	expect(
		starts.every((request) => request.authorization === `Bearer ${NODE_TOKEN}`)
	).toBe(true);
});

test("unsupported managed pairing falls back to a manual token entry", async ({
	page,
}) => {
	await openPanel(page, "unsupported-pair");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(
		page.getByRole("region", { name: "Manual token fallback" })
	).toBeVisible();
	await expect(
		page.getByRole("textbox", { name: "Manual bot token" })
	).toBeVisible();
	await expect(page.getByText(/hasn't been switched on/u)).toBeVisible();
	await capture(page, "unsupported-manual-fallback");
	expect(await unsupportedMessages(page)).toEqual([UNSUPPORTED_MESSAGE]);

	const fixture = await readFixture(page);
	expect(fixture.requests).toHaveLength(1);
	expect(fixture.requests[0]).toMatchObject({
		authorization: `Bearer ${NODE_TOKEN}`,
		method: "POST",
		path: "/api/channels/managed-bot/pair",
	});
});

test("unsupported status polling also falls back instead of leaving a dead pairing screen", async ({
	page,
}) => {
	await openPanel(page, "unsupported-status");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(
		page.getByRole("region", { name: "Manual token fallback" })
	).toBeVisible({
		timeout: 6000,
	});
	expect(await unsupportedMessages(page)).toEqual([UNSUPPORTED_MESSAGE]);

	const fixture = await readFixture(page);
	expect(fixture.requests.map((request) => request.method)).toEqual([
		"POST",
		"GET",
	]);
	expect(
		fixture.requests.every(
			(request) => request.authorization === `Bearer ${NODE_TOKEN}`
		)
	).toBe(true);
});

test("a status 404 means this nonce expired, not that managed bots are unsupported", async ({
	page,
}) => {
	await openPanel(page, "status-expired");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(page.getByRole("button", { name: "Start over" })).toBeVisible({
		timeout: 6000,
	});
	await expect(
		page.getByText(
			"That link expired before the bot was created. Nothing was saved."
		)
	).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Manual token fallback" })
	).toHaveCount(0);
	expect(await unsupportedMessages(page)).toEqual([]);

	const fixture = await readFixture(page);
	expect(fixture.requests.map((request) => request.method)).toEqual([
		"POST",
		"GET",
	]);
});

test("a node-ready poll hands an optional token to the host without a confirm call", async ({
	page,
}) => {
	await openPanel(page, "ready-status");
	await page.getByRole("textbox", { name: "Name" }).fill("Ryu Support");
	await page.getByRole("button", { name: "Create a bot for me" }).click();
	await expect(page.getByText("A token was handed to the host.")).toBeVisible({
		timeout: 6000,
	});
	expect(await readyTokens(page)).toEqual(["fixture-telegram-token"]);

	const fixture = await readFixture(page);
	expect(fixture.requests.map((request) => request.method)).toEqual([
		"POST",
		"GET",
	]);
	expect(
		fixture.requests.some((request) => request.path.endsWith("/confirm"))
	).toBe(false);
	expect(
		fixture.requests.every(
			(request) => request.authorization === `Bearer ${NODE_TOKEN}`
		)
	).toBe(true);
});
