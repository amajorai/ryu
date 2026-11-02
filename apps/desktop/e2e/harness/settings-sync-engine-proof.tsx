// First: the sealed vault slots must exist before the auth client hydrates.
import "./settings-sync-native-secrets.ts";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	getActiveToken,
	switchAccount,
	vaultHydrated,
} from "@/lib/auth-client.ts";
import { SettingsSyncTab } from "@/src/components/settings/SettingsSyncTab.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import { getKeybindings } from "@/src/lib/api/preferences.ts";
import { pullSettings } from "@/src/lib/settings-sync/api.ts";
import {
	getSyncStatus,
	startSettingsSync,
} from "@/src/lib/settings-sync/engine.ts";
import {
	currentPlatform,
	keybindingsKey,
} from "@/src/lib/settings-sync/keys.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import "../../src/index.css";
import { otherProofNode, proofNode } from "./settings-sync-proof-nodes.ts";

// Passive exact native body consumption, used as a settlement barrier rather
// than an oracle for successful persistence. The original Response is returned.
const nativeFetch = window.fetch.bind(window);
const issued: { method: string; url: string; keepalive: boolean }[] = [];
const consumed: { method: string; url: string; keepalive: boolean }[] = [];
window.fetch = async (...args: Parameters<typeof fetch>) => {
	const raw = args[0];
	const url =
		typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
	if (new URL(url, location.href).origin !== "http://127.0.0.1:5607") {
		throw new Error(`Unowned shipping egress: ${url}`);
	}
	const method =
		args[1]?.method ??
		(typeof raw === "object" && "method" in raw ? raw.method : "GET");
	const keepalive = args[1]?.keepalive ?? false;
	issued.push({ method, url, keepalive });
	const response = await nativeFetch(...args);
	const json = response.json.bind(response);
	response.json = async () => {
		const result = await json();
		consumed.push({ method, url, keepalive });
		return result;
	};
	const text = response.text.bind(response);
	response.text = async () => {
		const result = await text();
		consumed.push({ method, url, keepalive });
		return result;
	};
	return response;
};
const node = proofNode;
const otherNode = otherProofNode;
useNodeStore.setState({
	nodes: [node, otherNode],
	localNodes: [node, otherNode],
	cloudNodes: [],
	defaultNode: node.name,
	tabOverrides: {},
	autoSelect: false,
	autoSelectedNode: null,
});
Object.assign(window, {
	__syncProof: {
		shortcutKey: () => keybindingsKey(currentPlatform()),
		consumed,
		issued,
		readCloud: () => pullSettings(0),
		status: () => getSyncStatus(),
		// The account switch lives in the auth client's in-memory vault and the
		// sealed `auth-vault` slot, not in localStorage.
		activeToken: () => getActiveToken(),
		readShortcuts: () =>
			getKeybindings(toTarget(useNodeStore.getState().getActiveNode())),
	},
});
function MountedEngine() {
	useEffect(() => startSettingsSync(), []);
	return <SettingsSyncTab />;
}
function Proof() {
	const [mounted, setMounted] = useState(true);
	return (
		<main>
			<button onClick={() => setMounted((v) => !v)}>
				{mounted ? "Stop settings engine" : "Start settings engine"}
			</button>
			<button
				onClick={() => useNodeStore.setState({ defaultNode: otherNode.name })}
			>
				Select Core B
			</button>
			<button onClick={() => useNodeStore.setState({ defaultNode: node.name })}>
				Select Core A
			</button>
			<button
				onClick={() => {
					switchAccount("owned-account-B");
				}}
			>
				Switch to saved account B
			</button>
			<button
				onClick={() => {
					switchAccount("owned-account-A");
				}}
			>
				Switch to saved account A
			</button>
			{mounted ? <MountedEngine /> : null}
			<Toaster />
		</main>
	);
}
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing owned root");
}
// As src/main.tsx: the first render waits for the sealed vault, so the engine
// never starts under a signed-out session.
vaultHydrated.then(() => createRoot(root).render(<Proof />));
