import { describe, expect, test } from "bun:test";

import {
	isConnectionUnavailable,
	resolveConnectionPhase,
} from "./connection-status.ts";

describe("connection status contract", () => {
	test("prioritizes device connectivity over node reachability", () => {
		expect(
			resolveConnectionPhase({
				loading: false,
				networkOnline: false,
				nodeReachable: false,
			})
		).toBe("offline");
	});

	test("keeps the shell in a checking state until the first probe finishes", () => {
		expect(
			resolveConnectionPhase({
				loading: true,
				networkOnline: true,
				nodeReachable: null,
			})
		).toBe("checking");
	});

	test("distinguishes an unreachable node from an offline device", () => {
		expect(
			resolveConnectionPhase({
				loading: false,
				networkOnline: true,
				nodeReachable: false,
			})
		).toBe("node-unreachable");
		expect(
			resolveConnectionPhase({
				loading: false,
				networkOnline: true,
				nodeReachable: true,
			})
		).toBe("online");
	});

	test("marks every non-online phase unavailable", () => {
		expect(isConnectionUnavailable("checking")).toBe(true);
		expect(isConnectionUnavailable("node-unreachable")).toBe(true);
		expect(isConnectionUnavailable("offline")).toBe(true);
		expect(isConnectionUnavailable("online")).toBe(false);
	});
});
