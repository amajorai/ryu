import { describe, expect, test } from "bun:test";
import {
	isConnectionUnavailable,
	resolveConnectionPhase,
} from "./connectivity.ts";

describe("connection phase", () => {
	test("prioritizes the browser offline signal", () => {
		expect(
			resolveConnectionPhase({
				browserOnline: false,
				loading: false,
				nodeReachable: true,
			})
		).toBe("offline");
	});

	test("reports the initial probe as checking", () => {
		expect(
			resolveConnectionPhase({
				browserOnline: true,
				loading: true,
				nodeReachable: null,
			})
		).toBe("checking");
	});

	test("distinguishes an unreachable node from browser offline", () => {
		expect(
			resolveConnectionPhase({
				browserOnline: true,
				loading: false,
				nodeReachable: false,
			})
		).toBe("node-unreachable");
	});

	test("reports an answered node as online", () => {
		expect(
			resolveConnectionPhase({
				browserOnline: true,
				loading: false,
				nodeReachable: true,
			})
		).toBe("online");
		expect(isConnectionUnavailable("online")).toBe(false);
		expect(isConnectionUnavailable("checking")).toBe(true);
	});
});
