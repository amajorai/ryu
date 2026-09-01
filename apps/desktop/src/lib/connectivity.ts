/** The connection phases the desktop shell can explain to a user. */
export type ConnectionPhase =
	| "checking"
	| "node-unreachable"
	| "offline"
	| "online";

export interface ConnectionPhaseInput {
	browserOnline: boolean;
	loading: boolean;
	nodeReachable: boolean | null;
}

/**
 * Resolve the user-facing connection state from the browser signal and the
 * active node probe. Browser offline wins because it explains why a remote node
 * cannot be reached; an unanswered node is a different, actionable failure.
 */
export function resolveConnectionPhase({
	browserOnline,
	loading,
	nodeReachable,
}: ConnectionPhaseInput): ConnectionPhase {
	if (!browserOnline) {
		return "offline";
	}
	if (loading || nodeReachable === null) {
		return "checking";
	}
	return nodeReachable ? "online" : "node-unreachable";
}

/** Whether a phase represents a connection that is not ready yet. */
export function isConnectionUnavailable(phase: ConnectionPhase): boolean {
	return phase !== "online";
}
