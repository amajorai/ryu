import path from "node:path";
import { expect, test } from "@playwright/test";
import type { PluginDocument } from "../src/lib/api/plugin-wire-values.ts";

interface CapturedRequest {
	authorization: string | null;
	body: PluginDocument | null;
	method: string;
	path: string;
}

interface Delivery {
	emails: string[];
	targets: {
		bot_token?: string;
		chat_id?: string;
		kind: "email" | "expo_push" | "telegram" | "webhook";
		token?: string;
		to?: string;
		url?: string;
	}[];
}

interface ProofSnapshot {
	calls: CapturedRequest[];
	delivery: Delivery;
	transport: {
		from: string;
		host: string;
		passwordSet: boolean;
		port: number;
		starttls: boolean;
		username: string;
	};
}

interface ProofWindow extends Window {
	__EMAIL_ALERTS_PROOF__?: {
		fail: (
			key: string,
			failure: { message: string; remaining: number; status: number }
		) => void;
		hold: (key: string) => void;
		release: (key: string) => void;
		snapshot: () => ProofSnapshot;
	};
}

const NON_WEBHOOK_TARGETS: Delivery["targets"] = [
	{ kind: "telegram", bot_token: "proof-bot-token", chat_id: "channel-7" },
	{ kind: "expo_push", token: "ExponentPushToken[proof]" },
	{ kind: "email", to: "legacy@example.com" },
];

// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
function evidencePath(name: string): string {
	if (process.env.RYU_PROOF_OUTPUT_ROOT) {
		return path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT, `${name}.png`);
	}
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function openProof(
	page: import("@playwright/test").Page,
	query = ""
): Promise<void> {
	await page.goto(`/email-alerts-settings-proof.html${query}`, {
		waitUntil: "domcontentloaded",
	});
	if (!query.includes("managed")) {
		await expect(
			page.getByRole("heading", { name: "SMTP transport", exact: true })
		).toBeVisible();
	}
}

async function proofState(
	page: import("@playwright/test").Page
): Promise<ProofSnapshot> {
	const snapshot = await page.evaluate(
		() =>
			/* SAFETY: email-alerts-settings-proof.mock.ts installs __EMAIL_ALERTS_PROOF__ before this proof page is evaluated. */ (
				window as ProofWindow
			).__EMAIL_ALERTS_PROOF__?.snapshot() ?? null
	);
	if (!snapshot) {
		throw new Error("Email and alerts proof fixture was not installed");
	}
	return snapshot;
}

async function failOnce(
	page: import("@playwright/test").Page,
	key: string,
	message: string,
	status: number
): Promise<void> {
	await page.evaluate(
		({ requestKey, errorMessage, errorStatus }) => {
			/* SAFETY: email-alerts-settings-proof.mock.ts installs __EMAIL_ALERTS_PROOF__ before this proof page is evaluated. */ (
				window as ProofWindow
			).__EMAIL_ALERTS_PROOF__?.fail(requestKey, {
				message: errorMessage,
				remaining: 1,
				status: errorStatus,
			});
		},
		{ requestKey: key, errorMessage: message, errorStatus: status }
	);
}

async function release(
	page: import("@playwright/test").Page,
	key: string
): Promise<void> {
	await page.evaluate(
		(requestKey) =>
			/* SAFETY: email-alerts-settings-proof.mock.ts installs __EMAIL_ALERTS_PROOF__ before this proof page is evaluated. */ (
				window as ProofWindow
			).__EMAIL_ALERTS_PROOF__?.release(requestKey),
		key
	);
}

async function expectDelivery(
	page: import("@playwright/test").Page,
	expected: Delivery
): Promise<void> {
	await expect
		.poll(async () => (await proofState(page)).delivery)
		.toEqual(expected);
}

async function expectDeliveryPutCount(
	page: import("@playwright/test").Page,
	count: number
): Promise<void> {
	await expect
		.poll(
			async () =>
				(await proofState(page)).calls.filter(
					(call) =>
						call.method === "PUT" && call.path === "/api/alerts/delivery"
				).length
		)
		.toBe(count);
}

test.describe.configure({ timeout: 90_000 });

