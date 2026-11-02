import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the shared transcript and app-icon graph on first navigation.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/chat-composer-transition-proof.html";

interface TransitionEvidence {
	finalTop: number;
	frameDeltas: number[];
	initialTop: number;
	sameComposerNode: boolean;
	samples: { state: string | null; top: number; time: number }[];
}

async function collectTransitionEvidence(
	page: Page
): Promise<TransitionEvidence> {
	return await page.evaluate(
		() =>
			new Promise<TransitionEvidence>((resolve, reject) => {
				const root = document.querySelector<HTMLElement>("[data-chat-state]");
				const composer = document.querySelector<HTMLElement>(
					"[data-chat-composer-transition]"
				);
				if (!(root && composer)) {
					reject(new Error("chat transition markers are missing"));
					return;
				}

				const initialTop = composer.getBoundingClientRect().top;
				const samples: TransitionEvidence["samples"] = [];
				const initialNode = composer;
				const startedAt = performance.now();
				// The 800 ms window starts at the state handoff, not at the click: on
				// a loaded host the send can take longer than the window to land, and
				// idle frames before it would otherwise dilute the motion evidence.
				let activatedAt: number | null = null;

				const collect = (now: number) => {
					const top = composer.getBoundingClientRect().top;
					const state = root.getAttribute("data-chat-state");
					samples.push({ state, time: now - startedAt, top });
					if (state === "active") {
						activatedAt ??= now;
					}
					const settling =
						activatedAt === null
							? now - startedAt < 10_000
							: now - activatedAt < 800;
					if (settling) {
						requestAnimationFrame(collect);
						return;
					}

					const finalTop = samples.at(-1)?.top ?? initialTop;
					// Deltas from the last pre-handoff frame through the window.
					const firstActive = samples.findIndex(
						(sample) => sample.state === "active"
					);
					const motion = samples.slice(Math.max(0, firstActive - 1));
					resolve({
						finalTop,
						frameDeltas: motion
							.slice(1)
							.map((sample, index) => sample.top - motion[index]!.top),
						initialTop,
						samples,
						sameComposerNode:
							initialNode ===
							document.querySelector("[data-chat-composer-transition]"),
					});
				};

				requestAnimationFrame(collect);
			})
	);
}

test("the first send morphs the centered composer into the active chat dock", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	const state = page.getByTestId("story-state");
	const root = page.locator("[data-chat-state]");
	const composer = page.locator("[data-chat-composer-transition]");

	await expect(root).toHaveAttribute("data-chat-state", "empty");
	await expect(composer).toHaveCount(1);
	const before = await composer.boundingBox();
	if (!before) {
		throw new Error("empty composer did not have a layout box");
	}

	await page.getByRole("textbox").fill("Show me how this transition feels");
	const evidencePromise = collectTransitionEvidence(page);
	await page.getByRole("button", { name: "Send", exact: true }).click();

	await expect(root).toHaveAttribute("data-chat-state", "active");
	await expect(state).toHaveAttribute("data-message-count", "2", {
		timeout: 10_000,
	});
	const evidence = await evidencePromise;

	const activeSamples = evidence.samples.filter(
		(sample) => sample.state === "active"
	);
	// Frames in which the composer actually moved. How many settled frames
	// follow the spring depends on the host's frame rate, so the direction check
	// is made over the moving frames, not the whole sampling window.
	// Sub-pixel settling jitter is not motion.
	const movingFrames = evidence.frameDeltas.filter(
		(delta) => Math.abs(delta) >= 0.5
	);
	const downwardFrames = movingFrames.filter((delta) => delta > 0);
	const largestFrameDelta = Math.max(
		...evidence.frameDeltas.map((delta) => Math.abs(delta))
	);
	const totalTravel = evidence.finalTop - evidence.initialTop;

	const logPath = testInfo.outputPath(
		"chat-composer-transition-proof.log.json"
	);
	await writeFile(
		logPath,
		JSON.stringify(
			{
				before,
				evidence,
				largestFrameDelta,
				downwardFrameCount: downwardFrames.length,
				movingFrameCount: movingFrames.length,
			},
			null,
			2
		)
	);

	// The slot travels down a meaningful distance, rather than only fading in.
	expect(totalTravel).toBeGreaterThan(80);
	// A layout handoff produces several measured frames and keeps moving in the
	// intended direction for most of them; a DOM replacement has one jump.
	expect(activeSamples.length).toBeGreaterThan(10);
	expect(movingFrames.length).toBeGreaterThan(2);
	expect(downwardFrames.length).toBeGreaterThanOrEqual(
		Math.ceil(movingFrames.length / 2)
	);
	expect(largestFrameDelta).toBeLessThan(totalTravel * 0.65);
	// The same DOM slot survives the state change, which is the structural part of
	// the fix that lets Motion interpolate its geometry.
	expect(evidence.sameComposerNode).toBe(true);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("chat-composer-transition-proof.png"),
	});
});

test("reduced motion keeps the same layout handoff without the spring", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(STORY_URL);
	const root = page.locator("[data-chat-state]");

	await expect(root).toHaveAttribute("data-chat-motion", "off");
	await page
		.getByRole("textbox", { name: "Send a message" })
		.fill("Respect reduced motion");
	await page.getByRole("button", { name: "Send", exact: true }).click();

	await expect(root).toHaveAttribute("data-chat-state", "active");
	await expect(page.locator("[data-chat-composer-transition]")).toHaveCount(1);
	expect(
		await page
			.locator("[data-chat-composer-transition]")
			.evaluate((element) => getComputedStyle(element).transform)
	).toBe("none");
});
