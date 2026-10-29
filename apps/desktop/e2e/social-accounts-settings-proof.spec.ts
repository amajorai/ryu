import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
	Draft,
	DraftBody,
	ScheduledPost,
	SocialAccount,
} from "../../../apps-store/social/ui/src/types.ts";

const evidenceDirectory = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface SocialBridgeCall {
	body?: unknown;
	method?: string;
	path: string;
}

declare global {
	interface Window {
		__socialAccountsSettingsProof?: { calls: SocialBridgeCall[] };
	}
}

async function listAccounts(page: Page): Promise<SocialAccount[]> {
	const response = await page.request.get(
		"/__social/accounts?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.accounts;
}

async function readAccount(
	page: Page,
	accountId: string
): Promise<SocialAccount> {
	const response = await page.request.get(`/__social/accounts/${accountId}`);
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function createAccount(
	page: Page,
	input: {
		account_label: string;
		external_id?: string;
		platform: string;
		workspace_id?: string;
	}
): Promise<SocialAccount> {
	const response = await page.request.post("/__social/accounts", {
		data: input,
	});
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function createDraft(
	page: Page,
	accountId: string,
	text: string
): Promise<Draft> {
	const body: DraftBody = {
		account_ids: [accountId],
		media: [],
		schema_version: 2,
		segments: [{ media: [], text }],
		text,
	};
	const response = await page.request.post("/__social/drafts", {
		data: { body, workspace_id: "default" },
	});
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function createScheduledPost(
	page: Page,
	accountId: string,
	draftId: string,
	scheduledFor: number
): Promise<ScheduledPost> {
	const response = await page.request.post("/__social/posts", {
		data: {
			account_ids: [accountId],
			draft_id: draftId,
			scheduled_for: scheduledFor,
			workspace_id: "default",
		},
	});
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function bridgeCalls(page: Page): Promise<SocialBridgeCall[]> {
	return page.evaluate(() => window.__socialAccountsSettingsProof?.calls ?? []);
}

async function clearTransientToasts(page: Page) {
	await expect(page.getByRole("status")).toHaveCount(0);
}

async function clickAndObserveDisabled(button: Locator) {
	const disabledWhilePending = button.evaluate(
		(element) =>
			new Promise<boolean>((resolve) => {
				const target =
					/* SAFETY: The only callers pass the actual mounted AccountsSettings Add, Connect and Refresh native Button locators to this pending-state observer. Those authored controls use the default native button, whose disabled property is observed; no arbitrary Locator element is admitted. */ element as HTMLButtonElement;
				let observer: MutationObserver | null = null;
				let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
				const finish = (disabled: boolean) => {
					observer?.disconnect();
					if (timer !== undefined) {
						clearTimeout(timer);
					}
					resolve(disabled);
				};
				observer = new MutationObserver(() => {
					if (target.disabled) {
						finish(true);
					}
				});
				observer.observe(target, {
					attributes: true,
					attributeFilter: ["disabled"],
				});
				if (target.disabled) {
					finish(true);
					return;
				}
				timer = globalThis.setTimeout(() => finish(target.disabled), 1500);
			})
	);
	const click = button.click();
	const disabled = await disabledWhilePending;
	await click;
	return disabled;
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidenceDirectory, filename),
	});
}

function capabilityRow(page: Page, label: string) {
	return page.getByText(label, { exact: true }).locator("xpath=..");
}

function accountRow(page: Page, label: string) {
	return page.getByText(label, { exact: true }).locator("xpath=../..");
}

test("account setup preserves exact requests, exposes handshake state, and refreshes capabilities", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
	await expect(
		page.getByText("No accounts yet", { exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Add account", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Add an account" })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();

	await page
		.getByRole("button", { name: "Add an account", exact: true })
		.click();
	await expect(dialog).toBeVisible();
	const platformSelect = dialog.getByLabel("Platform", { exact: true });
	const labelInput = dialog.getByLabel("Label");
	const externalIdInput = dialog.getByLabel(/Platform id/);
	const addButton = dialog.getByRole("button", { name: "Add", exact: true });
	await expect(platformSelect).toHaveValue("x");
	await labelInput.fill("   ");
	await addButton.click();
	await expect(
		page.getByRole("alert").filter({ hasText: "An account needs a label" })
	).toBeVisible();
	expect(
		(await bridgeCalls(page)).filter(
			(call) => call.method === "POST" && call.path === "/accounts"
		)
	).toHaveLength(0);
	await expect(await listAccounts(page)).toHaveLength(0);

	await platformSelect.selectOption("instagram");
	await labelInput.fill("  @founder  ");
	await externalIdInput.fill("  ig-user-17  ");
	const expectedCreate = {
		account_label: "@founder",
		external_id: "ig-user-17",
		platform: "instagram",
		workspace_id: "default",
	};
	const failAccountCreate = await page.request.post(
		"/__proof/fail-next-account-create"
	);
	expect(failAccountCreate.ok()).toBe(true);
	expect(await clickAndObserveDisabled(addButton)).toBe(true);
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "Fixture rejected the first account write." })
	).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(labelInput).toHaveValue("  @founder  ");
	await expect(externalIdInput).toHaveValue("  ig-user-17  ");
	await expect(platformSelect).toHaveValue("instagram");
	await expect(await listAccounts(page)).toHaveLength(0);

	await addButton.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Account added" }).last()
	).toContainText("Connect it to run the provider handshake.");
	await expect(dialog).toBeHidden();
	await expect.poll(() => listAccounts(page)).toHaveLength(1);
	const [account] = await listAccounts(page);
	expect(account).toMatchObject({
		account_label: "@founder",
		connected: true,
		external_id: "ig-user-17",
		platform: "instagram",
		workspace_id: "default",
	});
	await expect(page.getByRole("img", { name: "Connected" })).toBeVisible();
	await expect(
		page.getByText("1 of 1 account connected.", { exact: true })
	).toBeVisible();
	const connectButton = page.getByRole("button", {
		name: "Reconnect",
		exact: true,
	});
	const callsBeforeHandshake = await bridgeCalls(page);
	const createCallsBeforeHandshake = callsBeforeHandshake.filter(
		(call) => call.method === "POST" && call.path === "/accounts"
	);
	expect(createCallsBeforeHandshake.map((call) => call.body)).toEqual([
		expectedCreate,
		expectedCreate,
	]);
	expect(
		callsBeforeHandshake.filter(
			(call) =>
				call.method === "POST" &&
				call.path === `/accounts/${account.id}/connect`
		)
	).toEqual([]);
	// This documents a real backend/UI mismatch: registration itself reports
	// connected=true, despite the Add dialog saying the provider handshake has not
	// happened yet. Keep the inventory partial until the satellite owner resolves it.
	await expect(
		page.getByRole("button", { name: "Connect", exact: true })
	).toHaveCount(0);
	await clearTransientToasts(page);
	await saveScreenshot(
		page,
		"social-accounts-settings-registration-before-handshake.png"
	);

	const failConnect = await page.request.post("/__proof/fail-next-connect");
	expect(failConnect.ok()).toBe(true);
	expect(await clickAndObserveDisabled(connectButton)).toBe(true);
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "Fixture rejected the first connect request." })
	).toBeVisible();
	expect(await readAccount(page, account.id)).toMatchObject({
		connected: true,
		external_id: "ig-user-17",
	});
	await expect(page.getByRole("img", { name: "Connected" })).toBeVisible();
	await expect(connectButton).toBeEnabled();
	await connectButton.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Connected" }).last()
	).toContainText("@founder");
	const connected = await readAccount(page, account.id);
	expect(connected).toMatchObject({
		connected: true,
		external_id: `fake_account_${account.id}`,
	});
	await expect(connectButton).toBeVisible();
	await connectButton.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Connected" }).last()
	).toContainText("@founder");
	expect(await readAccount(page, account.id)).toMatchObject({
		connected: true,
		external_id: `fake_account_${account.id}`,
	});

	await page.getByRole("button", { name: "Capabilities", exact: true }).click();
	await expect(
		page.getByText("What this account can do", { exact: true })
	).toBeVisible();
	await expect(capabilityRow(page, "Publish posts")).toContainText("Yes");
	await expect(capabilityRow(page, "Read comments and mentions")).toContainText(
		"Yes"
	);
	await expect(capabilityRow(page, "Read engagement counts")).toContainText(
		"Yes"
	);
	await expect(capabilityRow(page, "Read direct messages")).toContainText(
		"Yes"
	);
	await expect(capabilityRow(page, "Send direct messages")).toContainText(
		"Yes"
	);
	await expect(capabilityRow(page, "Provider-side scheduling")).toContainText(
		"No"
	);
	await expect(
		page.getByText("2,200 characters", { exact: true })
	).toBeVisible();

	const delayCapabilities = await page.request.post(
		"/__proof/delay-next-capability-read"
	);
	expect(delayCapabilities.ok()).toBe(true);
	const refresh = page.getByRole("button", { name: "Refresh", exact: true });
	expect(await clickAndObserveDisabled(refresh)).toBe(true);
	await expect(refresh).toBeEnabled();
	const calls = await bridgeCalls(page);
	const createCalls = calls.filter(
		(call) => call.method === "POST" && call.path === "/accounts"
	);
	expect(createCalls).toHaveLength(2);
	expect(createCalls.map((call) => call.body)).toEqual([
		expectedCreate,
		expectedCreate,
	]);
	const connectCalls = calls.filter(
		(call) =>
			call.method === "POST" && call.path === `/accounts/${account.id}/connect`
	);
	expect(connectCalls.map(({ method, path }) => [method, path])).toEqual([
		["POST", `/accounts/${account.id}/connect`],
		["POST", `/accounts/${account.id}/connect`],
		["POST", `/accounts/${account.id}/connect`],
	]);
	expect(connectCalls.every((call) => call.body === undefined)).toBe(true);
	const capabilityReads = calls.filter(
		(call) =>
			call.method === "GET" &&
			call.path === `/accounts/${account.id}/capabilities`
	);
	expect(capabilityReads).toHaveLength(2);

	await page
		.getByRole("button", { name: "Hide capabilities", exact: true })
		.click();
	await expect(
		page.getByText("What this account can do", { exact: true })
	).toBeHidden();
	await page.getByRole("button", { name: "Capabilities", exact: true }).click();
	await expect(
		page.getByText("What this account can do", { exact: true })
	).toBeVisible();
	await clearTransientToasts(page);
	await saveScreenshot(page, "social-accounts-settings-capabilities.png");
	const cleanup = await page.request.delete(`/__social/accounts/${account.id}`);
	expect(cleanup.ok()).toBe(true);
});

