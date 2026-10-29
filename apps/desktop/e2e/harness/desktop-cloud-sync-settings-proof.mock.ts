import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { Node } from "../../src/store/useNodeStore.ts";
import { type ProofJsonRecord, parseProofJsonRecord } from "../fixture-json.ts";

interface ApiCall {
	authorization: string | null;
	body: ProofJsonRecord | null;
	method: string;
	path: string;
}

export interface CloudSyncProofState {
	authenticated: boolean;
	authReadFailureRemaining: number;
	calls: ApiCall[];
	preference: string;
	preferenceReadFailureRemaining: number;
	writeFailureRemaining: number;
}

declare global {
	interface Window {
		__CLOUD_SYNC_PROOF__?: CloudSyncProofState;
	}
}

function createState(): CloudSyncProofState {
	const search = new URLSearchParams(window.location.search);
	return {
		authenticated: !search.has("signedOut"),
		authReadFailureRemaining: search.has("failAuthRead") ? 1 : 0,
		calls: [],
		preference: search.has("syncOn") ? "true" : "false",
		preferenceReadFailureRemaining: search.has("failPreferenceRead") ? 1 : 0,
		writeFailureRemaining: 0,
	};
}

const state = window.__CLOUD_SYNC_PROOF__ ?? createState();
window.__CLOUD_SYNC_PROOF__ = state;

const proofNode: Node = {
	name: "Cloud sync proof node",
	token: "cloud-sync-proof-token",
	url: "http://cloud-sync.test:7980",
};

export function useActiveNode(): Node {
	return proofNode;
}

export function installCloudSyncProofFetch(): () => void {
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = isNativeText(input)
			? new URL(input, window.location.href)
			: input instanceof URL
				? input
				: new URL(input.url);
		if (!url.pathname.startsWith("/api/")) {
			return originalFetch(input, init);
		}
		const method = (init?.method ?? "GET").toUpperCase();
		let body: ProofJsonRecord | null = null;
		if (isNativeText(init?.body)) {
			body = parseProofJsonRecord(init.body);
		}
		const headers = new Headers(init?.headers);
		const path = url.pathname;
		state.calls.push({
			authorization: headers.get("Authorization"),
			body,
			method,
			path,
		});

		if (method === "GET" && path === "/api/auth/status") {
			if (state.authReadFailureRemaining > 0) {
				state.authReadFailureRemaining -= 1;
				return Response.json(
					{ error: "Node auth status unavailable" },
					{ status: 503 }
				);
			}
			return Response.json({ authenticated: state.authenticated });
		}
		if (path === "/api/preferences/cloud-sync-enabled" && method === "GET") {
			if (state.preferenceReadFailureRemaining > 0) {
				state.preferenceReadFailureRemaining -= 1;
				return Response.json(
					{ error: "Node preference unavailable" },
					{ status: 503 }
				);
			}
			return Response.json({ value: state.preference });
		}
		if (path === "/api/preferences/cloud-sync-enabled" && method === "PUT") {
			if (state.writeFailureRemaining > 0) {
				state.writeFailureRemaining -= 1;
				return Response.json(
					{ error: "Node preference write failed" },
					{ status: 500 }
				);
			}
			state.preference = isNativeText(body?.value) ? body.value : "";
			return Response.json({ ok: true });
		}
		return Response.json(
			{ error: `Unexpected proof request: ${method} ${path}` },
			{ status: 404 }
		);
	};
	return () => {
		window.fetch = originalFetch;
	};
}
