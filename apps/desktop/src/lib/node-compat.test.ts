// apps/desktop/src/lib/node-compat.test.ts
//
// Tests for the desktop node compatibility helpers. Version comparison and
// capability negotiation are deliberately FAIL-SOFT: an unparseable/absent
// version or capability list must never falsely hide a feature. These tests pin
// the semver comparison ladder, the protocol range the desktop accepts, and
// the "no list ⇒ has everything" capability rule.

import { describe, expect, it } from "bun:test";
import {
	assessNodeProtocol,
	CLIENT_ACCEPTED_RANGE,
	CORE_PROTOCOL_RANGE,
	channelMismatch,
	channelOf,
	compareSemver,
	hasCapability,
} from "./node-compat.ts";

describe("compareSemver", () => {
	it("orders by major, then minor, then patch", () => {
		expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
		expect(compareSemver("1.2.0", "1.1.0")).toBe(1);
		expect(compareSemver("1.1.1", "1.1.2")).toBe(-1);
		expect(compareSemver("1.1.1", "1.1.1")).toBe(0);
	});

	it("tolerates a leading v and surrounding whitespace", () => {
		expect(compareSemver("  v1.2.3 ", "1.2.3")).toBe(0);
		expect(compareSemver("v2.0.0", "v1.9.9")).toBe(1);
	});

	it("ignores a pre-release/build suffix (matches the numeric core only)", () => {
		expect(compareSemver("1.2.3-beta.1", "1.2.3")).toBe(0);
	});

	it("fails soft to equal (0) when EITHER side is unparseable", () => {
		expect(compareSemver("not-a-version", "1.0.0")).toBe(0);
		expect(compareSemver("1.0.0", "garbage")).toBe(0);
		expect(compareSemver("", "")).toBe(0);
	});
});

describe("assessNodeProtocol", () => {
	it("accepts a node that reports no protocol range (protocol 0)", () => {
		// The first release with the range must still adopt a Core without it.
		expect(CLIENT_ACCEPTED_RANGE.min).toBe(0);
		for (const reported of [undefined, null, {}, "1"]) {
			expect(assessNodeProtocol(reported)).toMatchObject({
				compatible: true,
				protocol: 0,
			});
		}
	});

	it("accepts the range this release of Core reports", () => {
		expect(assessNodeProtocol(CORE_PROTOCOL_RANGE)).toMatchObject({
			compatible: true,
			protocol: CORE_PROTOCOL_RANGE.max,
		});
	});

	it("names the app as the side to update for a node above its range", () => {
		const node = {
			max: CLIENT_ACCEPTED_RANGE.max + 2,
			min: CLIENT_ACCEPTED_RANGE.max + 1,
		};
		expect(assessNodeProtocol(node)).toEqual({
			client: CLIENT_ACCEPTED_RANGE,
			compatible: false,
			node,
			update: "client",
		});
	});
});

describe("hasCapability", () => {
	it("reports true for a listed capability", () => {
		expect(hasCapability(["ghost", "shadow"], "shadow")).toBe(true);
	});

	it("reports false for an absent capability when a list is present", () => {
		expect(hasCapability(["ghost"], "shadow")).toBe(false);
	});

	it("treats an undefined or empty list as legacy 'has everything'", () => {
		expect(hasCapability(undefined, "anything")).toBe(true);
		expect(hasCapability([], "anything")).toBe(true);
	});
});

describe("channelOf", () => {
	it("reads the channel out of the version itself", () => {
		// Mirrors Core's channel_of, so both sides agree without storing anything.
		expect(channelOf("0.0.18")).toBe("stable");
		expect(channelOf("v0.0.18")).toBe("stable");
		expect(channelOf("0.0.18-nightly.20260802.23")).toBe("nightly");
		expect(channelOf("0.0.18-canary.4")).toBe("canary");
		expect(channelOf("0.0.18-beta.1")).toBe("beta");
		// Build metadata is not a channel.
		expect(channelOf("0.0.18-nightly.3+f1a68ac")).toBe("nightly");
		expect(channelOf("0.0.18+f1a68ac")).toBe("stable");
	});

	it("fails soft on a missing version", () => {
		expect(channelOf(null)).toBe("stable");
		expect(channelOf(undefined)).toBe("stable");
		expect(channelOf("")).toBe("stable");
	});
});

describe("channelMismatch", () => {
	it("catches skew the version floor cannot see", () => {
		// The exact blind spot: compareSemver discards the prerelease, so these two
		// compare EQUAL and no version check could ever flag them.
		expect(compareSemver("0.0.18", "0.0.18-canary.4")).toBe(0);
		expect(channelMismatch("0.0.18", "0.0.18-canary.4")).toEqual({
			desktop: "stable",
			node: "canary",
		});
	});

	it("is silent when both sides agree", () => {
		expect(channelMismatch("0.0.18", "0.0.19")).toBeNull();
		expect(channelMismatch("0.0.18-nightly.1", "0.0.19-nightly.2")).toBeNull();
	});

	it("fails soft when either version is unknown", () => {
		expect(channelMismatch(null, "0.0.18-canary.1")).toBeNull();
		expect(channelMismatch("0.0.18", null)).toBeNull();
	});
});