test("SMTP loading disables edits; failed save retains the draft and retry persists the exact transport", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openProof(page, "?holdEmailLoad&holdEmailSave");

	const host = page.getByLabel("SMTP host");
	const save = page.getByRole("button", { name: "Save", exact: true });
	const sendTest = page.getByRole("button", { name: "Send test" });
	await expect(host).toBeDisabled();
	await expect(save).toBeDisabled();
	await expect(sendTest).toBeDisabled();
	await release(page, "GET /api/email/transport");
	await expect(host).toHaveValue("smtp.initial.example.com");
	await expect(save).toBeEnabled();
	await expect(
		page.getByText("A password is stored. Leave blank to keep it.")
	).toBeVisible();
	await expect(page.getByLabel("Password")).toHaveValue("");

	await failOnce(
		page,
		"PUT /api/email/transport",
		"Proof preference store is temporarily unavailable.",
		503
	);
	await host.fill(" smtp.relay.example ");
	await page.getByLabel("Port").fill("not-a-port");
	await page.getByRole("switch", { name: "STARTTLS" }).click();
	await page.getByLabel("Username").fill(" relay-ops ");
	await page.getByLabel("Password").fill(" new-secret ");
	await page.getByLabel("From address").fill(" Ops <ops@example.com> ");
	await save.click();
	await expect(
		page.getByText("Couldn't save SMTP settings", { exact: true })
	).toBeVisible();
	await expect(save).toBeEnabled();
	await expect(host).toHaveValue(" smtp.relay.example ");

	await save.click();
	await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
	await expect(sendTest).toBeDisabled();
	await release(page, "PUT /api/email/transport");
	await expect(
		page.getByText("SMTP settings saved", { exact: true })
	).toBeVisible();
	const expectedTransport = {
		from: "Ops <ops@example.com>",
		host: "smtp.relay.example",
		password: " new-secret ",
		port: 2525,
		starttls: false,
		username: "relay-ops",
	};
	const afterSave = await proofState(page);
	const transportPuts = afterSave.calls.filter(
		(call) => call.method === "PUT" && call.path === "/api/email/transport"
	);
	expect(transportPuts.map((call) => call.body)).toEqual([
		expectedTransport,
		expectedTransport,
	]);
	expect(transportPuts.map((call) => call.authorization)).toEqual([
		"Bearer email-alerts-proof-token",
		"Bearer email-alerts-proof-token",
	]);

	await page.reload();
	await expect(page.getByLabel("SMTP host")).toHaveValue("smtp.relay.example");
	await expect(page.getByLabel("Port")).toHaveValue("2525");
	await expect(
		page.getByRole("switch", { name: "STARTTLS" })
	).not.toBeChecked();
	await expect(page.getByLabel("Username")).toHaveValue("relay-ops");
	await expect(page.getByLabel("Password")).toHaveValue("");
	await expect(
		page.getByText("A password is stored. Leave blank to keep it.")
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-email-alerts-smtp-persisted"),
	});
	expect(pageErrors).toEqual([]);
});

test("test-send requires a recipient, saves unsaved transport first, and exposes relay failure for retry", async ({
	page,
}) => {
	await openProof(page, "?holdEmailTest");
	const sendTest = page.getByRole("button", { name: "Send test" });
	await expect(page.getByLabel("SMTP host")).toHaveValue(
		"smtp.initial.example.com"
	);
	await sendTest.click();
	await expect(
		page.getByText("Enter a recipient for the test email", { exact: true })
	).toBeVisible();
	expect(
		(await proofState(page)).calls.filter(
			(call) => call.method === "POST" && call.path === "/api/email/test"
		)
	).toHaveLength(0);

	await page.getByLabel("SMTP host").fill("smtp.test.example.com");
	await page.getByLabel("Password").fill("test-relay-secret");
	await page.getByLabel("Send a test email").fill(" recipient@example.com ");
	await failOnce(
		page,
		"POST /api/email/test",
		"SMTP relay rejected the message.",
		502
	);
	await sendTest.click();
	await expect(
		page.getByText("Test email failed", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("SMTP relay rejected the message.", { exact: true })
	).toBeVisible();
	await expect(page.getByLabel("SMTP host")).toHaveValue(
		"smtp.test.example.com"
	);
	await expect(page.getByLabel("Password")).toHaveValue("");
	await sendTest.click();
	await expect(page.getByRole("button", { name: "Sending…" })).toBeDisabled();
	await release(page, "POST /api/email/test");
	await expect(
		page.getByText("Test email sent", { exact: true })
	).toBeVisible();

	const calls = (await proofState(page)).calls.filter((call) =>
		["/api/email/transport", "/api/email/test"].includes(call.path)
	);
	expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"GET /api/email/transport",
		"PUT /api/email/transport",
		"POST /api/email/test",
		"PUT /api/email/transport",
		"POST /api/email/test",
	]);
	expect(calls[1]?.body).toEqual({
		from: "Ryu <alerts@example.com>",
		host: "smtp.test.example.com",
		password: "test-relay-secret",
		port: 2525,
		starttls: true,
		username: "relay-user",
	});
	expect(calls[2]?.body).toEqual({ to: "recipient@example.com" });
	expect(calls[3]?.body).toEqual({
		from: "Ryu <alerts@example.com>",
		host: "smtp.test.example.com",
		port: 2525,
		starttls: true,
		username: "relay-user",
	});
	expect(calls[4]?.body).toEqual({ to: "recipient@example.com" });
	expect((await proofState(page)).transport.passwordSet).toBe(true);
});

