import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/connection-status-proof.html";

test("connection states keep the workspace mounted and recover in place", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const proof = page.getByTestId("connection-status-proof");
	const toast = page.getByTestId("connection-status-toast");
	await expect(proof).toHaveAttribute("data-harness-ready", "1");
	await expect(toast).toHaveAttribute(
		"data-connection-phase",
		"node-unreachable"
	);
	await expect(toast).toContainText("Node offline");
	await expect(toast).toContainText("Can’t reach Design node");
	await expect(toast.getByRole("button", { name: "Retry" })).toBeVisible();

	await page.getByRole("button", { name: "Simulate no Wi-Fi" }).click();
	await expect(toast).toHaveAttribute("data-connection-phase", "offline");
	await expect(toast).toContainText("Offline mode");
	await expect(toast).toContainText("Waiting for connectivity");
	await expect(toast.getByRole("button", { name: "Retry" })).toHaveCount(0);

	await page.getByRole("button", { name: "Confirm restored" }).click();
	await expect(toast).toHaveAttribute("data-connection-phase", "online");
	await expect(toast).toHaveAttribute("data-connection-restored", "true");
	await expect(toast).toContainText("Connection restored");

	await page.getByRole("button", { name: "Reconnect" }).click();
	await expect(toast).toHaveAttribute("data-connection-phase", "checking");
	await expect(toast).toContainText("Connecting to Design node");
});
