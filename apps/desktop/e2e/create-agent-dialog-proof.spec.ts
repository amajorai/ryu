import { expect, test } from "@playwright/test";
import { z } from "zod";
import type { CreateAgentProofApi } from "./harness/create-agent-dialog-proof.tsx";

const STORY_URL = "/create-agent-dialog-proof.html?reset=true";

interface AgentInputBody {
	chat_model: { engine: string | null; model_id: string | null };
	description: string | null;
	engine: string | null;
	identity_mode: "individual" | "managed" | "mixed";
	model: string | null;
	name: string;
	persona: {
		avatar_style: null;
		avatar_url: string | null;
		dicebear: null;
		dither: { direction: string; from: string; to: string | null };
		emoji: null;
		expressive: null;
		icon: null;
		icon_color: null;
		tone: null;
		display_name: null;
	};
	system_prompt: string | null;
	title: string;
	tools: string[];
}

async function proofSnapshot(page: import("@playwright/test").Page) {
	return await page.evaluate(() =>
		/* SAFETY: create-agent-dialog-proof.tsx installs __createAgentDialogProof before this proof page is evaluated. */ (
			window as Window & {
				__createAgentDialogProof: CreateAgentProofApi;
			}
		).__createAgentDialogProof.snapshot()
	);
}

type ProofPage = import("@playwright/test").Page;

const IDENTITY_STEP = "How should this agent work?";
const IDENTITY_CARDS = ["Acts as you", "Its own identity", "Both"] as const;

/** The identity question every "New agent" opens on. */
function identityStep(page: ProofPage) {
	return page.getByRole("dialog", { name: IDENTITY_STEP });
}

/**
 * Asserts the identity step shows the three cards with Acts as you chosen,
 * picks `mode` when given, and continues to the "New agent" details step.
 */
async function continuePastIdentity(
	page: ProofPage,
	mode?: (typeof IDENTITY_CARDS)[number]
) {
	const step = identityStep(page);
	await expect(step).toBeVisible();
	await expect(step.getByRole("radio")).toHaveCount(IDENTITY_CARDS.length);
	for (const title of IDENTITY_CARDS) {
		await expect(
			step.getByRole("radio", { name: new RegExp(`^${title}`) })
		).toHaveAttribute(
			"aria-checked",
			title === "Acts as you" ? "true" : "false"
		);
	}
	if (mode) {
		const card = step.getByRole("radio", { name: new RegExp(`^${mode}`) });
		await card.click();
		await expect(card).toHaveAttribute("aria-checked", "true");
	}
	await step.getByRole("button", { name: "Continue" }).click();
	await expect(step).toBeHidden();
	const details = page.getByRole("dialog", { name: "New agent" });
	await expect(details).toBeVisible();
	return details;
}

async function openDialog(
	page: ProofPage,
	mode?: (typeof IDENTITY_CARDS)[number]
) {
	const bootErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			bootErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => bootErrors.push(error.message));
	await page.goto(STORY_URL, { waitUntil: "commit", timeout: 120_000 });
	await page
		.waitForFunction(() => document.body.dataset.harnessReady === "1", null, {
			timeout: 30_000,
		})
		.catch(async () => {
			throw new Error(
				`CreateAgentDialog harness did not boot: ${JSON.stringify({
					body: await page.locator("body").innerText(),
					bootErrors,
				})}`
			);
		});
	return await continuePastIdentity(page, mode);
}

