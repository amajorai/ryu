/**
 * The platform-neutral connection state used by every Ryu client.
 *
 * `nodeReachable` is deliberately tri-state: null means that the host has not
 * completed its probe yet, false means the selected node answered with a
 * failure or did not answer, and true means the selected node is reachable.
 * Host clients own the actual probe because Desktop, browser, and native use
 * different networking APIs.
 */

export type ConnectionPhase =
	| "checking"
	| "node-unreachable"
	| "offline"
	| "online";

export interface ConnectionPhaseInput {
	loading: boolean;
	networkOnline: boolean;
	nodeReachable: boolean | null;
}

/**
 * Resolve the stable user-facing state from a host network signal and the
 * selected node probe. Device/network loss wins because it explains why the
 * node cannot be reached.
 */
export function resolveConnectionPhase({
	loading,
	networkOnline,
	nodeReachable,
}: ConnectionPhaseInput): ConnectionPhase {
	if (!networkOnline) {
		return "offline";
	}
	if (loading || nodeReachable === null) {
		return "checking";
	}
	return nodeReachable ? "online" : "node-unreachable";
}

/** Whether a phase represents a connection that is not ready for live work. */
export function isConnectionUnavailable(phase: ConnectionPhase): boolean {
	return phase !== "online";
}