test("recipient edits auto-save trimmed payloads, preserve other channels, and survive reload", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openProof(page);
	const emailOne = page.getByRole("textbox", { name: "Email recipient 1" });
	await expect(emailOne).toHaveValue("ops@example.com");
	await expect(
		page.getByRole("textbox", { name: "Webhook URL 1" })
	).toHaveValue("https://hooks.example.com/old");

	await emailOne.fill(" ops-team@example.com ");
	await emailOne.blur();
	const firstDelivery: Delivery = {
		emails: ["ops-team@example.com", "finance@example.com"],
		targets: [
			{ kind: "webhook", url: "https://hooks.example.com/old" },
			...NON_WEBHOOK_TARGETS,
		],
	};
	await expectDeliveryPutCount(page, 1);
	await expectDelivery(page, firstDelivery);

	await page.getByRole("button", { name: "Add email" }).click();
	const emailThree = page.getByRole("textbox", { name: "Email recipient 3" });
	await emailThree.fill(" billing@example.com ");
	await emailThree.blur();
	const secondDelivery: Delivery = {
		...firstDelivery,
		emails: [
			"ops-team@example.com",
			"finance@example.com",
			"billing@example.com",
		],
	};
	await expectDeliveryPutCount(page, 2);
	await expectDelivery(page, secondDelivery);

	await page.getByRole("button", { name: "Remove email recipient 2" }).click();
	const thirdDelivery: Delivery = {
		...secondDelivery,
		emails: ["ops-team@example.com", "billing@example.com"],
	};
	await expectDeliveryPutCount(page, 3);
	await expectDelivery(page, thirdDelivery);

	const webhookOne = page.getByRole("textbox", { name: "Webhook URL 1" });
	await webhookOne.fill(" https://hooks.example.com/new ");
	await webhookOne.blur();
	const fourthDelivery: Delivery = {
		...thirdDelivery,
		targets: [
			{ kind: "webhook", url: "https://hooks.example.com/new" },
			...NON_WEBHOOK_TARGETS,
		],
	};
	await expectDeliveryPutCount(page, 4);
	await expectDelivery(page, fourthDelivery);

	await page.getByRole("button", { name: "Add webhook" }).click();
	const webhookTwo = page.getByRole("textbox", { name: "Webhook URL 2" });
	await webhookTwo.fill(" https://hooks.example.com/backup ");
	await webhookTwo.blur();
	const fifthDelivery: Delivery = {
		...thirdDelivery,
		targets: [
			{ kind: "webhook", url: "https://hooks.example.com/new" },
			{ kind: "webhook", url: "https://hooks.example.com/backup" },
			...NON_WEBHOOK_TARGETS,
		],
	};
	await expectDeliveryPutCount(page, 5);
	await expectDelivery(page, fifthDelivery);

	await page.getByRole("button", { name: "Remove webhook URL 1" }).click();
	const finalDelivery: Delivery = {
		...thirdDelivery,
		targets: [
			{ kind: "webhook", url: "https://hooks.example.com/backup" },
			...NON_WEBHOOK_TARGETS,
		],
	};
	await expectDeliveryPutCount(page, 6);
	await expectDelivery(page, finalDelivery);
	const puts = (await proofState(page)).calls.filter(
		(call) => call.method === "PUT" && call.path === "/api/alerts/delivery"
	);
	expect(puts.map((call) => call.body)).toEqual([
		firstDelivery,
		secondDelivery,
		thirdDelivery,
		fourthDelivery,
		fifthDelivery,
		finalDelivery,
	]);
	expect(
		puts.every(
			(call) => call.authorization === "Bearer email-alerts-proof-token"
		)
	).toBe(true);

	await page.reload();
	await expect(
		page.getByRole("textbox", { name: "Email recipient 1" })
	).toHaveValue("ops-team@example.com");
	await expect(
		page.getByRole("textbox", { name: "Email recipient 2" })
	).toHaveValue("billing@example.com");
	await expect(
		page.getByRole("textbox", { name: "Webhook URL 1" })
	).toHaveValue("https://hooks.example.com/backup");
	await expect(
		page.getByRole("textbox", { name: "Webhook URL 2" })
	).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-email-alerts-delivery-persisted"),
	});
	expect(pageErrors).toEqual([]);
});