test("creates an agent with the saved profile and exact navigation handoff", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	const externalRequests: string[] = [];
	const failedRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.origin !== "http://127.0.0.1:5187"
		) {
			externalRequests.push(request.url());
		}
	});
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("requestfailed", (request) => {
		failedRequests.push(`${request.url()} :: ${request.failure()?.errorText}`);
	});

	const dialog = await openDialog(page);
	await expect(dialog).toBeVisible();
	const nameInput = dialog.getByRole("textbox", { name: "Name" });
	const titleInput = dialog.getByRole("textbox", { name: "Title badge" });
	const instructions = dialog.locator(
		'[data-testid="agent-setup-composer"] [contenteditable="true"]'
	);
	await expect(
		dialog.getByRole("button", {
			name: "Generate a name from the agent instructions",
		})
	).toBeDisabled();

	await titleInput.fill("Operations lead");
	await instructions.fill("Build release evidence, then summarize blockers.");
	await expect(
		dialog.getByRole("button", {
			name: "Generate a name from the agent instructions",
		})
	).toBeEnabled();
	await dialog
		.getByRole("button", {
			name: "Generate a name from the agent instructions",
		})
		.click();
	await expect(nameInput).toHaveValue("Orbit");

	await dialog.getByRole("button", { name: "Set icon" }).click();
	const avatarDialog = page
		.getByRole("dialog")
		.filter({ hasText: "Agent avatar" });
	await avatarDialog.getByRole("tab", { name: "Dither" }).click();
	await avatarDialog
		.getByRole("button", { name: "purple", exact: true })
		.click();
	await avatarDialog.getByRole("button", { name: "Down" }).click();
	await avatarDialog.getByRole("button", { name: "Use gradient" }).click();
	await expect(avatarDialog).toBeHidden();
	await expect(dialog).toBeVisible();

	const telegram = dialog.getByRole("switch", {
		name: "Set up Telegram after creation",
	});
	const discord = dialog.getByRole("switch", {
		name: "Set up Discord after creation",
	});
	const whatsapp = dialog.getByRole("switch", {
		name: "Set up WhatsApp Business (Cloud API) after creation",
	});
	await expect(telegram).toHaveAttribute("aria-checked", "true");
	await telegram.click();
	await expect(dialog).toBeVisible();
	await discord.click();
	await expect(dialog).toBeVisible();
	await whatsapp.click();
	await expect(telegram).toHaveAttribute("aria-checked", "false");
	await expect(discord).toHaveAttribute("aria-checked", "true");
	await expect(whatsapp).toHaveAttribute("aria-checked", "true");
	await expect(
		dialog.getByRole("button", { name: "Choose provider and model" })
	).toHaveAttribute("title", "Proof Model");

	await dialog.evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect(
		dialog.getByRole("heading", { name: "New agent" })
	).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath("desktop-create-agent-dialog-filled.png"),
		fullPage: false,
	});
	const advancedSetup = dialog.getByRole("button", { name: "Advanced setup" });
	await advancedSetup.scrollIntoViewIfNeeded();
	const actionBounds = await advancedSetup.boundingBox();
	const viewport = page.viewportSize();
	if (!(actionBounds && viewport)) {
		throw new Error(
			"Expected the advanced setup action to have visible bounds."
		);
	}
	expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(
		viewport.height
	);
	await page.screenshot({
		path: test.info().outputPath("desktop-create-agent-dialog-actions.png"),
		fullPage: false,
	});
	await advancedSetup.click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("Dialog closed")).toBeVisible();
	await expect(page.getByTestId("channel-request")).toContainText(
		'"channelType": "discord"'
	);
	await expect(page.getByTestId("channel-request")).toContainText(
		'"agentId": "proof-agent-1"'
	);

	const { persisted, requests, tabs } = await proofSnapshot(page);
	const createRequests = requests.filter(
		(request) => request.path === "/api/agents" && request.method === "POST"
	);
	expect(createRequests).toHaveLength(1);
	const nameGenerationRequests = requests.filter(
		(request) =>
			request.path === "/api/chat/stream" && request.method === "POST"
	);
	expect(nameGenerationRequests).toHaveLength(1);
	const generationBody = z
		.object({
			agent_id: z.string(),
			conversation_id: z.string(),
			enable_long_term: z.boolean(),
			messages: z.array(z.object({ content: z.string(), role: z.string() })),
			persist: z.boolean(),
		})
		.parse(nameGenerationRequests[0].body);
	expect(generationBody.agent_id).toBe("ryu");
	expect(generationBody.conversation_id).toMatch(
		/^agent-name-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
	);
	expect(generationBody).toMatchObject({
		enable_long_term: false,
		messages: [
			{
				content: [
					"Choose a name for a new Ryu agent.",
					"Return exactly one common English human first name, with no quotes, punctuation, explanation, or role title.",
					"Use the agent's purpose as a light hint, but keep the result a human first name.",
					"Role badge: Operations lead",
					"Instructions: Build release evidence, then summarize blockers.",
				].join("\n"),
				role: "user",
			},
		],
		persist: false,
	});
	const expectedBody: AgentInputBody = {
		chat_model: { engine: null, model_id: "proof-model" },
		description: null,
		engine: "acp:pi",
		identity_mode: "managed",
		model: "proof-model",
		name: "Orbit",
		persona: {
			avatar_style: null,
			avatar_url: null,
			dicebear: null,
			dither: { direction: "down", from: "purple", to: null },
			display_name: null,
			emoji: null,
			expressive: null,
			icon: null,
			icon_color: null,
			tone: null,
		},
		system_prompt: "Build release evidence, then summarize blockers.",
		title: "Operations lead",
		tools: ["__ryu_none__"],
	};
	expect(createRequests[0].body).toEqual(expectedBody);
	expect(persisted).toEqual([
		{ id: "proof-agent-1", input: expect.any(Object) },
	]);
	expect(tabs).toEqual([
		{ path: "/agents/proof-agent-1/edit", options: { title: "Orbit" } },
		{
			path: "/chat",
			options: {
				forceNew: true,
				initialAgent: "proof-agent-1",
				initialPrompt:
					"Introduce yourself to me as Orbit. Briefly explain what you can help with based on your setup, then ask what I would like to work on first. Keep the welcome concise and friendly.",
				initialSubmit: true,
				title: "Orbit chat",
			},
		},
	]);
	await expect(page.getByText(/Discord setup is ready/)).toBeVisible();

	await page.reload({ waitUntil: "domcontentloaded" });
	const reopenedDialog = identityStep(page);
	await expect(reopenedDialog).toBeVisible();
	await expect(page.getByTestId("agent-roster-readback")).toContainText(
		"Orbit"
	);
	const readback = await proofSnapshot(page);
	expect(
		readback.requests.some(
			(request) => request.path === "/api/agents" && request.method === "GET"
		)
	).toBe(true);
	expect(browserErrors).toEqual([]);
	expect(failedRequests).toEqual([]);
	expect(externalRequests).toEqual([]);
});

