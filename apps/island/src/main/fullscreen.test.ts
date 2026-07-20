import { describe, expect, it } from "bun:test";
import { isFullscreenState } from "./fullscreen.ts";

describe("isFullscreenState", () => {
	it("treats fullscreen / presentation states as fullscreen", () => {
		// QUNS_BUSY (fullscreen app or presentation settings)
		expect(isFullscreenState(2)).toBe(true);
		// QUNS_RUNNING_D3D_FULL_SCREEN (exclusive-mode game)
		expect(isFullscreenState(3)).toBe(true);
		// QUNS_PRESENTATION_MODE
		expect(isFullscreenState(4)).toBe(true);
		// QUNS_APP (fullscreen Windows Store / UWP app — "anything fullscreen")
		expect(isFullscreenState(7)).toBe(true);
	});

	it("treats normal / locked / notifiable states as not fullscreen", () => {
		// QUNS_NOT_PRESENT (locked workstation / inactive session)
		expect(isFullscreenState(1)).toBe(false);
		// QUNS_ACCEPTS_NOTIFICATIONS (normal idle desktop)
		expect(isFullscreenState(5)).toBe(false);
		// QUNS_QUIET_TIME
		expect(isFullscreenState(6)).toBe(false);
	});

	it("ignores out-of-range / garbage values", () => {
		expect(isFullscreenState(0)).toBe(false);
		expect(isFullscreenState(99)).toBe(false);
		expect(isFullscreenState(-1)).toBe(false);
	});
});