test("delivery save disables add while pending and failed writes keep the draft retryable", async ({
	page,
}) => {
	await openProof(page, "?holdDeliverySave");
	const email = page.getByRole("textbox", { name: "Email recipient 1" });
	await expect(email).toHaveValue("ops@example.com");
	await email.fill("ops-pending@example.com");
	await email.blur();
	await expect
		.poll(
			async () =>
				(await proofState(page)).calls.filter(
					(call) =>
						call.method === "PUT" && call.path === "/api/alerts/delivery"
				).length
		)
		.toBe(1);
	await expect(page.getByRole("button", { name: "Add email" })).toBeDisabled();
	await expectDelivery(page, {
		emails: ["ops@example.com", "finance@example.com"],
		targets: [
			{ kind: "webhook", url: "https://hooks.example.com/old" },
			...NON_WEBHOOK_TARGETS,
		],
	});
	await release(page, "PUT /api/alerts/delivery");
	const committedDelivery: Delivery = {
		emails: ["ops-pending@example.com", "finance@example.com"],
		targets: [
			{ kind: "webhook", url: "https://hooks.example.com/old" },
			...NON_WEBHOOK_TARGETS,
		],
	};
	await expectDelivery(page, committedDelivery);
	await expect(page.getByRole("button", { name: "Add email" })).toBeEnabled();

	await failOnce(
		page,
		"PUT /api/alerts/delivery",
		"Proof node rejected the recipient update.",
		503
	);
	await email.fill(" ops-retry@example.com ");
	await email.blur();
	await expect(
		page.getByText("Couldn't save alert recipients", { exact: true })
	).toBeVisible();
	await expect(email).toHaveValue(" ops-retry@example.com ");
	await expectDelivery(page, committedDelivery);
	await expect(page.getByRole("button", { name: "Add email" })).toBeEnabled();

	await email.focus();
	await email.blur();
	const retryDelivery: Delivery = {
		...committedDelivery,
		emails: ["ops-retry@example.com", "finance@example.com"],
	};
	await expectDeliveryPutCount(page, 3);
	await expectDelivery(page, retryDelivery);
	await page.reload();
	await expect(
		page.getByRole("textbox", { name: "Email recipient 1" })
	).toHaveValue("ops-retry@example.com");
});

test("failed initial transport load exposes Retry and reloads the node settings", async ({
	page,
}) => {
	await openProof(page, "?failEmailLoad");
	await expect(
		page.getByText("Couldn't load email settings", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByLabel("SMTP host")).toHaveValue(
		"smtp.initial.example.com"
	);
	const calls = (await proofState(page)).calls.filter(
		(call) => call.method === "GET" && call.path === "/api/email/transport"
	);
	expect(calls).toHaveLength(2);
	await expect(page.getByLabel("SMTP host")).toBeEnabled();
});

test("failed initial recipient load exposes Retry and restores the saved recipient list", async ({
	page,
}) => {
	await openProof(page, "?failDeliveryLoad");
	await expect(
		page.getByText("Couldn't load alert recipients", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add email", exact: true })
	).toHaveCount(0);

	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "Email recipient 1" })
	).toHaveValue("ops@example.com");
	await expect(
		page.getByRole("textbox", { name: "Webhook URL 1" })
	).toHaveValue("https://hooks.example.com/old");
	await expect(
		page.getByRole("button", { name: "Add email", exact: true })
	).toBeEnabled();

	const deliveryReads = (await proofState(page)).calls.filter(
		(call) => call.method === "GET" && call.path === "/api/alerts/delivery"
	);
	expect(deliveryReads).toEqual([
		{
			authorization: "Bearer email-alerts-proof-token",
			body: null,
			method: "GET",
			path: "/api/alerts/delivery",
		},
		{
			authorization: "Bearer email-alerts-proof-token",
			body: null,
			method: "GET",
			path: "/api/alerts/delivery",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-email-alerts-delivery-load-recovered"),
	});
});

test("managed node explains cloud ownership and never loads node-local SMTP or delivery routes", async ({
	page,
}) => {
	await openProof(page, "?managed");
	await expect(
		page.getByText(
			"Email transport and alert delivery are configured by Ryu Cloud for managed nodes.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(page.getByLabel("SMTP host")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Add email" })).toHaveCount(0);
	expect((await proofState(page)).calls).toEqual([]);
});
