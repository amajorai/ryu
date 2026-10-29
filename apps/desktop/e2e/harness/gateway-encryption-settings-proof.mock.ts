import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { EncryptionStatus } from "../../src/lib/api/encryption.ts";
import type { Node } from "../../src/store/useNodeStore.ts";

export interface EncryptionProofState {
	failureRemaining: number;
	nextStatus: EncryptionStatus | null;
	requests: Array<{
		authorization: string | null;
		method: string;
		url: string;
	}>;
	status: EncryptionStatus;
}

declare global {
	interface Window {
		__ENCRYPTION_PROOF__?: EncryptionProofState;
	}
}

const stores = [
	{
		detail: "Chat messages and attachments are sealed before they reach disk.",
		id: "conversations",
		label: "Chats",
		sealed: 12,
		status: "sealed",
		total: 12,
	},
	{
		detail: "Older records are being migrated when next written.",
		id: "memory",
		label: "Memory",
		sealed: 3,
		status: "partial",
		total: 4,
	},
	{
		detail: "Documents are not yet sealed at rest.",
		id: "spaces",
		label: "Spaces documents",
		sealed: null,
		status: "plaintext",
		total: null,
	},
] satisfies EncryptionStatus["stores"];

function statusFor(
	source: "env" | "file" | "keychain" | "unavailable"
): EncryptionStatus {
	const unavailable = source === "unavailable";
	return {
		dataDir: "/Users/proof/.ryu-dev",
		key: {
			available: !unavailable,
			envVar: "RYU_MASTER_KEY",
			error: unavailable ? "The master key could not be resolved." : null,
			keychainAccount: source === "keychain" ? "master-key-dev" : null,
			keychainService: source === "keychain" ? "com.ryu.dev" : null,
			keyFile: source === "file" ? "/Users/proof/.ryu-dev/master.key" : null,
			legacyMemoryKeyPresent: source === "file",
			source: unavailable ? null : source,
		},
		stores: unavailable ? [] : stores,
	};
}

function createState(): EncryptionProofState {
	const search = new URLSearchParams(window.location.search);
	const rawSource = search.get("source");
	const source =
		rawSource === "env" || rawSource === "file" || rawSource === "unavailable"
			? rawSource
			: "keychain";
	return {
		failureRemaining: search.has("failOnce") ? 1 : 0,
		requests: [],
		status: statusFor(source),
		nextStatus: null,
	};
}

const state = createState();
window.__ENCRYPTION_PROOF__ = state;

// One stable node object, as the shipping hook returns from the node store, so
// the component's authority scope does not change on every render.
const proofNode: Node = {
	name: "Encryption proof node",
	token: "encryption-proof-token",
	url: "http://encryption.test:7980",
};

function getProofNode(): Node {
	return proofNode;
}

// Both exports of the aliased `@/src/hooks/useActiveNode.ts`: the component
// reads the hook form, other settings modules the getter form.
export function useActiveNode(): Node {
	return proofNode;
}

export function useActiveNodeGetter(): () => Node {
	return getProofNode;
}

export function installEncryptionProofFetch(): () => void {
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = isNativeText(input)
			? new URL(input, window.location.href)
			: input instanceof URL
				? input
				: new URL(input.url);
		if (url.pathname !== "/api/encryption/status") {
			return originalFetch(input, init);
		}
		const headers = new Headers(init?.headers);
		state.requests.push({
			authorization: headers.get("Authorization"),
			method: init?.method ?? "GET",
			url: url.toString(),
		});
		if (state.failureRemaining > 0) {
			state.failureRemaining -= 1;
			return Response.json(
				{ error: "Core is not responding" },
				{ status: 502 }
			);
		}
		if (state.nextStatus) {
			state.status = state.nextStatus;
			state.nextStatus = null;
		}
		return Response.json(structuredClone(state.status));
	};
	return () => {
		window.fetch = originalFetch;
	};
}
