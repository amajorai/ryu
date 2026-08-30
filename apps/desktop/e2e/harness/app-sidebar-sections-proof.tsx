// Browser proof for the six app-owned record pickers migrated onto the desktop
// sidebar's generic `sidebar_sections` renderer. Each section below uses the
// same production `DynamicSidebarSection` that AppSidebar mounts from live app
// contributions; only the Core reads are stubbed so this page stays hermetic.

import type { SidebarSectionSpec } from "@ryu/app-host/views";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DynamicSidebarSection } from "../../src/components/layout/AppSidebar.tsx";
import {
	TabsContext,
	type TabsContextValue,
} from "../../src/contexts/TabsContext.tsx";
import "../../src/index.css";

const APP_SECTIONS: Array<{
	id: string;
	icon: string;
	plugin: string;
	spec: SidebarSectionSpec;
	title: string;
}> = [
	{
		id: "plans",
		icon: "structure-check",
		plugin: "com.ryu.blueprint",
		title: "Plans",
		spec: {
			source: {
				http: { method: "GET", path: "/api/blueprint/plans" },
				items: "plans",
				map: {
					accessory: "status",
					id: "id",
					subtitle: "subtitle",
					title: "title",
				},
			},
			itemTarget: "/blueprint/{{item.id}}",
		},
	},
	{
		id: "monitors",
		icon: "radar-01",
		plugin: "com.ryu.monitors",
		title: "Monitors",
		spec: {
			source: {
				http: { method: "GET", path: "/api/monitors" },
				items: "monitors",
				map: {
					accessory: "last_status",
					id: "id",
					subtitle: "url",
					title: "name",
				},
			},
			itemTarget: "/monitors/{{item.id}}",
		},
	},
	{
		id: "policies",
		icon: "checkmark-badge-03",
		plugin: "com.ryu.reasoning",
		title: "Policies",
		spec: {
			source: {
				http: { method: "GET", path: "/api/reasoning/policies" },
				items: "policies",
				map: {
					id: "id",
					subtitle: "description",
					title: "name",
				},
			},
			itemTarget: "/reasoning/{{item.id}}",
		},
	},
	{
		id: "contexts",
		icon: "lucide:list-tree",
		plugin: "com.ryu.rlm",
		title: "Contexts",
		spec: {
			source: {
				http: { method: "GET", path: "/api/rlm/contexts" },
				items: "contexts",
				map: {
					accessory: "chunks",
					id: "id",
					subtitle: "total_chars",
					title: "name",
				},
			},
			itemTarget: "/rlm/{{item.id}}",
		},
	},
	{
		id: "campaigns",
		icon: "microscope",
		plugin: "com.ryu.research",
		title: "Campaigns",
		spec: {
			source: {
				http: { method: "GET", path: "/api/research/campaigns" },
				items: "campaigns",
				map: {
					accessory: "attemptCount",
					id: "id",
					subtitle: "status",
					title: "name",
				},
			},
			itemTarget: "/plugin/app__research-companion",
			context: { campaignId: "id" },
		},
	},
	{
		id: "inboxes",
		icon: "mail-01",
		plugin: "com.ryu.mail",
		title: "Inboxes",
		spec: {
			source: {
				http: { method: "GET", path: "/api/mail/inboxes" },
				items: "inboxes",
				map: {
					id: "id",
					subtitle: "address",
					title: "name",
				},
			},
			itemTarget: "/mail/{{item.id}}",
		},
	},
	{
		id: "workflows",
		icon: "workflow-circle-06",
		plugin: "com.ryu.workflows",
		title: "Workflows",
		spec: {
			source: {
				http: { method: "GET", path: "/workflows" },
				items: "workflows",
				map: {
					id: "id",
					subtitle: "description",
					title: "name",
				},
			},
			itemTarget: "/workflows/{{item.id}}",
		},
	},
];

const PAYLOADS: Record<string, unknown> = {
	"/api/blueprint/plans": {
		plans: [
			{
				id: "plan-1",
				status: "Draft",
				subtitle: "Release train",
				title: "Launch plan",
			},
		],
	},
	"/api/mail/inboxes": {
		inboxes: [{ address: "support@ryu.test", id: "inbox-1", name: "Support" }],
	},
	"/api/monitors": {
		monitors: [
			{
				id: "monitor-1",
				last_status: "Healthy",
				name: "Production API",
				url: "api.ryu.test",
			},
		],
	},
	"/api/reasoning/policies": {
		policies: [
			{ description: "Release checks", id: "policy-1", name: "Release policy" },
		],
	},
	"/api/rlm/contexts": {
		contexts: [
			{ chunks: 4, id: "context-1", name: "Q3 contracts", total_chars: 12_000 },
		],
	},
	"/api/research/campaigns": {
		campaigns: [
			{
				attemptCount: 3,
				id: "campaign-1",
				name: "Search campaign",
				status: "active",
			},
		],
	},
	"/workflows": {
		workflows: [
			{
				description: "Release checklist",
				id: "workflow-1",
				name: "Release workflow",
			},
		],
	},
};

function recordOpenTab(
	path: string,
	options?: { mountContext?: Record<string, unknown> }
): string {
	const opened = document.getElementById("opened");
	if (opened) {
		opened.textContent = path;
	}
	const context = document.getElementById("opened-context");
	if (context) {
		context.textContent = JSON.stringify(options?.mountContext ?? null);
	}
	return "proof-tab";
}

const tabs = {
	openTab: recordOpenTab,
} as unknown as TabsContextValue;

const noopDnd = {
	draggingKey: null,
	dragOverKey: null,
	onDragEnd: () => undefined,
	onDragOver: () => undefined,
	onDragStart: () => undefined,
	onDrop: () => undefined,
	order: [],
};

const noopMenu = {
	canMove: () => false,
	onHide: () => undefined,
	onMove: () => undefined,
	onOpenCustomize: () => undefined,
	onSetPageSize: () => undefined,
	onSetSort: () => undefined,
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	const path = new URL(url, location.href).pathname;
	const payload = PAYLOADS[path];
	if (payload) {
		return Promise.resolve(
			new Response(JSON.stringify(payload), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}
	return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Story() {
	return (
		<QueryClientProvider client={queryClient}>
			<TabsContext.Provider value={tabs}>
				<main
					style={{
						background: "#0b0d12",
						color: "#e6e9f0",
						fontFamily: "var(--font-sans)",
						minHeight: "100vh",
						padding: "24px 32px",
					}}
				>
					<h1 style={{ fontSize: 18, margin: "0 0 6px" }}>
						App-contributed sidebar sections
					</h1>
					<p style={{ color: "#8a91a3", fontSize: 13, margin: "0 0 18px" }}>
						Seven app-owned record pickers rendered by one desktop primitive.
					</p>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 8,
							width: 300,
						}}
					>
						{APP_SECTIONS.map((section) => (
							<DynamicSidebarSection
								collapsed={false}
								contribution={{
									...section,
									approved_grants: ["ui:declarative-http"],
									http_policy: "core",
								}}
								dnd={noopDnd}
								key={`${section.plugin}:${section.id}`}
								menu={noopMenu}
								onToggleCollapsed={() => undefined}
								pageSize={6}
								sort="default"
							/>
						))}
					</div>
					<pre id="opened" style={{ color: "#8a91a3", fontSize: 12 }} />
					<pre id="opened-context" style={{ color: "#8a91a3", fontSize: 12 }} />
				</main>
			</TabsContext.Provider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
