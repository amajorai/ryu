import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
	type AddChannelProofInput,
	addChannelProofCallsSchema,
	addChannelProofInputSchema,
} from "./add-channel-proof.contracts.ts";

const STORY_URL = "/add-channel-dialog-proof.html";
const EVIDENCE_DIR = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence/add-channel-dialog"
);

interface CreateFixture {
	deferredResponse?: DeferredResponse;
	requests: AddChannelProofInput[];
	statuses: number[];
}

interface DeferredResponse {
	release: () => void;
	start: () => void;
	started: Promise<void>;
	waitForRelease: Promise<void>;
}

function createDeferredResponse(): DeferredResponse {
	let resolveStarted!: () => void;
	let releaseGate!: () => void;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const waitForRelease = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	let released = false;
	return {
		started,
		waitForRelease,
		release: () => {
			if (!released) {
				released = true;
				releaseGate();
			}
		},
		start: resolveStarted,
	};
}

async function installCreateFixture(page: Page, fixture: CreateFixture) {
	await page.route("**/api/channels", async (route: Route) => {
		if (route.request().method() !== "POST") {
			await route.fulfill({ status: 405, body: "method not allowed" });
			return;
		}
		fixture.requests.push(
			addChannelProofInputSchema.parse(route.request().postDataJSON())
		);
		if (fixture.deferredResponse) {
			fixture.deferredResponse.start();
			await fixture.deferredResponse.waitForRelease;
		}
		const status = fixture.statuses.shift() ?? 200;
		await route.fulfill({
			body:
				status === 200
					? JSON.stringify({ created: true })
					: JSON.stringify({
							message: "The channel service is temporarily unavailable.",
						}),
			contentType: "application/json",
			status,
		});
	});
}

async function proofCalls(page: Page): Promise<AddChannelProofInput[]> {
	return addChannelProofCallsSchema.parse(
		await page.evaluate(() => {
			return window.__ADD_CHANNEL_PROOF__?.calls ?? [];
		})
	);
}

test.beforeAll(async () => {
	await mkdir(EVIDENCE_DIR, { recursive: true });
});

test("switch between managed and manual setup and discard drafts on Cancel or Escape", async ({
	page,
}) => {
	const fixture: CreateFixture = { requests: [], statuses: [] };
	await installCreateFixture(page, fixture);
	await page.goto(STORY_URL);
	await page.waitForSelector("body[data-harness-ready='1']");

	const dialog = page.getByRole("dialog", { name: "New channel bot" });
	await expect(dialog).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create a bot for me" }).last()
	).toBeDisabled();
	await page.getByRole("button", { name: "Paste a token" }).click();
	await expect(page.getByPlaceholder("Paste value…")).toBeVisible();
	await page.getByLabel("Name", { exact: true }).fill("Draft bot");
	await page.getByPlaceholder("Paste value…").fill("draft-token");
	await page
		.getByRole("button", { name: "Create a bot for me" })
		.first()
		.click();
	await expect(page.getByText("Telegram creates a bot you own.")).toBeVisible();
	await expect(page.getByPlaceholder("Paste value…")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Create a bot for me" }).last()
	).toBeEnabled();

	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(fixture.requests).toHaveLength(0);
	await page.getByRole("button", { name: "Open channel dialog" }).click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
	await page.getByRole("button", { name: "Paste a token" }).click();
	await expect(page.getByPlaceholder("Paste value…")).toHaveValue("");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: "Open channel dialog" }).click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "cancel-escape-reset.png"),
	});
});

test("show each platform credential set and clear secrets when the platform changes", async ({
	page,
}) => {
	await installCreateFixture(page, { requests: [], statuses: [] });
	await page.goto(STORY_URL);
	const dialog = page.getByRole("dialog", { name: "New channel bot" });
	await page.getByRole("button", { name: "Paste a token" }).click();

	const platform = page.getByLabel("Platform");
	const credentials: [string, string[]][] = [
		["telegram", ["Bot token"]],
		["slack", ["App token", "Bot token"]],
		[
			"whatsapp",
			["Access token", "Phone number ID", "Verify token", "App secret"],
		],
		[
			"whatsapp_personal",
			[
				"OpenWA base URL",
				"OpenWA API key",
				"OpenWA session ID",
				"Public webhook URL",
				"Webhook secret",
			],
		],
		["discord", ["Bot token"]],
		["bluebubbles", ["BlueBubbles server URL", "BlueBubbles password"]],
	];

	for (const [value, labels] of credentials) {
		await platform.selectOption(value);
		if (value === "telegram") {
			await page.getByRole("button", { name: "Paste a token" }).click();
		}
		for (const label of labels) {
			await expect(dialog.getByLabel(label, { exact: true })).toBeVisible();
		}
	}

	await platform.selectOption("slack");
	await dialog.getByLabel("App token", { exact: true }).fill("old-app-token");
	await platform.selectOption("discord");
	await platform.selectOption("slack");
	await expect(dialog.getByLabel("App token", { exact: true })).toHaveValue("");
	await expect(dialog.getByLabel("Bot token", { exact: true })).toHaveValue("");
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "platform-credentials-reset.png"),
	});
});