test("falls back to another common name when the local name-generation request fails", async ({
	page,
}) => {
	const dialog = await openDialog(page);
	const name = dialog.getByRole("textbox", { name: "Name" });
	const title = dialog.getByRole("textbox", { name: "Title badge" });
	const instructions = dialog.locator(
		'[data-testid="agent-setup-composer"] [contenteditable="true"]'
	);
	const previousName = await name.inputValue();
	await title.fill("Incident lead");
	await instructions.fill("Triage the incident and list the recovery steps.");
	await page.evaluate(() => {
		/* SAFETY: create-agent-dialog-proof.tsx installs __createAgentDialogProof before this proof page is evaluated. */ (
			window as Window & {
				__createAgentDialogProof: { armFailure: (operation: "stream") => void };
			}
		).__createAgentDialogProof.armFailure("stream");
	});
	await dialog
		.getByRole("button", {
			name: "Generate a name from the agent instructions",
		})
		.click();
	await expect(name).not.toHaveValue(previousName);
	await expect(name).toHaveValue(/^[A-Z][a-z]{1,31}$/);
	await expect(title).toHaveValue("Incident lead");
	await expect(
		dialog.getByText("Triage the incident and list the recovery steps.", {
			exact: true,
		})
	).toBeVisible();

	const { requests } = await proofSnapshot(page);
	const generationRequests = requests.filter(
		(request) =>
			request.path === "/api/chat/stream" && request.method === "POST"
	);
	expect(generationRequests).toHaveLength(1);
	expect(generationRequests[0].body).toMatchObject({
		agent_id: "ryu",
		enable_long_term: false,
		messages: [
			{
				content: [
					"Choose a name for a new Ryu agent.",
					"Return exactly one common English human first name, with no quotes, punctuation, explanation, or role title.",
					"Use the agent's purpose as a light hint, but keep the result a human first name.",
					"Role badge: Incident lead",
					"Instructions: Triage the incident and list the recovery steps.",
				].join("\n"),
				role: "user",
			},
		],
		persist: false,
	});
	expect(
		requests.filter(
			(request) => request.path === "/api/agents" && request.method === "POST"
		)
	).toHaveLength(0);
});

