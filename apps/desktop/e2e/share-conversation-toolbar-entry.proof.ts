import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const EVIDENCE_ROOT = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

test.describe.configure({ timeout: 90_000 });

test("ChatPage titlebar opens sharing and saves organization access", async ({
	page,
}, testInfo) => {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	await page.goto("/share-conversation-toolbar-entry.html", {
		waitUntil: "domcontentloaded",
	});

	const opener = page.getByRole("button", {
		name: "Share conversation",
		exact: true,
	});
	try {
		await expect(opener).toBeVisible();
	} catch (error) {
		const body = await page
			.locator("body")
			.innerText()
			.catch(() => "");
		throw new Error(
			`ChatPage share action did not render. Body: ${body.slice(0, 1200)}. Page errors: ${pageErrors.join(" | ")}. Console errors: ${consoleErrors.join(" | ")}`,
			{ cause: error }
		);
	}
	await opener.click();

	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(
		"Share “Toolbar share regression fixture”"
	);
	await expect(dialog).toContainText("Jia Wei Ng");
	await expect(
		dialog.getByRole("combobox", { name: "General access" })
	).toContainText("Restricted");
	await expect(dialog).toContainText(
		"2 messages · 0 PII · 0 secrets · 0 custom redacted"
	);
	await expect(
		page.getByText("Connection restored", { exact: true })
	).toBeHidden({
		timeout: 10_000,
	});
	await mkdir(EVIDENCE_ROOT, { recursive: true });
	const openedPath = path.join(
		EVIDENCE_ROOT,
		"desktop-share-conversation-toolbar-dialog-open.png"
	);
	const openedShot = await page.screenshot({
		fullPage: true,
		path: openedPath,
	});
	await testInfo.attach("sharing-dialog-opened-from-chat-toolbar.png", {
		body: openedShot,
		contentType: "image/png",
	});

	await dialog.getByRole("combobox", { name: "General access" }).click();
	await page
		.getByRole("option", { name: "Anyone in the organization" })
		.click();
	await expect(dialog).toContainText(
		"Everyone in your organization can participate."
	);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByText("Sharing settings saved")).toBeVisible();

	const fixtureCalls = await page.evaluate(() => {
		// SAFETY: This controlled harness installs __shareToolbarFixture with Object.defineProperty; recordCall publishes string method/path and unknown body, while the mounted ShareConversationDialog publishes its string visibility through setConversationAccess before the local fixture merge.
		return (
			window as Window & {
				__shareToolbarFixture: {
					access: { visibility: string };
					calls: Array<{ body: unknown; method: string; path: string }>;
				};
			}
		).__shareToolbarFixture;
	});
	expect(fixtureCalls.access.visibility).toBe("org");
	expect(fixtureCalls.calls).toContainEqual({
		body: null,
		method: "GET",
		path: "/api/conversations/conversation-toolbar-share-fixture/access",
	});
	expect(fixtureCalls.calls).toContainEqual({
		body: {
			collaborators: [],
			team_id: null,
			visibility: "org",
		},
		method: "PUT",
		path: "/api/conversations/conversation-toolbar-share-fixture/access",
	});
	expect(pageErrors).toEqual([]);
});
