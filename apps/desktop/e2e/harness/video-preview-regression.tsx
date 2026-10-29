import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import { capabilitiesFromGrants, type HostServices } from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	assetSchema,
	sceneSchema,
} from "../../../../apps-store/video-studio/shared/project.ts";
import type {
	PreviewCall,
	VideoPreviewApi,
} from "./video-preview-regression.types.ts";
const assets = {
	A: assetSchema.parse({
		id: crypto.randomUUID(),
		name: "Old selected take",
		kind: "image",
		width: 8,
		height: 8,
		duration: 5,
		hasAudio: false,
		createdAt: "2026-10-08T00:00:00.000Z",
	}),
	B: assetSchema.parse({
		id: crypto.randomUUID(),
		name: "Current selected take",
		kind: "image",
		width: 16,
		height: 8,
		duration: 5,
		hasAudio: false,
		createdAt: "2026-10-08T00:00:00.000Z",
	}),
};
const sceneId = crypto.randomUUID();
const calls: PreviewCall[] = [];
const held = new Set<"A" | "B">();
const pending = new Map<"A" | "B", (accept: boolean) => void>();
let root: Root | null = null;
let connected = false;
let selection: "A" | "B" = "A";
let nonce = "";
function props(asset: "A" | "B") {
	return {
		assets: [assets[asset]],
		scenes: [
			sceneSchema.parse({
				id: sceneId,
				title: `${asset} selected scene`,
				script: "",
				prompt: "",
				assetIds: [assets[asset].id],
				duration: 5,
				sourceIn: 0,
				approved: false,
			}),
		],
		project: { width: 1280, height: 720 },
	};
}
function sendSelection() {
	const frame = document.querySelector<HTMLIFrameElement>(
		'iframe[title="Video preview regression"]'
	);
	if (!frame?.contentWindow) {
		throw new Error("Missing actual preview frame.");
	}
	frame.contentWindow.postMessage(
		{ kind: "video-preview-fixture-select", nonce, props: props(selection) },
		"*"
	);
}
const api: VideoPreviewApi = {
	mount(input) {
		if (pending.size) {
			throw new Error(
				"Release pending thumbnail reads before replacing the fixture."
			);
		}
		root?.unmount();
		calls.length = 0;
		held.clear();
		connected = false;
		selection = "A";
		nonce = crypto.randomUUID();
		let refuseFirstA = true;
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async () => {
				throw new Error("Preview widget cannot register routes.");
			},
			appRequest: async (inputCall) => {
				const method = inputCall.method ?? "GET";
				const call: PreviewCall = {
					path: inputCall.path,
					method,
					...(inputCall.body === undefined
						? {}
						: { body: structuredClone(inputCall.body) }),
					status: "pending",
				};
				calls.push(call);
				const key = (["A", "B"] as const).find(
					(asset) => inputCall.path === `/assets/${assets[asset].id}/thumbnail`
				);
				if (!key || method !== "GET" || inputCall.body !== undefined) {
					call.status = "refused";
					throw new Error("Unexpected preview asset authority or mutation.");
				}
				if (key === "A" && refuseFirstA) {
					refuseFirstA = false;
					call.status = "refused";
					throw new Error("Selected A preview was refused.");
				}
				if (held.delete(key)) {
					const accepted = await new Promise<boolean>((resolve) => {
						pending.set(key, resolve);
					});
					pending.delete(key);
					if (!accepted) {
						call.status = "refused";
						throw new Error(`Old ${key} preview completion was refused.`);
					}
				}
				call.status = "accepted";
				return { data: key === "A" ? input.imageA : input.imageB };
			},
		};
		const container = document.getElementById("host-root");
		if (!container) {
			throw new Error("Missing preview regression host.");
		}
		root = createRoot(container);
		root.render(
			createElement(ExtensionHost, {
				granted: capabilitiesFromGrants(["app:http"]),
				nonce,
				onConnected: () => {
					connected = true;
				},
				services,
				srcdoc: htmlCompanionSrcdoc(nonce, input.appHtml, "@ryu/video-studio", {
					fixtureNonce: nonce,
					fixtureProps: props("A"),
				}),
				title: "Video preview regression",
			})
		);
	},
	connected: () => connected,
	calls: () => structuredClone(calls),
	select: (asset, hold = false) => {
		selection = asset;
		if (hold) {
			held.add(asset);
		}
		sendSelection();
	},
	renderEquivalentSelection: () => sendSelection(),
	holdNext: (asset) => {
		if (held.has(asset) || pending.has(asset)) {
			throw new Error("A thumbnail read is already held.");
		}
		held.add(asset);
	},
	release: (asset, accept) => {
		const resolve = pending.get(asset);
		if (!resolve) {
			throw new Error("No matching pending thumbnail read.");
		}
		resolve(accept);
	},
	ids: () => ({ A: assets.A.id, B: assets.B.id }),
};
Reflect.set(window, "__videoPreview", api);
document.body.dataset.harnessReady = "1";
