/** The connection phases the desktop shell can explain to a user. */

import type { ConnectionPhase } from "@ryuhq/protocol/connection-status";
import {
	isConnectionUnavailable,
	resolveConnectionPhase as resolveNetworkConnectionPhase,
} from "@ryuhq/protocol/connection-status";

export type { ConnectionPhase };

export interface ConnectionPhaseInput {
	browserOnline: boolean;
	loading: boolean;
	nodeReachable: boolean | null;
}

/** Desktop compatibility adapter; the canonical contract is host-neutral. */
export function resolveConnectionPhase({
	browserOnline,
	loading,
	nodeReachable,
}: ConnectionPhaseInput): ConnectionPhase {
	return resolveNetworkConnectionPhase({
		loading,
		networkOnline: browserOnline,
		nodeReachable,
	});
}

export { isConnectionUnavailable };
