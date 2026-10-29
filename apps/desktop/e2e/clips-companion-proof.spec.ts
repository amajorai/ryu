import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ProofJsonRecord } from "./fixture-json.ts";

const EVIDENCE = process.env.RYU_APPS_STORE_PROOF_DIR
	? path.resolve(process.env.RYU_APPS_STORE_PROOF_DIR)
	: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/evidence"
		);
// A VP9 copy of the bundled demo clip: Playwright's Chromium cannot decode
// H.264, unlike Chrome and the desktop webviews.
const VIDEO_FIXTURE = path.resolve(
	import.meta.dirname,
	"../../../apps-store/clips/ui/e2e/fixtures/podcast-founder.mp4"
);

interface ClipsBridgeCall {
	body?: ProofJsonRecord;
	method: string;
	path: string;
}

interface FixtureState {
	calls: ClipsBridgeCall[];
}

async function resetFixture(
	page: Page,
	view: "create" | "editor",
	failures: Record<string, number> = {}
): Promise<void> {
	const response = await page.request.post("/__fixture/reset", {
		data: { failures },
	});
	expect(response.status()).toBe(200);
	await page.goto(`/?view=${view}`);
	await expect(page.locator(".clips-app")).toHaveAttribute(
		"data-node-status",
		"ready"
	);
}

async function fixtureState(page: Page): Promise<FixtureState> {
	const response = await page.request.get("/__fixture/state");
	expect(response.status()).toBe(200);
	return await response.json();
}

async function callsFor(
	page: Page,
	pathName: string
): Promise<ClipsBridgeCall[]> {
	return (await fixtureState(page)).calls.filter(
		(call) => call.path === pathName
	);
}

async function capture(page: Page, filename: string): Promise<void> {
	await mkdir(EVIDENCE, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE, filename),
	});
}

test("Create analyzes a video link on the node and recovers after node refusal", async ({
	page,
}) => {
	await resetFixture(page, "create", { "/ingest": 1 });
	const videoUrl = "https://media.example.test/founder-interview.mp4";
	const source = page.getByRole("textbox", {
		name: "Video link or node file path",
	});
	await source.fill(videoUrl);
	const ingestButton = page
		.locator(".clips-url-row")
		.getByRole("button", { name: "Analyze on node" });
	await ingestButton.click();
	await expect(
		page.getByText(
			"Node ingest failed: Video ingest is unavailable: fixture unavailable"
		)
	).toBeVisible();
	await expect(source).toHaveValue(videoUrl);
	const failedRequest = (await callsFor(page, "/ingest"))[0];
	expect(failedRequest).toEqual({
		body: { detail: "balanced", source: videoUrl },
		method: "POST",
		path: "/ingest",
	});

	await ingestButton.click();
	await expect(page.locator(".clips-app")).toHaveAttribute(
		"data-view",
		"editor"
	);
	await expect(page.locator(".clips-project-title")).toHaveText(
		"Desktop ingest proof"
	);
	await expect(
		page.getByText("2 moments detected in “Desktop ingest proof”.")
	).toBeVisible();
	const ingestRequests = await callsFor(page, "/ingest");
	expect(ingestRequests).toHaveLength(2);
	expect(ingestRequests[1]).toEqual(failedRequest);
	await capture(page, "clips-url-ingest-retried-editor.png");
});

test("Create requests screen-only capture and recovers when the node refuses", async ({
	page,
}) => {
	await resetFixture(page, "create", { "/start": 1 });
	await page.getByRole("button", { name: "Record screen" }).click();
	await expect(
		page.getByText(
			"Recording could not start: Screen recording is unavailable: fixture unavailable"
		)
	).toBeVisible();
	const failedRequest = (await callsFor(page, "/start"))[0];
	expect(failedRequest).toEqual({
		body: {
			mic: false,
			screen: true,
			systemAudio: false,
			title: "New Clips recording",
		},
		method: "POST",
		path: "/start",
	});

	await page.getByRole("button", { name: "Record screen" }).click();
	await expect(
		page.getByText("Screen recording started on the active node.")
	).toBeVisible();
	const captureRequests = await callsFor(page, "/start");
	expect(captureRequests).toHaveLength(2);
	expect(captureRequests[1]).toEqual(failedRequest);
	await capture(page, "clips-screen-capture-refusal-retry.png");
});

async function importLocalVideo(page: Page): Promise<void> {
	await page.locator('input[type="file"]').setInputFiles(VIDEO_FIXTURE);
	await expect(page.locator(".clips-app")).toHaveAttribute(
		"data-view",
		"editor"
	);
	await expect(
		page.getByText(
			"podcast-founder.mp4 plays here only; browser files are not uploaded."
		)
	).toBeVisible();
	await expect
		.poll(() =>
			page
				.locator("video")
				.evaluate<number, HTMLVideoElement>((video) => video.readyState)
		)
		.toBeGreaterThan(0);
}

test("Local video import starts at zero, edits its range, and exports the source with an honest boundary", async ({
	page,
}) => {
	await resetFixture(page, "create");
	await importLocalVideo(page);

	const playhead = page.getByLabel("Video playhead");
	await expect(playhead).toHaveValue("0");
	await page.getByLabel("Clip start").fill("0:20");
	await page.getByLabel("Clip end").fill("0:30");
	await expect(page.getByLabel("Clip start")).toHaveValue("0:20");
	await expect(page.getByLabel("Clip end")).toHaveValue("0:30");

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download source" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("podcast-founder.mp4");
	await expect(
		page.getByText(
			/Source download requested\. Clips cannot confirm browser completion/
		)
	).toBeVisible();
	await expect(
		page.getByText(/vertical clip rendering is not connected yet/)
	).toBeVisible();
	await capture(page, "clips-local-editor-source-download-boundary.png");
});

test("Editor seeks through active controls and keeps structural placeholders disabled", async ({
	page,
}) => {
	await resetFixture(page, "create");
	await importLocalVideo(page);
	const playhead = page.getByLabel("Video playhead");
	await expect(playhead).toHaveValue("0");
	await page.getByRole("button", { name: "Jump forward 10 seconds" }).click();
	await expect(playhead).toHaveValue("10");
	await page.getByRole("button", { name: "Jump back 10 seconds" }).click();
	await expect(playhead).toHaveValue("0");

	await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Comments unavailable" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Clips settings unavailable" })
	).toBeDisabled();
	await capture(page, "clips-editor-controls-and-disabled-placeholders.png");
});
