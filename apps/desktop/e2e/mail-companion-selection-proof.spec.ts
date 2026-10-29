import { tmpdir } from "node:os";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type {
	MailProofApi,
	MailProofCall,
} from "./harness/mail-companion-proof.types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appHtmlPath = `${tmpdir()}/ryu-mail-inbox-selection-ui-build/index.html`;
const evidenceDirectory = path.resolve(
	here,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

declare global {
	interface Window {
		__mailProof: MailProofApi;
	}
}

async function calls(page: Page): Promise<MailProofCall[]> {
	return page.evaluate(() => window.__mailProof.calls());
}

async function mountMail(page: Page): Promise<FrameLocator> {
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
	const appHtml = await readFile(appHtmlPath, "utf8");
	await page.evaluate((input) => window.__mailProof.mount(input), { appHtml });
	await expect
		.poll(() => page.evaluate(() => window.__mailProof.connected()))
		.toBe(true);
	const companion = page.frameLocator('iframe[title="Mail proof"]');
	await expect(
		companion.getByRole("heading", { name: "Agent Inboxes" })
	).toBeVisible();
	return companion;
}

test("switching inbox clears the prior message before reading the new inbox", async ({
	page,
}) => {
	const companion = await mountMail(page);
	const supportMessage = companion.getByRole("option", {
		name: /Ticket 42: sign-in help/,
	});
	await supportMessage.click();
	await expect(
		companion
			.getByRole("article")
			.getByRole("heading", { name: "Ticket 42: sign-in help" })
	).toBeVisible();

	await companion.getByText("Billing", { exact: true }).click();
	await expect(
		companion.getByRole("option", { name: /Billing inbox fixture/ })
	).toBeVisible();
	await expect(
		companion.getByRole("heading", { name: "Ticket 42: sign-in help" })
	).toHaveCount(0);
	await expect(
		companion
			.getByRole("article")
			.getByRole("heading", { name: "Billing inbox fixture" })
	).toBeVisible();
	await expect(companion.getByRole("article")).toContainText(
		"billing@agent.test"
	);

	const latestMessagesRead = (await calls(page))
		.filter((call) => call.method === "mail.messages")
		.at(-1);
	expect(latestMessagesRead).toMatchObject({
		args: { inboxId: "inbox-billing" },
		status: 200,
	});

	await mkdir(evidenceDirectory, { recursive: true });
	await companion.locator("body").screenshot({
		path: path.join(
			evidenceDirectory,
			"mail-inbox-switch-clears-reading-pane.png"
		),
	});
});