test("retains an agent draft after a local create failure and saves it on retry", async ({
	page,
}) => {
	const dialog = await openDialog(page);
	const name = dialog.getByRole("textbox", { name: "Name" });
	const title = dialog.getByRole("textbox", { name: "Title badge" });
	const instructions = dialog.locator(
		'[data-testid="agent-setup-composer"] [contenteditable="true"]'
	);
	await name.fill("Retry agent");
	await title.fill("Recovery owner");
	await instructions.fill("Keep the original draft while retrying.");
	await page.evaluate(() => {
		/* SAFETY: create-agent-dialog-proof.tsx installs __createAgentDialogProof before this proof page is evaluated. */ (
			window as Window & {
				__createAgentDialogProof: { armFailure: (operation: "create") => void };
			}
		).__createAgentDialogProof.armFailure("create");
	});

	await dialog.getByRole("button", { name: "Create agent" }).click();
	await expect(page.getByText("Couldn't create that agent")).toBeVisible();
	await expect(name).toHaveValue("Retry agent");
	await expect(title).toHaveValue("Recovery owner");
	await expect(
		dialog.getByText("Keep the original draft while retrying.", { exact: true })
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Create agent" })
	).toBeEnabled();

	await dialog.getByRole("button", { name: "Create agent" }).click();
	await expect(dialog).toBeHidden();
	const { persisted, requests } = await proofSnapshot(page);
	const attempts = requests.filter(
		(request) => request.path === "/api/agents" && request.method === "POST"
	);
	expect(attempts).toHaveLength(2);
	expect(attempts[0].body).toEqual(attempts[1].body);
	expect(persisted).toEqual([
		{
			id: "proof-agent-1",
			input: expect.objectContaining({ name: "Retry agent" }),
		},
	]);
});

test("keeps the draft on Escape, rerolls to another common name, and blocks blank names", async ({
	page,
}) => {
	const dialog = await openDialog(page);
	const name = dialog.getByRole("textbox", { name: "Name" });
	const title = dialog.getByRole("textbox", { name: "Title badge" });
	const instructions = dialog.locator(
		'[data-testid="agent-setup-composer"] [contenteditable="true"]'
	);
	const beforeReroll = await name.inputValue();
	await dialog.getByRole("button", { name: "Pick another name" }).click();
	await expect(name).not.toHaveValue(beforeReroll);
	await expect(name).toHaveAttribute("maxlength", "64");
	await expect(title).toHaveAttribute("maxlength", "48");

	await name.fill("   ");
	await expect(
		dialog.getByRole("button", { name: "Create agent" })
	).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Advanced setup" })
	).toBeDisabled();
	await expect(
		page.getByTestId("dialog-state").filter({ hasText: "Dialog open" })
	).toBeVisible();
	let snapshot = await proofSnapshot(page);
	expect(
		snapshot.requests.filter(
			(request) => request.path === "/api/agents" && request.method === "POST"
		)
	).toHaveLength(0);

	await name.fill("Draft survives close");
	await title.fill("Incident response");
	await instructions.fill("Preserve this text when the dialog is dismissed.");
	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();
	await page.getByRole("button", { name: "Open create dialog" }).click();
	const reopened = await continuePastIdentity(page);
	await expect(reopened.getByRole("textbox", { name: "Name" })).toHaveValue(
		"Draft survives close"
	);
	await expect(
		reopened.getByRole("textbox", { name: "Title badge" })
	).toHaveValue("Incident response");
	await expect(
		reopened.locator(
			'[data-testid="agent-setup-composer"] [contenteditable="true"]'
		)
	).toContainText("Preserve this text when the dialog is dismissed.");
	await reopened.press("Escape");
	await expect(reopened).toBeHidden();
	await page.getByRole("button", { name: "Open create dialog" }).click();
	await expect(
		(await continuePastIdentity(page)).getByRole("textbox", { name: "Name" })
	).toHaveValue("Draft survives close");
	snapshot = await proofSnapshot(page);
	expect(
		snapshot.requests.filter(
			(request) => request.path === "/api/agents" && request.method === "POST"
		)
	).toHaveLength(0);
});

