// Shared client↔node compatibility. Both rules under test are deliberate:
// WARN-NEVER-BLOCK (every version and channel verdict is advisory) and FAIL-SOFT
// (anything unknown resolves to "fine"). A node that predates a field must never
// be reported as broken for not answering a question nobody used to ask. The one
// hard answer is the protocol range, tested in node-protocol.test.ts.

import { describe, expect, it } from "bun:test";
import {
	assessNode,
	channelOf,
	compareSemver,
	hasCapability,
} from "./node-compat.ts";
import {
	CLIENT_ACCEPTED_RANGE,
	CORE_PROTOCOL_RANGE,
	LEGACY_PROTOCOL,
	LEGACY_PROTOCOL_RANGE,
	PROTOCOL_MAX,
} from "./node-protocol.ts";

describe("channelOf", () => {
	it("derives the channel from the version alone", () => {
		// Mirrors Core's channel_of, so both sides agree with nothing stored.
		expect(channelOf("0.0.18")).toBe("stable");
		expect(channelOf("v0.0.18")).toBe("stable");
		expect(channelOf("0.0.18-nightly.20260802.23")).toBe("nightly");
		expect(channelOf("0.0.18-canary.4")).toBe("canary");
		expect(channelOf("0.0.18-beta.1")).toBe("beta");
		// Build metadata is not a channel.
		expect(channelOf("0.0.18+f1a68ac")).toBe("stable");
		expect(channelOf("0.0.18-nightly.3+f1a68ac")).toBe("nightly");
	});

	it("fails soft on a missing version", () => {
		expect(channelOf(null)).toBe("stable");
		expect(channelOf(undefined)).toBe("stable");
		expect(channelOf("")).toBe("stable");
	});
});

describe("assessNode", () => {
	it("catches channel skew the version comparison cannot see", () => {
		// The blind spot: compareSemver discards the prerelease, so a stable and a
		// canary build of the SAME version compare equal and no version check could
		// ever flag the pairing.
		expect(compareSemver("0.0.18", "0.0.18-canary.4")).toBe(0);
		const v = assessNode("0.0.18", {
			status: "ok",
			version: "0.0.18-canary.4",
		});
		expect(v.channelMismatch).toEqual({ client: "stable", node: "canary" });
		expect(v.ok).toBe(false);
	});

	it("prefers the channel the node reports over deriving it", () => {
		const v = assessNode("0.0.18", {
			channel: "nightly",
			status: "ok",
			version: "0.0.18",
		});
		expect(v.channelMismatch).toEqual({ client: "stable", node: "nightly" });
	});

	it("flags a newer node — the lapsed-updates case", () => {
		// A client whose update window ended, driving a node that kept moving. Not
		// an error: a prompt that some node features may not render here.
		const v = assessNode("0.0.18", { status: "ok", version: "0.1.0" });
		expect(v.nodeIsNewer).toBe(true);
		expect(v.protocol.compatible).toBe(true);
		expect(v.ok).toBe(false);
	});

	it("is silent when client and node agree", () => {
		const v = assessNode("0.0.18", {
			protocol: CORE_PROTOCOL_RANGE,
			status: "ok",
			version: "0.0.18",
		});
		expect(v).toEqual({
			channelMismatch: null,
			nodeIsNewer: false,
			ok: true,
			protocol: {
				client: CLIENT_ACCEPTED_RANGE,
				compatible: true,
				node: CORE_PROTOCOL_RANGE,
				protocol: PROTOCOL_MAX,
			},
		});
	});

	it("an older node is not newer, and a node without a range is protocol 0", () => {
		const v = assessNode("0.1.0", { status: "ok", version: "0.0.18" });
		expect(v.nodeIsNewer).toBe(false);
		expect(v.ok).toBe(true);
		expect(v.protocol).toEqual({
			client: CLIENT_ACCEPTED_RANGE,
			compatible: true,
			node: LEGACY_PROTOCOL_RANGE,
			protocol: LEGACY_PROTOCOL,
		});
	});

	it("names the side to update when the two share no protocol", () => {
		// A node that dropped every protocol this client speaks. Same release
		// version and channel, so only the protocol range can see it.
		const node = { max: PROTOCOL_MAX + 2, min: PROTOCOL_MAX + 1 };
		const v = assessNode("0.0.18", {
			protocol: node,
			status: "ok",
			version: "0.0.18",
		});
		expect(v.ok).toBe(false);
		expect(v.protocol).toEqual({
			client: CLIENT_ACCEPTED_RANGE,
			compatible: false,
			node,
			update: "client",
		});
		// It is also reported for a node that sends no version at all.
		expect(assessNode("0.0.18", { protocol: node, status: "ok" }).ok).toBe(
			false
		);
	});

	it("fails soft when either side has no version", () => {
		expect(assessNode("0.0.18", { status: "ok", version: null }).ok).toBe(true);
		expect(assessNode(null, { status: "ok", version: "0.1.0" }).ok).toBe(true);
		expect(assessNode("0.0.18", null).ok).toBe(true);
	});
});

describe("capabilities", () => {
	it("treats a node with no capability list as having everything", () => {
		// Otherwise upgrading the client would silently hide features that work.
		expect(hasCapability(undefined, "spaces")).toBe(true);
		expect(hasCapability([], "spaces")).toBe(true);
		expect(hasCapability(["spaces"], "spaces")).toBe(true);
		expect(hasCapability(["other"], "spaces")).toBe(false);
	});
});
