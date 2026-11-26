// packages/core-client/src/node-protocol.ts
//
// The protocol number a client and the node (Core) it drives speak to each
// other. It is separate from the release version: a release bumps the version
// every time, while the protocol number moves only when the calls between the
// two change in a way an older side cannot follow.
//
// Each side states the oldest and the newest protocol it speaks. Both pick the
// highest number they share. When they share none, the verdict names the side
// that has to update, so a surface can say "update this app" or "update Core on
// this node" instead of failing in whatever way that mismatch happens to fail.
//
// The Rust copy of these numbers is `crates/core/protocol/src/lib.rs`.
// `tools/protocol-range-contract.test.mjs` fails when the two differ.

/** Oldest protocol this build still speaks. */
export const PROTOCOL_MIN = 1;
/** Newest protocol this build speaks. */
export const PROTOCOL_MAX = 1;
/** What a node counts as when it is too old to report a range. */
export const LEGACY_PROTOCOL = 0;
/**
 * Oldest node protocol a client still accepts. It stays at the legacy protocol
 * in the first release that reports a range, so an app update never locks a
 * user out of a node that is one release behind.
 */
export const CLIENT_ACCEPTS_MIN = 0;

/** The oldest and the newest protocol one side speaks, both included. */
export interface ProtocolRange {
	max: number;
	min: number;
}

/** What a node that reports no range speaks. */
export const LEGACY_PROTOCOL_RANGE: ProtocolRange = {
	max: LEGACY_PROTOCOL,
	min: LEGACY_PROTOCOL,
};

/** What Core reports on `/api/health` in this release. */
export const CORE_PROTOCOL_RANGE: ProtocolRange = {
	max: PROTOCOL_MAX,
	min: PROTOCOL_MIN,
};

/** What a client accepts from the node it talks to. */
export const CLIENT_ACCEPTED_RANGE: ProtocolRange = {
	max: PROTOCOL_MAX,
	min: CLIENT_ACCEPTS_MIN,
};

/** The outcome of comparing a client's range with a node's range. */
export type ProtocolVerdict =
	| {
			client: ProtocolRange;
			compatible: true;
			node: ProtocolRange;
			/** The highest protocol both sides speak. */
			protocol: number;
	  }
	| {
			client: ProtocolRange;
			compatible: false;
			node: ProtocolRange;
			/** The side that has to update before the two can talk. */
			update: "client" | "node";
	  };

function isProtocolNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The range in a `/api/health` body (`"protocol": {"min": 1, "max": 1}`).
 *
 * A body without the field, or with a range that is not two whole numbers in
 * order, is a node that predates the protocol number: protocol 0.
 */
export function reportedProtocolRange(reported: unknown): ProtocolRange {
	if (typeof reported !== "object" || reported === null) {
		return LEGACY_PROTOCOL_RANGE;
	}
	const min: unknown = Reflect.get(reported, "min");
	const max: unknown = Reflect.get(reported, "max");
	if (!(isProtocolNumber(min) && isProtocolNumber(max))) {
		return LEGACY_PROTOCOL_RANGE;
	}
	if (min > max) {
		return LEGACY_PROTOCOL_RANGE;
	}
	return { max, min };
}

/**
 * Pick the highest protocol both sides speak.
 *
 * With no shared number the older side is the one to update: the side whose
 * newest protocol is below the other side's oldest.
 */
export function negotiateProtocol(
	client: ProtocolRange,
	node: ProtocolRange
): ProtocolVerdict {
	const lowest = Math.max(client.min, node.min);
	const highest = Math.min(client.max, node.max);
	if (lowest <= highest) {
		return { client, compatible: true, node, protocol: highest };
	}
	return {
		client,
		compatible: false,
		node,
		update: node.max < client.min ? "node" : "client",
	};
}

/** Compare this build's accepted range with what a node reported. */
export function assessNodeProtocol(reported: unknown): ProtocolVerdict {
	return negotiateProtocol(
		CLIENT_ACCEPTED_RANGE,
		reportedProtocolRange(reported)
	);
}
