import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/private-package-share-create-proof.html";
const BASE_TIME = new Date("2026-09-28T00:00:00.000Z");
const EVIDENCE_ROOT = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence/private-package-share-create"
);

interface ApiCall {
	body: unknown;
	method: string;
	path: string;
}

interface ShareCodeRecord {
	id: string;
	revoked_at: string | null;
}

interface Fixture {
	failNextCreate: (message?: string) => void;
	failNextRevoke: (message?: string) => void;
	holdNextCreate: () => void;
	releaseCreate: () => void;
}

interface ProofWindow extends Window {
	__privatePackageShareCalls: ApiCall[];
	__privatePackageShareFixture: Fixture;
	__privatePackageShareRecords: ShareCodeRecord[];
}

async function calls(
	page: import("@playwright/test").Page
): Promise<ApiCall[]> {
	return page.evaluate(
		() =>
			/* SAFETY: private-package-share-create-proof.tsx installs __privatePackageShareCalls before this proof page is evaluated. */ (
				window as ProofWindow
			).__privatePackageShareCalls
	);
}

async function configureFixture(
	page: import("@playwright/test").Page,
	mode: "fail-create" | "fail-revoke" | "hold-create" | "release-create",
	message?: string
): Promise<void> {
	await page.evaluate(
		({ failureMessage, fixtureMode }) => {
			const localFixture =
				/* SAFETY: private-package-share-create-proof.tsx installs __privatePackageShareFixture before this proof page is evaluated. */ (
					window as ProofWindow
				).__privatePackageShareFixture;
			if (fixtureMode === "fail-create") {
				localFixture.failNextCreate(failureMessage);
			} else if (fixtureMode === "fail-revoke") {
				localFixture.failNextRevoke(failureMessage);
			} else if (fixtureMode === "hold-create") {
				localFixture.holdNextCreate();
			} else {
				localFixture.releaseCreate();
			}
		},
		{ failureMessage: message, fixtureMode: mode }
	);
}

async function records(
	page: import("@playwright/test").Page
): Promise<ShareCodeRecord[]> {
	return page.evaluate(
		() =>
			/* SAFETY: private-package-share-create-proof.tsx installs __privatePackageShareRecords before this proof page is evaluated. */ (
				window as ProofWindow
			).__privatePackageShareRecords
	);
}

async function capture(
	page: import("@playwright/test").Page,
	name: string
): Promise<void> {
	await mkdir(EVIDENCE_ROOT, { recursive: true });
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_ROOT, `${name}.png`),
	});
}

async function installClock(page: import("@playwright/test").Page) {
	await page.clock.install({ time: BASE_TIME });
	await page.clock.setFixedTime(BASE_TIME);
}

async function openDialog(page: import("@playwright/test").Page) {
	await page.goto(STORY_URL);
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	return dialog;
}

async function chooseOption(
	page: import("@playwright/test").Page,
	dialog: import("@playwright/test").Locator,
	label: string,
	optionName: string
): Promise<void> {
	await dialog.getByRole("combobox", { name: label }).click();
	await page.getByRole("option", { exact: true, name: optionName }).click();
}

async function fillValidOrganizationShare(
	dialog: import("@playwright/test").Locator
): Promise<void> {
	await dialog.getByLabel("Package id").fill("acme/private-skill");
	await dialog.getByLabel("Customer organization id").fill("org_customer_demo");
}

test.describe.configure({ timeout: 90_000 });

test("validates identifiers and numeric bounds before making any write", async ({
	page,
}) => {
	await installClock(page);
	const dialog = await openDialog(page);
	const createButton = dialog.getByRole("button", {
		name: /Create code/,
	});

	await createButton.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Enter the package id exactly as it appears in the Marketplace."
	);
	await dialog.getByLabel("Package id").fill("acme/private-skill");
	await createButton.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Enter the customer organization id, or choose Shareable access."
	);
	await dialog.getByLabel("Customer organization id").fill("org_customer_demo");

	const invalidValues = [
		{
			field: "Expires in (days)",
			value: "0",
			message: "Expiry must be between 1 and 90 days.",
		},
		{
			field: "Expires in (days)",
			value: "91",
			message: "Expiry must be between 1 and 90 days.",
		},
		{
			field: "Expires in (days)",
			value: "1.5",
			message: "Expiry must be between 1 and 90 days.",
		},
		{
			field: "Max redemptions",
			value: "0",
			message: "Redemptions must be a whole number from 1 to 1,000.",
		},
		{
			field: "Max redemptions",
			value: "1001",
			message: "Redemptions must be a whole number from 1 to 1,000.",
		},
		{
			field: "Max redemptions",
			value: "1.5",
			message: "Redemptions must be a whole number from 1 to 1,000.",
		},
	];
	for (const invalid of invalidValues) {
		await dialog.getByLabel(invalid.field).fill(invalid.value);
		await createButton.click();
		await expect(dialog.getByRole("alert")).toHaveText(invalid.message);
		expect(
			(await calls(page)).filter(
				(call) => call.method === "POST" && call.path.endsWith("/share-codes")
			)
		).toHaveLength(0);
	}
	await capture(page, "invalid-bounds-no-write");
});

