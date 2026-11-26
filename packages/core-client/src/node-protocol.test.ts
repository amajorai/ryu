// The protocol range between a client and the node it drives: the negotiation
// table, the legacy (protocol 0) case, and how a `/api/health` body is read.

import { describe, expect, it } from "bun:test";
import {
	assessNodeProtocol,
	CLIENT_ACCEPTED_RANGE,
	CLIENT_ACCEPTS_MIN,
	CORE_PROTOCOL_RANGE,
	LEGACY_PROTOCOL,
	LEGACY_PROTOCOL_RANGE,
	negotiateProtocol,
	PROTOCOL_MAX,
	PROTOCOL_MIN,
	reportedProtocolRange,
} from "./node-protocol.ts";

const range = (min: number, max: number) => ({ max, min });

describe("negotiateProtocol", () => {
	it("picks the newest protocol of two equal ranges", () => {
		expect(negotiateProtocol(range(1, 1), range(1, 1))).toEqual({
			client: range(1, 1),
			compatible: true,
			node: range(1, 1),
			protocol: 1,
		});
		expect(negotiateProtocol(range(2, 4), range(2, 4))).toMatchObject({
			compatible: true,
			protocol: 4,
		});
	});

	it("picks the highest shared protocol of overlapping ranges", () => {
		expect(negotiateProtocol(range(1, 3), range(2, 5))).toMatchObject({
			compatible: true,
			protocol: 3,
		});
		expect(negotiateProtocol(range(2, 5), range(1, 3))).toMatchObject({
			compatible: true,
			protocol: 3,
		});
		expect(negotiateProtocol(range(1, 5), range(3, 3))).toMatchObject({
			compatible: true,
			protocol: 3,
		});
	});

	it("names the node when the node is below the client's range", () => {
		expect(negotiateProtocol(range(3, 4), range(1, 2))).toEqual({
			client: range(3, 4),
			compatible: false,
			node: range(1, 2),
			update: "node",
		});
	});

	it("names the client when the node is above the client's range", () => {
		expect(negotiateProtocol(range(1, 2), range(3, 4))).toEqual({
			client: range(1, 2),
			compatible: false,
			node: range(3, 4),
			update: "client",
		});
	});
});

describe("protocol 0, a node that predates the protocol number", () => {
	it("is still accepted by a client in this release", () => {
		// The first release with the check must not lock anyone out on update day.
		expect(CLIENT_ACCEPTS_MIN).toBe(LEGACY_PROTOCOL);
		expect(assessNodeProtocol(undefined)).toEqual({
			client: CLIENT_ACCEPTED_RANGE,
			compatible: true,
			node: LEGACY_PROTOCOL_RANGE,
			protocol: LEGACY_PROTOCOL,
		});
	});

	it("is refused, naming the node, once a client stops accepting it", () => {
		const laterClient = range(1, 2);
		expect(negotiateProtocol(laterClient, LEGACY_PROTOCOL_RANGE)).toEqual({
			client: laterClient,
			compatible: false,
			node: LEGACY_PROTOCOL_RANGE,
			update: "node",
		});
	});
});

describe("assessNodeProtocol", () => {
	it("picks the current protocol from a current Core", () => {
		expect(assessNodeProtocol(CORE_PROTOCOL_RANGE)).toMatchObject({
			compatible: true,
			protocol: PROTOCOL_MAX,
		});
	});

	it("tells the user to update the app for a node that dropped its protocols", () => {
		const newer = range(PROTOCOL_MAX + 1, PROTOCOL_MAX + 2);
		expect(assessNodeProtocol(newer)).toEqual({
			client: CLIENT_ACCEPTED_RANGE,
			compatible: false,
			node: newer,
			update: "client",
		});
	});
});

describe("reportedProtocolRange", () => {
	it("reads a range of two whole numbers in order", () => {
		expect(reportedProtocolRange({ max: 4, min: 1 })).toEqual(range(1, 4));
		expect(reportedProtocolRange({ max: 1, min: 1, extra: true })).toEqual(
			range(1, 1)
		);
	});

	it("treats anything else as a node without a range", () => {
		for (const reported of [
			undefined,
			null,
			"1",
			7,
			[],
			{},
			{ min: 1 },
			{ max: 2, min: 3 },
			{ max: "1", min: "1" },
			{ max: 1.5, min: 1 },
			{ max: 1, min: -1 },
		]) {
			expect(reportedProtocolRange(reported)).toEqual(LEGACY_PROTOCOL_RANGE);
		}
	});
});

describe("the constants", () => {
	it("form valid ranges", () => {
		expect(PROTOCOL_MIN).toBeLessThanOrEqual(PROTOCOL_MAX);
		expect(CLIENT_ACCEPTS_MIN).toBeLessThanOrEqual(PROTOCOL_MIN);
		expect(LEGACY_PROTOCOL).toBeLessThan(PROTOCOL_MIN);
		expect(CORE_PROTOCOL_RANGE).toEqual(range(PROTOCOL_MIN, PROTOCOL_MAX));
		expect(CLIENT_ACCEPTED_RANGE).toEqual(
			range(CLIENT_ACCEPTS_MIN, PROTOCOL_MAX)
		);
	});
});