test("validate and save the full Telegram channel configuration with exact retry", async ({
	page,
}) => {
	const fixture: CreateFixture = { requests: [], statuses: [503, 200] };
	await installCreateFixture(page, fixture);
	await page.goto(STORY_URL);
	const dialog = page.getByRole("dialog", { name: "New channel bot" });
	await page.getByRole("button", { name: "Paste a token" }).click();

	const create = page.getByRole("button", { name: "Create bot" });
	await create.click();
	await expect(dialog.getByText("Name is required.")).toBeVisible();
	await expect(fixture.requests).toHaveLength(0);

	await dialog.getByLabel("Name", { exact: true }).fill("  Support bot  ");
	await dialog.getByLabel("Bot token", { exact: true }).fill("  ");
	await create.click();
	await expect(dialog.getByText("Missing required: Bot token")).toBeVisible();
	await expect(fixture.requests).toHaveLength(0);
	await dialog.getByLabel("Bot token", { exact: true }).fill(" token-secret ");

	const goodReactions = dialog.getByLabel("Good response emojis");
	const badReactions = dialog.getByLabel("Bad response emojis");
	await expect(goodReactions).toBeDisabled();
	await dialog
		.getByRole("switch", { name: "Enable reaction learning" })
		.click();
	await goodReactions.fill("👍, ❤️, 🎉");
	await badReactions.fill("👎, 💀, 😴");
	await dialog
		.getByRole("switch", { name: "Allow group reaction learning" })
		.click();
	await dialog.getByLabel("Routes to").selectOption("team:team-ops");
	await dialog
		.getByLabel("Model override (optional)")
		.fill(" provider/model-v2 ");
	await dialog
		.getByLabel("System prompt (optional)")
		.fill(" Be clear and kind. ");
	await dialog.getByLabel("Group replies").selectOption("all");
	await dialog.getByRole("switch", { name: "Let Ryu say hello first" }).click();
	const target = dialog.getByLabel("Where should Ryu say hello?");
	await expect(target).toBeEnabled();
	await create.click();
	await expect(
		dialog.getByText(
			"Choose the approved chat that should receive Ryu's welcome."
		)
	).toBeVisible();
	await expect(fixture.requests).toHaveLength(0);
	await target.fill("  -10012345  ");
	await dialog.getByRole("switch", { name: "Enable channel" }).click();

	const expectedPayload = {
		agentId: null,
		channelType: "telegram",
		enabled: true,
		groupReplyMode: "all",
		model: "provider/model-v2",
		name: "Support bot",
		proactiveOpening: true,
		proactiveTarget: "-10012345",
		reactionLearning: {
			allowGroup: true,
			enabled: true,
			negativeEmoji: ["👎", "💀", "😴"],
			positiveEmoji: ["👍", "❤️", "🎉"],
		},
		secrets: { bot_token: "token-secret" },
		systemPrompt: "Be clear and kind.",
		teamId: "team-ops",
	};
	await create.click();
	await expect.poll(() => fixture.requests.length).toBe(1);
	expect(fixture.requests[0]).toEqual(expectedPayload);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
		"  Support bot  "
	);
	await expect(dialog.getByLabel("Bot token", { exact: true })).toHaveValue(
		" token-secret "
	);
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "create-retry-draft-retained.png"),
	});

	await create.click();
	await expect.poll(() => fixture.requests.length).toBe(2);
	expect(fixture.requests[1]).toEqual(expectedPayload);
	const recordedCalls = await proofCalls(page);
	expect(recordedCalls).toEqual([expectedPayload, expectedPayload]);
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Open channel dialog" })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "channel-created-retry-succeeded.png"),
	});
});

test("persist a selected agent separately from a team binding", async ({
	page,
}) => {
	const fixture: CreateFixture = { requests: [], statuses: [] };
	await installCreateFixture(page, fixture);
	await page.goto(STORY_URL);
	const dialog = page.getByRole("dialog", { name: "New channel bot" });
	await page.getByRole("button", { name: "Paste a token" }).click();
	await dialog.getByLabel("Name", { exact: true }).fill("Research bot");
	await dialog.getByLabel("Bot token", { exact: true }).fill("agent-token");
	await dialog.getByLabel("Routes to").selectOption("agent-support");
	await page.getByRole("button", { name: "Create bot" }).click();
	await expect.poll(() => fixture.requests.length).toBe(1);
	expect(fixture.requests[0]).toEqual({
		agentId: "agent-support",
		channelType: "telegram",
		enabled: false,
		groupReplyMode: "mentions",
		model: null,
		name: "Research bot",
		proactiveOpening: false,
		proactiveTarget: null,
		reactionLearning: {
			allowGroup: false,
			enabled: false,
			negativeEmoji: ["👎"],
			positiveEmoji: ["👍"],
		},
		secrets: { bot_token: "agent-token" },
		systemPrompt: null,
		teamId: null,
	});
	await expect(dialog).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "agent-binding-created.png"),
	});
});

test("hold the create action disabled until the local create request resolves", async ({
	page,
}) => {
	const deferredResponse = createDeferredResponse();
	const fixture: CreateFixture = {
		deferredResponse,
		requests: [],
		statuses: [],
	};
	await installCreateFixture(page, fixture);
	await page.goto(STORY_URL);
	const dialog = page.getByRole("dialog", { name: "New channel bot" });
	await page.getByRole("button", { name: "Paste a token" }).click();
	await dialog.getByLabel("Name", { exact: true }).fill("Pending bot");
	await dialog.getByLabel("Bot token", { exact: true }).fill("pending-token");
	await page.getByRole("button", { name: "Create bot" }).click();
	await deferredResponse.started;

	const create = page.getByRole("button", { name: "Create bot" });
	await expect(create).toBeDisabled();
	await expect.poll(() => fixture.requests.length).toBe(1);
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "create-pending-disabled.png"),
	});

	deferredResponse.release();
	await expect(dialog).toHaveCount(0);
	await expect.poll(() => fixture.requests.length).toBe(1);
});