test("creates an organization-bound share with trimmed values and upper bounds", async ({
	page,
}) => {
	await installClock(page);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const dialog = await openDialog(page);
	for (const packageKind of [
		"Agent Templates",
		"Apps",
		"Bundles",
		"Output Styles",
		"Plugins",
		"Profiles",
		"Skills",
		"Spaces",
		"Themes",
		"Language Packs",
		"Workflows",
	]) {
		await chooseOption(page, dialog, "Package type", packageKind);
		await expect(
			dialog.getByRole("combobox", { name: "Package type" })
		).toContainText(packageKind);
	}
	await chooseOption(page, dialog, "Package type", "Skills");
	await dialog.getByLabel("Package id").fill("  acme/private-skill  ");
	await dialog.getByLabel("Label (optional)").fill("  Acme onboarding  ");
	await dialog
		.getByLabel("Customer organization id")
		.fill("  org_customer_demo  ");
	await dialog.getByLabel("Expires in (days)").fill("90");
	await dialog.getByLabel("Max redemptions").fill("1000");
	await capture(page, "organization-share-draft");

	await dialog
		.getByRole("button", { name: "Create code", exact: true })
		.click();
	await expect(dialog.getByText("Code ready", { exact: true })).toBeVisible();
	await expect(dialog).toContainText("7K4M-X2QP-9F6D");
	await expect(dialog).toContainText(
		"This code is bound to the customer organization."
	);
	await expect(dialog).toContainText("allows 1000 redemptions.");
	const write = (await calls(page)).find(
		(call) => call.method === "POST" && call.path.endsWith("/share-codes")
	);
	expect(write).toEqual({
		body: {
			customerOrganizationId: "org_customer_demo",
			expiresAt: new Date(
				BASE_TIME.getTime() + 90 * 24 * 60 * 60 * 1000
			).toISOString(),
			id: "acme/private-skill",
			kind: "skill",
			label: "Acme onboarding",
			maxRedemptions: 1000,
		},
		method: "POST",
		path: "/api/marketplace/share-codes",
	});
	await capture(page, "created-organization-bound-code");

	await dialog.getByRole("button", { name: "Copy code", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("7K4M-X2QP-9F6D");
	await expect(
		dialog.getByRole("button", { name: "Revoke code" })
	).toBeEnabled();

	const requestsBeforeDone = await calls(page);
	await dialog.getByRole("button", { name: "Done", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await page.getByRole("button", { name: "Open publisher share" }).click();
	const reopened = page.getByRole("dialog");
	await expect(reopened.getByLabel("Package id")).toHaveValue("");
	await expect(reopened.getByLabel("Label (optional)")).toHaveValue("");
	await expect(reopened.getByLabel("Customer organization id")).toHaveValue("");
	await expect(reopened.getByLabel("Expires in (days)")).toHaveValue("7");
	await expect(reopened.getByLabel("Max redemptions")).toHaveValue("1");
	await expect(reopened).not.toContainText("7K4M-X2QP-9F6D");
	const requestsAfterDone = await calls(page);
	expect(requestsAfterDone).toEqual(requestsBeforeDone);
	expect(requestsAfterDone.some((call) => call.path.includes("/redeem"))).toBe(
		false
	);
	expect(
		requestsAfterDone.some((call) =>
			JSON.stringify(call.body).match(/email|recipient/i)
		)
	).toBe(false);
});

test("creates a shareable code without organization binding at the lower bounds", async ({
	page,
}) => {
	await installClock(page);
	const dialog = await openDialog(page);
	await chooseOption(page, dialog, "Package type", "Plugins");
	await dialog.getByLabel("Package id").fill("ryu/demo-plugin");
	await chooseOption(page, dialog, "Access", "Shareable bearer code");
	await expect(dialog.getByLabel("Customer organization id")).toBeDisabled();
	await dialog.getByLabel("Expires in (days)").fill("1");
	await dialog.getByLabel("Max redemptions").fill("1");
	await dialog
		.getByRole("button", { name: "Create code", exact: true })
		.click();
	await expect(dialog.getByText("Code ready", { exact: true })).toBeVisible();
	await expect(dialog).toContainText("Anyone with this code can redeem it.");
	const write = (await calls(page)).find(
		(call) => call.method === "POST" && call.path.endsWith("/share-codes")
	);
	expect(write).toEqual({
		body: {
			customerOrganizationId: null,
			expiresAt: new Date(
				BASE_TIME.getTime() + 24 * 60 * 60 * 1000
			).toISOString(),
			id: "ryu/demo-plugin",
			kind: "plugin",
			maxRedemptions: 1,
		},
		method: "POST",
		path: "/api/marketplace/share-codes",
	});
	await capture(page, "created-shareable-code");
});

test("retains the draft during loading and retries the exact payload after 503", async ({
	page,
}) => {
	await installClock(page);
	const dialog = await openDialog(page);
	await fillValidOrganizationShare(dialog);
	await dialog.getByLabel("Label (optional)").fill("Retained on retry");
	await configureFixture(page, "hold-create");
	await configureFixture(
		page,
		"fail-create",
		"Fixture create service is temporarily unavailable."
	);

	const createButton = dialog.getByRole("button", {
		name: /Create code/,
	});
	await createButton.click();
	await expect(createButton).toBeDisabled();
	await expect(dialog.getByLabel("Package id")).toHaveValue(
		"acme/private-skill"
	);
	await capture(page, "create-pending-disabled");
	await configureFixture(page, "release-create");
	await expect(dialog.getByRole("alert")).toHaveText(
		"Fixture create service is temporarily unavailable."
	);
	await expect(createButton).toBeEnabled();
	await expect(dialog.getByLabel("Label (optional)")).toHaveValue(
		"Retained on retry"
	);
	await capture(page, "create-503-draft-retained");
	await createButton.click();
	await expect(dialog.getByText("Code ready", { exact: true })).toBeVisible();

	const createCalls = (await calls(page)).filter(
		(call) => call.method === "POST" && call.path.endsWith("/share-codes")
	);
	expect(createCalls).toHaveLength(2);
	expect(createCalls[0]?.body).toEqual(createCalls[1]?.body);
	expect(createCalls[0]?.body).toEqual({
		customerOrganizationId: "org_customer_demo",
		expiresAt: new Date(
			BASE_TIME.getTime() + 7 * 24 * 60 * 60 * 1000
		).toISOString(),
		id: "acme/private-skill",
		kind: "workflow",
		label: "Retained on retry",
		maxRedemptions: 1,
	});
});

test("revoke failure can retry, then the revoked result stays visible and disabled", async ({
	page,
}) => {
	await installClock(page);
	const dialog = await openDialog(page);
	await fillValidOrganizationShare(dialog);
	await dialog
		.getByRole("button", { name: "Create code", exact: true })
		.click();
	await expect(dialog.getByText("Code ready", { exact: true })).toBeVisible();
	await configureFixture(
		page,
		"fail-revoke",
		"Fixture revoke service is temporarily unavailable."
	);

	const revokeButton = dialog.getByRole("button", {
		exact: true,
		name: "Revoke code",
	});
	await revokeButton.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Fixture revoke service is temporarily unavailable."
	);
	await expect(revokeButton).toBeEnabled();
	await expect(dialog).not.toContainText("This code is revoked.");
	await capture(page, "revoke-503-retry-available");

	await revokeButton.click();
	await expect(dialog).toContainText("This code is revoked.");
	await expect(dialog.getByRole("button", { name: "Revoked" })).toBeDisabled();
	await expect(records(page)).resolves.toEqual([
		expect.objectContaining({
			id: "share-code-fixture-1",
			revoked_at: "2026-09-28T01:00:00.000Z",
		}),
	]);
	const revokeCalls = (await calls(page)).filter((call) =>
		call.path.endsWith("/revoke")
	);
	expect(revokeCalls).toEqual([
		{
			body: null,
			method: "POST",
			path: "/api/marketplace/share-codes/share-code-fixture-1/revoke",
		},
		{
			body: null,
			method: "POST",
			path: "/api/marketplace/share-codes/share-code-fixture-1/revoke",
		},
	]);
	await capture(page, "revoked-code-readback-disabled");
});

test("Cancel and Escape close the dialog and discard an unsent draft", async ({
	page,
}) => {
	await installClock(page);
	const dialog = await openDialog(page);
	await dialog.getByLabel("Package id").fill("acme/discard-me");
	await dialog.getByLabel("Label (optional)").fill("Unsaved draft");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect(calls(page)).resolves.toEqual([]);

	await page.getByRole("button", { name: "Open publisher share" }).click();
	const reopened = page.getByRole("dialog");
	await expect(reopened.getByLabel("Package id")).toHaveValue("");
	await expect(reopened.getByLabel("Label (optional)")).toHaveValue("");
	await reopened.getByLabel("Package id").fill("acme/escape-discard");
	await page.keyboard.press("Escape");
	await expect(reopened).not.toBeVisible();
	await expect(calls(page)).resolves.toEqual([]);

	await page.getByRole("button", { name: "Open publisher share" }).click();
	const afterEscape = page.getByRole("dialog");
	await expect(afterEscape.getByLabel("Package id")).toHaveValue("");
	await expect(
		afterEscape.getByLabel("Customer organization id")
	).toBeEnabled();
	await capture(page, "dialog-reopened-reset-after-cancel-escape");
});
