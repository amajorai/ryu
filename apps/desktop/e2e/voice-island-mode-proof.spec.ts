import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Ryu Quiet (1506c7bce0, "Island wears one ring and token fill") removed the
// VoiceGlow edge glow and sweeping beam from both Island voice states: the
// push-to-talk pill shows a static dot and a four-bar level meter, and voice
// mode keeps one monochrome orb whose scale follows the mean level (held at
// rest under reduced motion). This proof asserts that intended UI, with the
// same harness levels driving both states.

/** The harness's levels (voice-island-mode-proof.tsx). */
const LEVELS = [0.18, 0.35, 0.55, 0.32, 0.82, 0.66, 0.94, 0.48];
/** recording-pill.tsx: four bars, newest on the right, floored at 20%. */
const METER_HEIGHTS = LEVELS.slice(-4).map(
	(level) => `${Math.round((0.2 + level * 0.8) * 100)}%`
);
/** VoiceModePanel.tsx: rest scale plus the mean level times 0.35. */
const ORB_SCALE =
	1 +
	(LEVELS.reduce((total, level) => total + level, 0) / LEVELS.length) * 0.35;

/** The x scale of an element's computed transform (1 when untransformed). */
function scaleOf(element: Locator): Promise<number> {
	return element.evaluate((node) => {
		const transform = getComputedStyle(node).transform;
		return transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a;
	});
}

test("renders both Island voice states and captures the finished UI", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.goto("/voice-island-mode-proof.html");

	// Push-to-talk: a static recording dot, the routed agent, and a level meter
	// whose bars follow the newest microphone levels. No glow remains.
	const pushToTalk = page.getByTestId("push-to-talk-preview");
	await expect(pushToTalk).toContainText("Island voice input");
	await expect(pushToTalk).toContainText("Ryu Assistant");
	await expect(pushToTalk.locator("[data-voice-beam]")).toHaveCount(0);
	const dot = pushToTalk.locator("span.bg-destructive.rounded-full");
	await expect(dot).toBeVisible();
	expect(
		await dot.evaluate((node) => getComputedStyle(node).animationName)
	).toBe("none");
	const bars = pushToTalk.locator("span[aria-hidden] > span");
	await expect(bars).toHaveCount(METER_HEIGHTS.length);
	expect(
		await bars.evaluateAll((nodes) =>
			nodes.map((node) => (node as HTMLElement).style.height)
		)
	).toEqual(METER_HEIGHTS);

	// Voice mode while thinking: the phase is announced, Interrupt is offered,
	// and the orb settles at the scale the mean level sets.
	const voiceMode = page.getByTestId("voice-mode-preview");
	await expect(voiceMode).toContainText("Continuous voice mode");
	await expect(voiceMode.locator('[aria-live="polite"]').first()).toHaveText(
		"Thinking…"
	);
	await expect(
		voiceMode.getByRole("button", { name: "Interrupt", exact: true })
	).toBeVisible();
	await expect(voiceMode.locator("[data-voice-beam]")).toHaveCount(0);
	const orb = voiceMode.locator("div.rounded-full.bg-foreground");
	await expect(orb).toHaveCount(1);
	await expect.poll(() => scaleOf(orb)).toBeCloseTo(ORB_SCALE, 3);

	const screenshotPath = proofEvidencePath("voice-glow/island-voice-mode.png");
	await mkdir(path.dirname(screenshotPath), { recursive: true });
	await page.screenshot({ fullPage: true, path: screenshotPath });

	// Reduced motion: the orb holds its rest size whatever the level.
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.reload();
	const reducedOrb = page
		.getByTestId("voice-mode-preview")
		.locator("div.rounded-full.bg-foreground");
	await expect(reducedOrb).toHaveCount(1);
	await page.waitForTimeout(250);
	expect(await scaleOf(reducedOrb)).toBe(1);
});
