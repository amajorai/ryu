// Real-browser spec for the recovery story (`e2e/harness/
// chat-recovery-story.{html,tsx}`). It checks the actual rendered state rather
// than only the props: both notices must be separator markers, and the empty
// composer must be the quiet, disabled send arrow with no voice-mode label (the
// shared SendButton uses the same upward arrow idle and typing).

import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/chat-recovery-story.html";

test("recovery notices are separators and the idle composer is a disabled send arrow", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const transcript = page.getByTestId("recovery-transcript");
	const markers = transcript.locator('[data-slot="marker"]');
	await expect(markers).toHaveCount(3);
	for (let i = 0; i < 3; i += 1) {
		await expect(markers.nth(i)).toHaveAttribute("data-variant", "separator");
	}
	await expect(
		transcript.getByText(/Interrupted — this reply was cut off/)
	).toBeVisible();
	await expect(
		transcript.getByText("Earlier context was compacted")
	).toBeVisible();
	await expect(
		transcript.getByText("Compacting earlier context")
	).toBeVisible();

	const composer = page.getByTestId("recovery-composer");
	const send = composer.getByRole("button", { name: "Send", exact: true });
	await expect(send).toBeVisible();
	await expect(send).toBeDisabled();
	await expect(send).toHaveText("");
	// The composer's icons are Hugeicons: the idle send is its up arrow, not
	// Stop, so its strokes are ArrowUp02Icon's.
	await expect(send.locator("svg path")).toHaveCount(ArrowUp02Icon.length);
	for (const [index, [, attributes]] of ArrowUp02Icon.entries()) {
		await expect(send.locator("svg path").nth(index)).toHaveAttribute(
			"d",
			attributes.d
		);
	}
	await expect(
		composer.getByRole("button", { name: "Start voice mode" })
	).toHaveCount(0);
	await expect(
		composer.getByRole("button", { name: "Start voice input" })
	).toBeVisible();

	const creditError = transcript.getByText("OpenRouter credits exhausted");
	await expect(creditError).toBeVisible();
	await expect(
		transcript.getByText(/Add credits to your OpenRouter account/)
	).toBeVisible();
	await expect(transcript.getByText("Ryu credits exhausted")).toBeVisible();
	await expect(
		transcript.getByText(/Open Settings > Credits to top up/)
	).toBeVisible();
	const retryButtons = transcript.getByRole("button", { name: "Retry" });
	await expect(retryButtons).toHaveCount(2);
	await retryButtons.nth(0).click();
	await retryButtons.nth(1).click();
	await expect(page.getByTestId("story-state")).toHaveAttribute(
		"data-retried",
		"2"
	);

	const proofPath = process.env.RYU_OPENROUTER_CREDITS_PROOF;
	if (proofPath) {
		await page.screenshot({ path: proofPath, fullPage: true });
	}
});