test("remove confirmation cancels cleanly, retries failures, and preserves queued target history", async ({
	page,
}) => {
	const account = await createAccount(page, {
		account_label: "@queued-owner",
		external_id: "instagram-user-42",
		platform: "instagram",
		workspace_id: "default",
	});
	const text = "Queued post survives removing its account row.";
	const draft = await createDraft(page, account.id, text);
	const scheduledAt = await page.evaluate(() => Date.now() + 86_400_000);
	const post = await createScheduledPost(
		page,
		account.id,
		draft.id,
		scheduledAt
	);
	expect(post.targets[0]).toMatchObject({
		platform: "instagram",
		social_account_id: account.id,
		status: "pending",
	});

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
	await expect(page.getByText("@queued-owner", { exact: true })).toBeVisible();
	const removeButton = accountRow(page, "@queued-owner").getByRole("button", {
		name: "Remove account",
		exact: true,
	});
	await removeButton.click();
	let confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("Remove “@queued-owner”?");
	await expect(confirmation).toContainText("There is no separate disconnect");
	await expect(confirmation).toContainText(
		"Posts already queued to this account keep their own copy of the platform and stay in the queue; they will fail when the runner cannot resolve the account"
	);
	await expect(confirmation).toContainText(
		"Nothing is changed on Instagram itself."
	);
	await clearTransientToasts(page);
	await saveScreenshot(
		page,
		"social-accounts-settings-remove-confirmation.png"
	);
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(confirmation).toBeHidden();
	expect(
		(await bridgeCalls(page)).filter(
			(call) =>
				call.method === "DELETE" && call.path === `/accounts/${account.id}`
		)
	).toHaveLength(0);
	expect((await readAccount(page, account.id)).id).toBe(account.id);

	await removeButton.click();
	confirmation = page.getByRole("alertdialog");
	const failDelete = await page.request.post("/__proof/fail-next-delete");
	expect(failDelete.ok()).toBe(true);
	await confirmation
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "Fixture rejected the first account removal." })
	).toBeVisible();
	await expect(removeButton).toBeEnabled();
	expect((await readAccount(page, account.id)).id).toBe(account.id);
	const preservedAfterFailure = await (async () => {
		const response = await page.request.get(`/__social/posts/${post.id}`);
		expect(response.ok()).toBe(true);
		// SAFETY: After the successful GET check, the private forwarding helper returns native ryu-social get_post output unchanged: the concrete Rust ScheduledPost with canonical attached targets. The imported UI wire type mirrors its complete serde fields/enums/nulls.
		return (await response.json()) as ScheduledPost;
	})();
	expect(preservedAfterFailure.targets[0]).toMatchObject({
		platform: "instagram",
		social_account_id: account.id,
		status: "pending",
	});

	await removeButton.click();
	confirmation = page.getByRole("alertdialog");
	await confirmation
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Account removed" }).last()
	).toContainText("Account removed");
	await expect(
		page.getByText("No accounts yet", { exact: true })
	).toBeVisible();
	const missingAccount = await page.request.get(
		`/__social/accounts/${account.id}`
	);
	expect(missingAccount.status()).toBe(404);
	const targetAfterRemoval = await page.request.get(
		`/__social/posts/${post.id}`
	);
	expect(targetAfterRemoval.ok()).toBe(true);
	// SAFETY: This successful GET is the same native get_post serializer after removal, with canonical updated targets. Account-removal error overrides do not replace this GET response; no arbitrary raw JSON shape is asserted.
	const postAfterRemoval = (await targetAfterRemoval.json()) as ScheduledPost;
	expect(postAfterRemoval.targets[0]).toMatchObject({
		platform: "instagram",
		social_account_id: account.id,
		status: "cancelled",
	});
	const deletes = (await bridgeCalls(page)).filter(
		(call) =>
			call.method === "DELETE" && call.path === `/accounts/${account.id}`
	);
	expect(deletes.map(({ method, path }) => [method, path])).toEqual([
		["DELETE", `/accounts/${account.id}`],
		["DELETE", `/accounts/${account.id}`],
	]);
	expect(deletes.every((call) => call.body === undefined)).toBe(true);
	await clearTransientToasts(page);
	await saveScreenshot(page, "social-accounts-settings-empty-after-remove.png");
});
