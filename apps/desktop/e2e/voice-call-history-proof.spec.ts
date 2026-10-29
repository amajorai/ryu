import { writeFile } from "node:fs/promises";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

type NativeMicRelease = Parameters<
	ConstructorParameters<typeof Promise<void>>[0]
>[0];

declare const window: typeof globalThis.window & {
	voiceAudioProof: {
		audioContexts: AudioContext[];
		ringSources: AudioBufferSourceNode[];
	};
	releaseVoiceMic: NativeMicRelease;
	voiceMicTracks?: MediaStreamTrack[];
};

test.describe.configure({ timeout: 180_000 });

const STORY_URL = "/voice-call-history-proof.html";

test("a microphone permission failure stops ringing and shows the error", async ({
	page,
}) => {
	await observeAudio(page);
	await page.route("**/proof-history", (route) => route.fulfill({ json: [] }));
	await page.addInitScript(() => {
		navigator.mediaDevices.getUserMedia = () =>
			Promise.reject(
				new DOMException("Microphone access denied", "NotAllowedError")
			);
	});
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Start voice call" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Microphone access denied"
	);
	await expect(page.getByTestId("voice-call-screen")).toHaveCount(0);
	await expect
		.poll(async () => (await audioState(page)).states[0])
		.toBe("closed");
	await expect(page.getByText(/Call ended/)).toHaveCount(0);
});

async function observeAudio(page: Page) {
	await page.addInitScript(() => {
		const audioContexts: AudioContext[] = [];
		const ringSources: AudioBufferSourceNode[] = [];
		const NativeAudioContext = window.AudioContext;
		class ObservedAudioContext extends NativeAudioContext {
			constructor(options?: AudioContextOptions) {
				super(options);
				audioContexts.push(this);
			}
			override createBufferSource() {
				const source = super.createBufferSource();
				ringSources.push(source);
				return source;
			}
		}
		window.AudioContext = ObservedAudioContext;
		Object.assign(window, { voiceAudioProof: { audioContexts, ringSources } });
	});
}

async function audioState(page: Page) {
	return page.evaluate(() => {
		const proof = window.voiceAudioProof;
		const ring = proof.ringSources[0]?.buffer;
		const samples = ring?.getChannelData(0);
		const energy = (start: number, end: number) => {
			if (!(samples && ring)) {
				return 0;
			}
			let result = 0;
			for (
				let index = Math.floor(start * ring.sampleRate);
				index < end * ring.sampleRate;
				index += 1
			) {
				result += (samples[index] ?? 0) ** 2;
			}
			return result;
		};
		return {
			states: proof.audioContexts.map((context) => context.state),
			loop: proof.ringSources[0]?.loop,
			firstRing: energy(0.01, 0.39),
			gap: energy(0.41, 0.59),
			secondRing: energy(0.61, 0.99),
			pause: energy(1.01, 2.99),
		};
	});
}

