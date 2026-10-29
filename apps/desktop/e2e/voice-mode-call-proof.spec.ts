import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/voice-mode-call-proof.html";

test("proves the call morphs into the composer with its live controls", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);

	const screen = page.getByTestId("voice-call-screen");
	await expect(screen).toBeVisible();
	await expect(screen).toHaveAccessibleName("Voice call with Ryu Assistant");
	await expect(screen).toContainText("Ryu Assistant");
	await expect(screen).not.toContainText("Connected to");
	await expect(screen).not.toContainText("Listening");
	await expect(page.getByTestId("voice-call-duration")).toHaveText(
		/^\d{2}:\d{2}$/
	);

	// The call replaces the text field inside the same composer card: no second
	// composer, no textbox, no Send, but the "+" menu stays put.
	const card = page.locator(".composer-container");
	await expect(card).toHaveCount(1);
	await expect(card.getByTestId("voice-call-screen")).toBeVisible();
	await expect(card.getByRole("textbox")).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Send" })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Add" })).toBeVisible();

	// The libraries.dev voice glow wraps the input card itself.
	const glow = page.locator("[data-voice-beam]").filter({ has: card });
	await expect(glow).toHaveCount(1);
	await expect(page.getByTestId("aurora")).toHaveCount(0);

	// Call turns read as normal chat messages, not a panel inside the composer.
	await expect(card.getByTestId("voice-call-transcript")).toHaveCount(0);
	await expect(card).not.toContainText(
		"Can you walk me through the next step?"
	);
	await expect(
		page.getByText("Can you walk me through the next step?")
	).toBeVisible();
	await expect(
		page.getByText(
			"Absolutely. I will keep the next step focused and easy to follow."
		)
	).toBeVisible();
	await expect(page.getByRole("button", { name: "End call" })).toBeVisible();

	await page.screenshot({
		path: testInfo.outputPath("voice-mode-call-live.png"),
		fullPage: true,
	});

	const mute = page.getByRole("button", { name: "Mute microphone" });
	await mute.click();
	await expect(
		page.getByRole("button", { name: "Unmute microphone" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(screen).toContainText("Microphone muted");

	await page.screenshot({
		path: testInfo.outputPath("voice-mode-call-proof.png"),
		fullPage: true,
	});

	await page.getByRole("button", { name: "Unmute microphone" }).click();
	await expect(
		page.getByRole("button", { name: "Mute microphone" })
	).toHaveAttribute("aria-pressed", "false");

	await page.getByRole("button", { name: "End call" }).click();
	await expect(page.getByTestId("voice-call-screen")).toHaveCount(0);
	await expect(page.getByPlaceholder("Send a message")).toBeVisible();
});
