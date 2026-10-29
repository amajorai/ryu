import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

interface VoiceProcessorObservation {
	onaudioprocess:
		| ((event: {
				inputBuffer: { getChannelData: (channel: number) => Float32Array };
		  }) => void)
		| null;
}

declare global {
	interface Window {
		__ryuVoiceProcessor?: VoiceProcessorObservation | null;
	}
}

const STORY_URL = "/composer-interaction-proof.html";

async function installVoiceMocks(page: Page) {
	await page.addInitScript(() => {
		let processor: {
			onaudioprocess:
				| ((event: {
						inputBuffer: { getChannelData: (channel: number) => Float32Array };
				  }) => void)
				| null;
			connect: () => void;
			disconnect: () => void;
		} | null = null;
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: async () => ({
					getTracks: () => [{ stop: () => undefined }],
				}),
			},
		});

		class MockAudioContext {
			destination = {};
			sampleRate = 16_000;

			createAnalyser() {
				return {
					disconnect: () => undefined,
					fftSize: 256,
					getByteTimeDomainData: (data: Uint8Array) => data.fill(128),
				};
			}

			createMediaStreamSource() {
				return {
					connect: () => undefined,
					disconnect: () => undefined,
				};
			}

			createScriptProcessor() {
				processor = {
					connect: () => undefined,
					disconnect: () => undefined,
					onaudioprocess: null,
				};
				return processor;
			}

			close() {
				return Promise.resolve();
			}
		}

		Object.defineProperty(window, "AudioContext", {
			configurable: true,
			value: MockAudioContext,
		});
		Object.defineProperty(window, "__ryuVoiceProcessor", {
			configurable: true,
			get: () => processor,
		});
	});
}

test("shows voice input inside an Other answer", async ({ page }) => {
	await page.goto(STORY_URL);
	const shell = page.getByTestId("composer-shell");
	await shell.locator("textarea").fill("Keep this draft intact");
	await page.getByRole("button", { name: "Show question with Other" }).click();

	await expect(shell.locator("textarea")).toBeVisible();
	await expect(shell.locator("[data-composer-prompt='question']")).toHaveCount(
		0
	);
	await expect(
		page.getByText("Where should I continue?", { exact: true })
	).toBeVisible({ timeout: 5000 });
	await expect(shell.locator("textarea")).toHaveCount(0);
	await expect(
		shell.locator("[data-composer-prompt='question']")
	).toBeVisible();
	await expect(shell.getByRole("textbox", { name: "Other" })).toBeVisible();
	await expect(
		shell.getByRole("button", { name: "Start voice input" })
	).toBeVisible();
	await expect(page.getByTestId("mode")).toHaveText("question");
});

test("transcribes into the Other answer input", async ({ page }) => {
	await installVoiceMocks(page);
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Show question with Other" }).click();

	const shell = page.getByTestId("composer-shell");
	const otherInput = shell.getByRole("textbox", { name: "Other" });
	await shell.getByRole("button", { name: "Start voice input" }).click();
	await expect(
		shell.getByRole("button", { name: "Stop recording" })
	).toBeVisible();
	await page.evaluate(() => {
		const processor = window.__ryuVoiceProcessor;
		processor?.onaudioprocess?.({
			inputBuffer: { getChannelData: () => new Float32Array(512) },
		});
	});
	await shell.getByRole("button", { name: "Stop recording" }).click();
	await expect(otherInput).toHaveValue("A spoken answer");
});

test("shows voice input inside a free-text question", async ({ page }) => {
	await page.goto(STORY_URL);
	const shell = page.getByTestId("composer-shell");
	await page.getByRole("button", { name: "Show text question" }).click();

	await expect(
		page.getByText("What should I do next?", { exact: true })
	).toBeVisible({ timeout: 5000 });
	await expect(
		shell.getByPlaceholder("Describe what should happen next")
	).toBeVisible();
	await expect(
		shell.getByRole("button", { name: "Start voice input" })
	).toBeVisible();
});

test("uses the same typing debounce for tool approvals and returns to the editor", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const shell = page.getByTestId("composer-shell");
	await shell.locator("textarea").fill("I am still writing");
	await page.getByRole("button", { name: "Show tool approval" }).click();

	await expect(shell.locator("textarea")).toBeVisible();
	await expect(shell.locator("[data-composer-prompt='approval']")).toHaveCount(
		0
	);
	await expect(
		page.getByText("Permission required", { exact: true })
	).toBeVisible({ timeout: 5000 });
	await expect(shell.locator("textarea")).toHaveCount(0);
	await expect(
		shell.locator("[data-composer-prompt='approval']")
	).toBeVisible();
	await expect(page.getByText("Allow once", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Allow once" }).click();
	await expect(shell.locator("textarea")).toBeVisible({ timeout: 5000 });
	await expect(shell.locator("[data-composer-prompt='approval']")).toHaveCount(
		0
	);
});
