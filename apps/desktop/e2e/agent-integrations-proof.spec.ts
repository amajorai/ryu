import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const PROOF_DIR = path.resolve("test-results/agent-integrations-proof");
const PROOF_SCREENSHOT = path.join(PROOF_DIR, "agent-integrations-proof.png");
const PROOF_LOG = path.join(PROOF_DIR, "agent-integrations-proof.log.json");

test.describe.configure({ mode: "serial", timeout: 120_000 });

test("switches languages, copies the sample, and wires docs", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => consoleErrors.push(String(error)));

	await page.goto("/agent-integrations-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await expect(
		page.getByRole("heading", { name: "Call your agent from code" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "TypeScript SDK" })
	).toHaveAttribute("aria-pressed", "true");

	await page.getByRole("button", { name: "Python" }).click();
	await expect(page.getByRole("button", { name: "Python" })).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	await expect(page.locator("pre").first()).toContainText("requests.post");

	await page.getByRole("button", { name: "Copy code sample" }).click();
	await expect(
		page.getByRole("button", { name: "Code sample copied" })
	).toBeVisible();

	await page.getByRole("button", { name: "Read integration docs" }).click();
	await expect(page.getByTestId("docs-opened")).toHaveText(
		"Documentation requested"
	);

	await mkdir(PROOF_DIR, { recursive: true });
	await page.screenshot({ path: PROOF_SCREENSHOT, fullPage: true });
	await writeFile(
		PROOF_LOG,
		JSON.stringify({ consoleErrors }, null, 2),
		"utf8"
	);

	expect(consoleErrors).toEqual([]);
});
