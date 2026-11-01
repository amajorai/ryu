import { expect, test } from "@playwright/test";
import { dubbingScript } from "../../../apps-store/video-studio/shared/dubbing.ts";
import {
	createProject,
	type FixtureLegacyModelCapabilityObservation,
	openOverflowTab,
	readAssets,
	readGenerationJobs,
	readProject,
	saveProject,
	saveScreenshot,
	selectProject,
	uniqueTitle,
} from "./video-studio-remaining-panels-proof.helpers.ts";

test("caption translation and dubbing recover through local fixtures and appear in generation history", async ({
	page,
}) => {
	const title = uniqueTitle("Caption generation history");
	const projectId = await createProject(page, title);
	await openOverflowTab(page, "Captions", "captions");
	const subtitleChooserPromise = page.waitForEvent("filechooser");
	await page
		.getByRole("button", { name: "Import SRT / VTT", exact: true })
		.click();
	await (await subtitleChooserPromise).setFiles({
		name: "panel-captions.srt",
		mimeType: "text/plain",
		buffer: Buffer.from(
			"1\n00:00:00,500 --> 00:00:01,750\nThe harbor is waking.\n\n"
		),
	});
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"The harbor is waking."
	);
	await saveProject(page);
	const original = await readProject(page, projectId);
	expect(original.captions[0]).toMatchObject({ start: 0.5, end: 1.75 });
	await page.reload();
	await selectProject(page, projectId);
	await openOverflowTab(page, "Captions", "captions");
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"The harbor is waking."
	);

	const languageField = page.getByLabel("Caption translation language");
	await languageField.fill("French");
	await expect(languageField).toHaveValue("French");
	const bridgeState = await page.evaluate(() => ({
		captionText: document.querySelector<HTMLInputElement>(
			'[aria-label="Caption 1"]'
		)?.value,
		// SAFETY: This single capability read observes the legacy model.complete
		// property installed by this fixture host. Other bridge fields are not
		// validated or promoted to the production RyuBridge contract.
		modelComplete:
			(
				window as Omit<Window, "ryu"> & {
					ryu?: FixtureLegacyModelCapabilityObservation;
				}
			).ryu?.model?.complete instanceof Function,
		translationLanguage: document.querySelector<HTMLInputElement>(
			'[aria-label="Caption translation language"]'
		)?.value,
		proofCalls: window.__videoStudioRemainingProof?.translationCalls.length,
	}));
	expect(bridgeState).toMatchObject({
		captionText: "The harbor is waking.",
		modelComplete: true,
		translationLanguage: "French",
		proofCalls: 0,
	});
	const translateButton = page.getByRole("button", {
		name: "Translate with Ryu",
	});
	await expect(translateButton).toBeEnabled();
	const translationFailure = await page.request.post(
		"/__proof/arm-translation-failure"
	);
	expect(translationFailure.ok()).toBe(true);
	await translateButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture caption translation failed once."
	);
	expect((await readProject(page, projectId)).captions[0]?.text).toBe(
		"The harbor is waking."
	);
	await expect(translateButton).toBeEnabled();
	await translateButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Translated captions are ready for review. Their timings were preserved."
	);
	await saveProject(page);
	let saved = await readProject(page, projectId);
	const translatedTrack = saved.captionTracks.find(
		(track) => track.language === "French"
	);
	expect(translatedTrack?.captions[0]).toMatchObject({
		end: 1.75,
		start: 0.5,
		text: "Bonjour: The harbor is waking.",
	});
	expect(saved.captionTrackId).toBe(translatedTrack?.id);
	const modelCalls = await page.evaluate(
		() => window.__videoStudioRemainingProof?.translationCalls ?? []
	);
	expect(modelCalls).toHaveLength(2);
	expect(JSON.parse(modelCalls[0]?.prompt ?? "{}")).toMatchObject({
		language: "French",
		captions: [{ text: "The harbor is waking." }],
	});

	const dubbingLanguage = page.getByLabel("Dubbing language");
	const dubbingVoice = page.getByLabel("Dubbing voice");
	const dubbingSpeed = page.getByLabel("Dubbing speed");
	await dubbingLanguage.fill("fr-FR");
	await dubbingVoice.fill("Harbor narrator");
	await dubbingSpeed.fill("1.2");
	const dubButton = page.getByRole("button", { name: "Create dubbed track" });
	await expect(dubButton).toBeEnabled();
	const dubbingFailure = await page.request.post(
		"/__proof/arm-dubbing-failure"
	);
	expect(dubbingFailure.ok()).toBe(true);
	await dubButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture dubbing failed once."
	);
	const failedJobs = await readGenerationJobs(page, projectId);
	expect(failedJobs).toHaveLength(1);
	expect(failedJobs[0]).toMatchObject({
		message: "Fixture dubbing failed once.",
		request: {
			kind: "audio",
			language: "fr-FR",
			projectId,
			prompt: dubbingScript(translatedTrack?.captions ?? []),
			route: "node-default",
			speed: 1.2,
			voice: "Harbor narrator",
		},
		status: "incomplete",
	});
	await expect(dubButton).toBeEnabled();
	await dubButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Dubbed audio saved and added to the timeline. Review pronunciation and timing."
	);
	await saveProject(page);
	saved = await readProject(page, projectId);
	expect(saved.captionTrackId).toBe(translatedTrack?.id);
	expect(
		saved.captionTracks.find((track) => track.id === translatedTrack?.id)
			?.captions[0]
	).toMatchObject({
		start: 0.5,
		end: 1.75,
		text: "Bonjour: The harbor is waking.",
	});
	const audioAssetId = saved.segments.find(
		(segment) => segment.track === 1
	)?.assetId;
	expect(audioAssetId).toBeTruthy();
	const audioAsset = (await readAssets(page)).find(
		(asset) => asset.id === audioAssetId
	);
	expect(audioAsset).toMatchObject({
		kind: "audio",
		name: "Dubbed captions fr-FR.wav",
	});

	const dubCalls = await page.evaluate(
		() => window.__videoStudioRemainingProof?.ttsCalls ?? []
	);
	expect(dubCalls).toHaveLength(2);
	const expectedScript = dubbingScript(translatedTrack?.captions ?? []);
	expect(
		dubCalls.map((call) => ({
			language: call.language,
			speed: call.speed,
			text: call.text,
			voice: call.voice,
		}))
	).toEqual([
		{
			language: "fr-FR",
			speed: 1.2,
			text: expectedScript,
			voice: "Harbor narrator",
		},
		{
			language: "fr-FR",
			speed: 1.2,
			text: expectedScript,
			voice: "Harbor narrator",
		},
	]);

	await openOverflowTab(page, "Generate", "generate");
	await expect(
		page.getByRole("heading", { name: "Generation history" })
	).toBeVisible();
	const failedHistory = page
		.locator("details.studio-scene")
		.filter({ hasText: "Fixture dubbing failed once." });
	await expect(failedHistory).not.toHaveAttribute("open", "");
	await failedHistory.locator("summary").click();
	await expect(failedHistory).toHaveAttribute("open", "");
	await expect(failedHistory).toContainText(
		"Voice: Harbor narrator · Language: fr-FR · Rate: 1.2×"
	);
	await expect(failedHistory).toContainText(
		"Check the provider before retrying; this request may already have incurred a charge."
	);
	const completedHistory = page.locator("details.studio-scene").filter({
		hasText:
			"Caption timing was retained; review the generated audio duration.",
	});
	await expect(completedHistory).not.toHaveAttribute("open", "");
	await completedHistory.locator("summary").click();
	await expect(completedHistory).toHaveAttribute("open", "");
	await expect(completedHistory).toContainText(
		`Saved media: ${audioAsset?.name}`
	);
	const allJobs = await readGenerationJobs(page, projectId);
	expect(allJobs.map((job) => job.status).sort()).toEqual([
		"completed",
		"incomplete",
	]);
	await saveScreenshot(
		page,
		"video-studio-remaining-caption-generation-history.png"
	);
});
