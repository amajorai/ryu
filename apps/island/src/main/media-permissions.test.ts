import { describe, expect, test } from "bun:test";
import {
	allowsMicrophoneCheck,
	allowsMicrophoneRequest,
} from "./media-permissions.ts";

describe("Island microphone permissions", () => {
	test("allows microphone audio in the Island main frame", () => {
		expect(allowsMicrophoneRequest(true, "media", true, ["audio"])).toBe(true);
		expect(allowsMicrophoneCheck(true, "media", true, "audio")).toBe(true);
	});
	test("denies camera, mixed requests, and unknown media", () => {
		for (const types of [["video"], ["audio", "video"], [], undefined]) {
			expect(allowsMicrophoneRequest(true, "media", true, types)).toBe(false);
		}
		for (const type of ["video", "unknown", undefined]) {
			expect(allowsMicrophoneCheck(true, "media", true, type)).toBe(false);
		}
	});
	test("denies requests from other windows, subframes, and unrelated capabilities", () => {
		for (const [window, frame, permission] of [
			[false, true, "media"],
			[true, false, "media"],
			[true, true, "display-capture"],
		] as const) {
			expect(
				allowsMicrophoneRequest(window, permission, frame, ["audio"])
			).toBe(false);
			expect(allowsMicrophoneCheck(window, permission, frame, "audio")).toBe(
				false
			);
		}
	});
});
