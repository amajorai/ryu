import { create } from "zustand";

const managedNodeUrl = "https://managed.example.test";
const isManagedProof =
	new URLSearchParams(window.location.search).get("node") === "managed";
const activeNode = {
	name: isManagedProof ? "Ryu Cloud" : "Local node",
	token: "proof-node-token",
	url: isManagedProof ? managedNodeUrl : "http://127.0.0.1:7980",
};

export const BACKEND_URL = window.location.origin;
export const FRONTEND_URL = "https://ryuhq.com";
export const authClient = { signOut: async () => undefined };
export const clearSessionToken = async () => undefined;
export const getActiveToken = () => "proof-session-token";

export function useSession() {
	return {
		data: { user: { id: "waitlist-proof-user", isAnonymous: false } },
		isPending: false,
	};
}

export function openExternal() {}

export const useNodeStore = create(() => ({
	getActiveNode: () => activeNode,
	nodes: [activeNode],
}));

export default function LoginPage() {
	return <div>Sign in</div>;
}
