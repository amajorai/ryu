import { useSyncExternalStore } from "react";
import type { ApiTarget } from "../../src/lib/api/client.ts";

function proofNode() {
	return {
		id: "account-proof",
		name: "Local test node",
		url: window.location.origin,
		token: null,
		userJwt: null,
		managed: false,
	};
}
// Stable like the real hooks' memoized target and `useCallback` getters: the
// settings sections key their reads on these, so a fresh identity per render
// would refetch in a loop. Narrowed inline exactly as `toTarget` does, with no
// value import: provider-ui-contract-repair aliases this seam into a pinned
// candidate tree, which must not load live-tree source.
const proofTarget: ApiTarget = {
	url: window.location.origin,
	token: null,
	userJwt: null,
};
function getProofTarget(): ApiTarget {
	return proofTarget;
}
export function useActiveNodeGetter() {
	return proofNode;
}
export function useActiveNode() {
	return proofNode();
}
export function useActiveTarget(): ApiTarget {
	return proofTarget;
}
export function useActiveTargetGetter(): () => ApiTarget {
	return getProofTarget;
}
export function useGatewayConfigurable() {
	return true;
}
export function useCanManagePermission() {
	return true;
}
// The real hook polls status every few seconds; a restart after "Apply saved
// connections" can make one poll report the gateway unreachable. Proofs flip
// this from the page (`window.__gatewayDialogAccountsProof.setReachable`) to
// replay that poll without a real gateway.
let reachable = true;
const listeners = new Set<() => void>();
function proofStatus(value: boolean) {
	return {
		reachable: value,
		running: true,
		health: { status: "ok", providers: ["genai-groq"] },
		metrics: null,
	};
}
const reachableStatus = proofStatus(true);
const unreachableStatus = proofStatus(false);
function subscribeReachability(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
function getReachability() {
	return reachable;
}
function setReachable(value: boolean) {
	reachable = value;
	for (const listener of listeners) {
		listener();
	}
}

declare global {
	interface Window {
		__gatewayDialogAccountsProof?: { setReachable: (value: boolean) => void };
	}
}

window.__gatewayDialogAccountsProof = { setReachable };

async function refreshProofStatus() {
	// Status is driven by the page, so there is nothing to refetch.
}

export function useGatewayStatus() {
	const current = useSyncExternalStore(
		subscribeReachability,
		getReachability,
		getReachability
	);
	return {
		status: current ? reachableStatus : unreachableStatus,
		loading: false,
		error: null,
		refresh: refreshProofStatus,
	};
}
