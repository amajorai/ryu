import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentProps, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	DrawesomeSketchDialog,
	type DrawesomeSketchAttachment,
} from "../../src/components/chat/DrawesomeSketchDialog.tsx";
import { SkillDistributionProvider } from "../../src/components/skills/SkillDistributionProvider.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import type { PluginCompanion } from "../../src/lib/api/plugins.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";
const requests: Array<{ body: string | null; method: string; path: string }> =
	[];
const attachments: DrawesomeSketchAttachment[] = [];
const unknownRequests: string[] = [];
// Seed the main app's durable sketch independently of this transient dialog.
const storedSketch = JSON.stringify({
	version: 1,
	title: "Previously saved private sketch",
	strokes: [
		{
			id: 42,
			pen: "pen",
			color: "#000000",
			size: 6,
			opacity: 1,
			points: [
				[30, 30, 0.5],
				[180, 90, 0.5],
			],
			erase: false,
		},
	],
});
let appHtml = "";
let sourceImage: { filename: string; url: string } | undefined;
const originalFetch = window.fetch.bind(window);
Reflect.set(
	window,
	"fetch",
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (!url.pathname.includes("/api/")) {
			return await originalFetch(input, init);
		}
		requests.push({
			body: request.body === null ? null : await request.clone().text(),
			method: request.method,
			path: url.pathname,
		});
		if (
			request.method === "GET" &&
			decodeURIComponent(url.pathname) ===
				"/api/plugins/@ryu/drawesome/ui-bundle"
		) {
			if (
				url.origin !== window.location.origin ||
				request.headers.get("authorization") !==
					"Bearer dialog-fixture-node-token"
			) {
				throw new Error(
					"Actual plugin host must use the selected node and its exact bearer."
				);
			}
			if (!appHtml) {
				throw new Error("Missing actual built Drawesome bundle.");
			}
			return Response.json({ code: appHtml });
		}
		if (
			request.method === "POST" &&
			decodeURIComponent(url.pathname) === "/api/plugins/@ryu/drawesome/host" &&
			url.origin === window.location.origin &&
			request.headers.get("authorization") ===
				"Bearer dialog-fixture-node-token" &&
			(await request.clone().text()) ===
				JSON.stringify({
					method: "storage.get",
					args: { key: "sketch.v1", namespace: "drawesome" },
				})
		) {
			// Return genuine seeded durable data, but keep this read a contract
			// failure: transient dialog startup must never consult the main sketch.
			unknownRequests.push(
				`Forbidden persistent sketch read: ${request.method} ${url.pathname}`
			);
			return Response.json({ result: storedSketch });
		}
		if (request.method === "GET" && url.pathname.endsWith("/get-session")) {
			return Response.json(null);
		}
		unknownRequests.push(`${request.method} ${url.pathname}`);
		throw new Error(
			`Unexpected Desktop dialog fixture authority: ${request.method} ${url.pathname}`
		);
	}
);
const node = {
	name: "Dialog regression node",
	url: window.location.origin,
	token: "dialog-fixture-node-token",
};
useNodeStore.setState({ nodes: [node], defaultNode: node.name });
const tabs = {
	openTab: () => {
		throw new Error("Dialog must not open a tab.");
	},
	updateTabTitle: () => {},
	updateTabsIconWhere: () => {},
} as unknown as ComponentProps<typeof TabsContext.Provider>["value"];
const companion: PluginCompanion = {
	approvedGrants: ["storage:kv", "ui:toast"],
	defaultCspEnforced: true,
	firstParty: true,
	hasUi: true,
	id: "drawesome",
	label: "Drawesome",
	name: "Drawesome",
	pluginId: "@ryu/drawesome",
};
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
function DialogHarness() {
	const [open, setOpen] = useState(false);
	return (
		<main>
			<button type="button" onClick={() => setOpen(true)}>
				Open actual sketch dialog
			</button>
			<output data-testid="attachment-count">{attachments.length}</output>
			<DrawesomeSketchDialog
				companion={companion}
				sourceImage={sourceImage}
				open={open}
				onOpenChange={setOpen}
				onAttach={(attachment) => {
					attachments.push(structuredClone(attachment));
				}}
			/>
		</main>
	);
}
Reflect.set(window, "__drawesomeDialog", {
	mount(input: {
		appHtml: string;
		sourceImage?: { filename: string; url: string };
	}) {
		appHtml = input.appHtml;
		sourceImage = input.sourceImage;
	},
	requests: () => structuredClone(requests),
	attachments: () => structuredClone(attachments),
	unknownRequests: () => [...unknownRequests],
});
const root = document.getElementById("host-root");
if (!root) {
	throw new Error("Missing actual dialog root.");
}
createRoot(root).render(
	<I18nProvider>
		<QueryClientProvider client={queryClient}>
			<TabsContext.Provider value={tabs}>
				<SkillDistributionProvider>
					<DialogHarness />
				</SkillDistributionProvider>
			</TabsContext.Provider>
		</QueryClientProvider>
	</I18nProvider>
);
document.body.dataset.harnessReady = "1";
