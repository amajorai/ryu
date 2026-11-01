import { expect, type Locator, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("renders capability mentions and gates Composio integrations", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});

	await page.goto("/mention-composer-proof.html");
	await page.waitForLoadState("networkidle");

	await expect(page.getByTestId("proof-status")).toHaveText(/VERIFIED/);
	await expect(page.getByTestId("configured-state")).toContainText("CONNECTED");
	await expect(page.getByTestId("unconfigured-state")).toContainText("HIDDEN");

	const connected = page.getByTestId("configured-state");
	for (const label of [
		"Agents",
		"Apps",
		"App items",
		"Integrations",
		"Plugins",
		"Skills",
		"Space pages",
		"Personality profiles",
	]) {
		await expect(connected.getByText(label, { exact: true })).toBeVisible();
	}
	const connectedComposer = connected.getByRole("textbox", {
		name: "Credential available composer",
	});
	await connectedComposer.fill("@does-not-exist");
	await expect(
		connected.getByText("No results found", { exact: true })
	).toBeVisible();
	await page.screenshot({
		path: "test-results/mention-composer-empty-state-proof.png",
		fullPage: true,
	});
	const composerMention = page
		.getByTestId("composer-mention-proof")
		.locator('[data-mention-token="app"]')
		.first();
	await expect(composerMention).toHaveText("Browser");
	await expect(composerMention).toHaveCSS(
		"background-color",
		"rgba(0, 0, 0, 0)"
	);
	await expect(composerMention.getByLabel("Browser app icon")).toBeVisible();
	await connectedComposer.fill("@");
	await connected.getByRole("option", { name: /Design brief/ }).click();
	await expect(connected.getByTestId("configured-selection")).toHaveText(
		"@Design brief"
	);
	await expect(connected.getByRole("option", { name: /GitHub/ })).toBeVisible();
	await expect(connected.getByRole("option", { name: /Slack/ })).toHaveCount(0);
	await connected.getByRole("option", { name: /GitHub/ }).click();
	await expect(connected.getByTestId("configured-selection")).toHaveText(
		"@GitHub"
	);
	await expect(connected.getByTestId("configured-header-selection")).toHaveText(
		"Selected @GitHub"
	);

	const disconnected = page.getByTestId("unconfigured-state");
	await expect(
		disconnected.getByText("Integrations", { exact: true })
	).toHaveCount(0);
	await expect(
		disconnected.getByRole("option", { name: /GitHub/ })
	).toHaveCount(0);

	const inboxEnabled = page.getByTestId("inbox-enabled-state");
	const inboxDisabled = page.getByTestId("inbox-disabled-state");
	await inboxDisabled.getByTestId("human-mention-input").fill("@a");
	await inboxDisabled.getByTestId("human-mention-input").fill("@");
	await expect(inboxDisabled.getByText("Users", { exact: true })).toHaveCount(
		0
	);
	await inboxEnabled.getByTestId("human-mention-input").fill("@a");
	await inboxEnabled.getByTestId("human-mention-input").fill("@");
	for (const label of ["Agents", "Apps", "Plugins", "Workflows", "Users"]) {
		await expect(inboxEnabled.getByText(label, { exact: true })).toBeVisible();
	}
	for (const label of ["Chats", "Skills", "Groups"]) {
		await expect(inboxEnabled.getByText(label, { exact: true })).toHaveCount(0);
	}
	await inboxEnabled.getByRole("option", { name: "Ada Lovelace" }).click();
	await expect(inboxEnabled.getByTestId("human-composer-token")).toContainText(
		"Ada Lovelace"
	);
	await expect(
		inboxEnabled
			.getByTestId("human-composer-token")
			.getByLabel("Ada Lovelace avatar")
	).toBeVisible();
	const humanToken = inboxEnabled
		.getByTestId("human-transcript")
		.locator('[data-mention-kind="user"]');
	await expect(humanToken).toBeVisible();
	await expect(
		inboxEnabled.locator('button[data-mention-kind="user"]')
	).toHaveCount(0);
	await expect(humanToken).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await inboxEnabled
		.getByRole("button", { name: "Record notifications.send" })
		.click();
	await expect(inboxEnabled.getByTestId("notification-targets")).toHaveText(
		"user-ada"
	);
	await expect(inboxEnabled.getByTestId("routing-callbacks")).toHaveText(
		"none"
	);

	const slash = page.getByTestId("slash-command-proof");
	// The shared composer menu shows group labels only with more than two
	// groups since 093203904b (P3), so with Commands and Skills alone each row
	// carries its source instead: the plugin command first, the skill after it.
	await expect(slash.getByText("Commands", { exact: true })).toHaveCount(0);
	const slashOptions = slash.getByRole("option");
	await expect(slashOptions).toHaveCount(2);
	await expect(slashOptions.nth(0)).toHaveAccessibleName(/^\/deploy\b/);
	await expect(slashOptions.nth(0)).toContainText("Plugin");
	await expect(slashOptions.nth(1)).toHaveAccessibleName(/^\/pdf\b/);
	await expect(slashOptions.nth(1)).toContainText("Skill");
	await slash.getByRole("option", { name: "/pdf" }).click();
	await expect(slash.getByTestId("slash-command-value")).toHaveText("/pdf ");
	await slash.getByTestId("slash-command-input").fill("/deploy");
	await slash.getByRole("option", { name: "/deploy" }).click();
	await expect(slash.getByRole("option", { name: "Staging" })).toBeVisible();
	await slash.getByRole("option", { name: "Staging" }).click();
	await expect(slash.getByRole("option", { name: "Singapore" })).toBeVisible();
	await page.screenshot({
		path: "test-results/slash-command-arguments-menu-proof.png",
		fullPage: true,
	});
	await slash.getByRole("option", { name: "Singapore" }).click();
	await expect(slash.getByTestId("slash-command-value")).toHaveText(
		"/deploy staging sg"
	);
	await expect(slash.getByTestId("slash-proof-status")).toHaveText("VERIFIED");
	await expect(slash.getByRole("listbox")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await page.screenshot({
		path: "test-results/slash-command-arguments-proof.png",
		fullPage: true,
	});

	const proofLog = page.getByTestId("transcript-proof-log");
	const clickAndWaitForDestination = async (
		locator: Locator,
		destination: string
	) => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await locator.click();
			try {
				await expect(proofLog).toContainText(destination, { timeout: 1000 });
				return;
			} catch (error) {
				if (attempt === 1) {
					throw error;
				}
			}
		}
	};

	for (const role of ["user", "agent"]) {
		const transcript = page.getByTestId(
			role === "user" ? "user-transcript-markdown" : "agent-transcript-markdown"
		);
		const browserMention = transcript.locator(
			'button[data-mention-kind="app"][data-mention-id="browser"]'
		);
		await expect(browserMention).toHaveText("Browser");
		await expect(browserMention).not.toContainText("@");
		await expect(
			browserMention.locator('[data-mention-token="app"]')
		).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		for (const item of [
			["agent", "claude"],
			["app", "browser"],
			["app-item", "com.ryu.canvas:canvas:brief"],
			["chat", "architecture"],
			["team", "platform"],
			["workflow", "deploy"],
			["space", "personal"],
			["page", "space-1:launch-plan"],
			["output-style", "plain"],
			["skill", "research"],
			["mcp", "local-mcp"],
			["folder", "/workspace/ryu-closed"],
			["integration", "github"],
			["plugin", "double-check"],
		] as const) {
			await clickAndWaitForDestination(
				transcript.locator(
					`button[data-mention-kind="${item[0]}"][data-mention-id="${item[1]}"]`
				),
				`${role}:${item[0]}:${item[1]}`
			);
		}
		await clickAndWaitForDestination(
			transcript.getByRole("link", { name: "Open website" }),
			`${role}:website:https://example.com/mention-proof`
		);
	}
	await expect(page.getByTestId("transcript-proof-status")).toHaveText(
		/VERIFIED · all destinations opened/
	);

	await page.screenshot({
		path: "test-results/mention-command-human-proof.png",
		fullPage: true,
	});
	if (consoleErrors.length > 0) {
		throw new Error(`Browser console errors: ${consoleErrors.join(" | ")}`);
	}
});