test("rings until pickup, saves a user call summary, and keeps it after reload", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await observeAudio(page);
	const history = [
		{
			id: "previous",
			role: "assistant",
			parts: [
				{
					type: "text",
					text: "We can talk through your next step whenever you're ready.",
				},
			],
		},
	];
	await page.route("**/proof-history", (route) =>
		route.fulfill({ json: history })
	);
	await page.route("**/api/ws/ticket", (route) =>
		route.fulfill({ json: { ticket: "proof-ticket" } })
	);
	let socket: WebSocketRoute | undefined;
	let started = false;
	let ended = 0;
	await page.routeWebSocket(/\/api\/voice\/ws/, (route) => {
		socket = route;
		route.onMessage((raw) => {
			if (!isNativeText(raw)) {
				return;
			}
			const frame = JSON.parse(raw);
			if (frame.type === "start") {
				started = true;
			}
			if (frame.type === "end") {
				ended += 1;
				const content = "Call ended · 01:24";
				history.push({
					id: "saved-call",
					role: "user",
					parts: [{ type: "text", text: content }],
				});
				route.send(
					JSON.stringify({
						type: "call_ended",
						messageId: "saved-call",
						conversationId: "voice-history-proof",
						durationSeconds: 84,
						content,
					})
				);
			}
		});
	});
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Start voice call" }).click();
	await expect(page.getByTestId("voice-call-screen")).toContainText(
		"Connecting…"
	);
	await expect.poll(() => started).toBe(true);
	await expect(page.getByTestId("voice-call-duration")).toHaveText("00:00");
	const ringing = await audioState(page);
	expect(ringing.states[0]).toBe("running");
	expect(ringing.loop).toBe(true);
	expect(ringing.firstRing).toBeGreaterThan(1);
	expect(ringing.secondRing).toBeGreaterThan(1);
	expect(ringing.gap).toBe(0);
	expect(ringing.pause).toBe(0);
	await page.screenshot({
		path: testInfo.outputPath("connecting.png"),
		fullPage: true,
	});
	if (!socket) {
		throw new Error("Voice socket was not opened");
	}
	socket.send(
		JSON.stringify({
			type: "ready",
			session_id: "voice-proof",
			tts_sample_rate: 24_000,
		})
	);
	await expect(page.getByTestId("voice-call-screen")).not.toContainText(
		"Connecting…"
	);
	await expect
		.poll(async () => (await audioState(page)).states[0])
		.toBe("closed");
	await expect(page.getByTestId("voice-call-duration")).toHaveText("00:01");
	await page.getByRole("button", { name: "End call", exact: true }).click();
	await expect(page.getByTestId("voice-call-screen")).toHaveCount(0);
	await expect(
		page.getByText("Call ended · 01:24", { exact: true })
	).toBeVisible();
	expect(ended).toBe(1);
	await expect
		.poll(async () =>
			(await audioState(page)).states.every((state) => state === "closed")
		)
		.toBe(true);
	await page.reload();
	await expect(page.getByTestId("call-ended-message-icon")).toBeVisible();
	await expect(page.getByTestId("call-ended-message-icon")).toHaveAttribute(
		"aria-hidden",
		"true"
	);
	await expect(page.getByTestId("call-ended-message-icon")).toHaveCount(1);
	await expect(
		page.getByText("Call ended · 01:24", { exact: true })
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("call-ended-history.png"),
		fullPage: true,
	});
	expect(errors).toEqual([]);
	await testInfo.attach("voice-lifecycle-log", {
		body: JSON.stringify({ ringing, ended, errors }, null, 2),
		contentType: "application/json",
	});
	await writeFile(
		testInfo.outputPath("voice-lifecycle-log.json"),
		`${JSON.stringify({ ringing, ended, errors }, null, 2)}\n`
	);
});

test("canceling before microphone access resolves never opens a late call", async ({
	page,
}) => {
	await observeAudio(page);
	await page.route("**/proof-history", (route) => route.fulfill({ json: [] }));
	let ticketRequests = 0;
	await page.route("**/api/ws/ticket", (route) => {
		ticketRequests += 1;
		return route.fulfill({ json: { ticket: "proof" } });
	});
	await page.addInitScript(() => {
		const original = navigator.mediaDevices.getUserMedia.bind(
			navigator.mediaDevices
		);
		navigator.mediaDevices.getUserMedia = async (constraints) => {
			await new Promise<void>((resolve) =>
				Object.assign(window, { releaseVoiceMic: resolve })
			);
			const stream = await original(constraints);
			Object.assign(window, { voiceMicTracks: stream.getTracks() });
			return stream;
		};
	});
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Start voice call" }).click();
	await expect(page.getByTestId("voice-call-screen")).toContainText(
		"Connecting…"
	);
	await page.getByRole("button", { name: "End call", exact: true }).click();
	await expect
		.poll(async () => (await audioState(page)).states[0])
		.toBe("closed");
	await page.evaluate(() => window.releaseVoiceMic());
	await expect(page.getByTestId("voice-call-screen")).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const tracks = window.voiceMicTracks;
				return (
					tracks?.length &&
					tracks.every((track) => track.readyState === "ended")
				);
			})
		)
		.toBe(true);
	expect(ticketRequests).toBe(0);
	await expect(page.getByText(/Call ended/)).toHaveCount(0);
});