test("locks creation controls while the local save is pending and sends one write", async ({
	page,
}) => {
	const dialog = await openDialog(page);
	await dialog.getByRole("textbox", { name: "Name" }).fill("Pending save");
	await dialog
		.locator('[data-testid="agent-setup-composer"] [contenteditable="true"]')
		.fill("Do not submit duplicate records.");
	await page.evaluate(() => {
		/* SAFETY: create-agent-dialog-proof.tsx installs __createAgentDialogProof before this proof page is evaluated. */ (
			window as Window & {
				__createAgentDialogProof: { armPendingCreate: () => void };
			}
		).__createAgentDialogProof.armPendingCreate();
	});
	await dialog.getByRole("button", { name: "Create agent" }).click();
	await expect(dialog.getByRole("textbox", { name: "Name" })).toBeDisabled();
	await expect(
		dialog.getByRole("switch", { name: "Set up Telegram after creation" })
	).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Advanced setup" })
	).toBeDisabled();
	const pending = await proofSnapshot(page);
	expect(
		pending.requests.filter(
			(request) => request.path === "/api/agents" && request.method === "POST"
		)
	).toHaveLength(1);

	await page.evaluate(() => {
		/* SAFETY: create-agent-dialog-proof.tsx installs __createAgentDialogProof before this proof page is evaluated. */ (
			window as Window & {
				__createAgentDialogProof: { releasePendingCreate: () => void };
			}
		).__createAgentDialogProof.releasePendingCreate();
	});
	await expect(dialog).toBeHidden();
	const done = await proofSnapshot(page);
	expect(done.persisted).toHaveLength(1);
	expect(
		done.requests.filter(
			(request) => request.path === "/api/agents" && request.method === "POST"
		)
	).toHaveLength(1);
});

test("saves the identity chosen on the first step and checks the launch for it", async ({
	page,
}) => {
	const dialog = await openDialog(page, "Its own identity");
	await expect(
		dialog.getByText("Its own identity", { exact: true })
	).toBeVisible();
	await dialog.getByRole("textbox", { name: "Name" }).fill("Solo");
	await dialog
		.locator('[data-testid="agent-setup-composer"] [contenteditable="true"]')
		.fill("Work only with your own accounts.");

	// Back and Change both return to the question with the choice kept.
	await dialog.getByRole("button", { name: "Change" }).click();
	await expect(
		identityStep(page).getByRole("radio", { name: /^Its own identity/ })
	).toHaveAttribute("aria-checked", "true");
	await identityStep(page).getByRole("button", { name: "Continue" }).click();

	const details = page.getByRole("dialog", { name: "New agent" });
	await expect(details.getByRole("textbox", { name: "Name" })).toHaveValue(
		"Solo"
	);
	await expect(
		details.getByRole("button", { name: "Create agent" })
	).toBeEnabled();
	await details.getByRole("button", { name: "Create agent" }).click();
	await expect(details).toBeHidden();

	const { persisted, requests } = await proofSnapshot(page);
	const launchChecks = requests.filter(
		(request) =>
			request.path === "/api/agents/launch-check" && request.method === "POST"
	);
	expect(launchChecks.at(-1)?.body).toEqual({
		account_access: null,
		engine: "acp:pi",
		identity_mode: "individual",
	});
	const createRequests = requests.filter(
		(request) => request.path === "/api/agents" && request.method === "POST"
	);
	expect(createRequests).toHaveLength(1);
	expect(createRequests[0].body).toMatchObject({
		identity_mode: "individual",
		name: "Solo",
	});
	expect(createRequests[0].body).not.toHaveProperty("account_access");
	expect(persisted).toEqual([
		{
			id: "proof-agent-1",
			input: expect.objectContaining({ identity_mode: "individual" }),
		},
	]);
});
