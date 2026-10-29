import { describe, expect, it } from "bun:test";
import { createControlledAmbientAudio } from "./ambient-agent-audio.fixture.ts";
import {
	AmbientAudioController,
	clampAmbientVolume,
} from "./ambient-agent-audio.ts";

describe("AmbientAudioController", () => {
	it("reuses one player across syncs and stops cleanly", () => {
		const created: ReturnType<typeof createControlledAmbientAudio>[] = [];
		const controller = new AmbientAudioController((source) => {
			const audio = createControlledAmbientAudio(source);
			created.push(audio);
			return audio;
		});

		controller.sync({
			playing: true,
			source: "/sounds/elevator-4.mp3",
			volume: 0.35,
		});
		controller.sync({
			playing: true,
			source: "/sounds/elevator-4.mp3",
			volume: 0.5,
		});

		expect(created).toHaveLength(1);
		expect(created[0]?.playCount).toBe(1);
		expect(created[0]?.volume).toBe(0.5);

		controller.sync({
			playing: false,
			source: "/sounds/elevator-4.mp3",
			volume: 0.5,
		});
		expect(created[0]?.pauseCount).toBe(1);
		expect(created[0]?.currentTime).toBe(0);

		controller.sync({
			playing: true,
			source: "/sounds/elevator-4.mp3",
			volume: 0.5,
		});
		expect(created).toHaveLength(1);
		expect(created[0]?.playCount).toBe(2);
	});

	it("clamps invalid and out-of-range volume", () => {
		expect(clampAmbientVolume(Number.NaN)).toBe(0);
		expect(clampAmbientVolume(-1)).toBe(0);
		expect(clampAmbientVolume(2)).toBe(1);
	});
});
