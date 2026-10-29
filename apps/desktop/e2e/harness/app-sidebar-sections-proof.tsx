import proofStyles from "./app-sidebar-sections-proof.module.css";
// Browser proof for the six app-owned record pickers migrated onto the desktop
// sidebar's generic `sidebar_sections` renderer. Each section below uses the
// same production `DynamicSidebarSection` that AppSidebar mounts from live app
// contributions; only the Core reads are stubbed so this page stays hermetic.

import type { SidebarSectionSpec } from "@ryu/app-host/views";
import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DynamicSidebarSection } from "../../src/components/layout/AppSidebar.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";

type TabsContextValue = NonNullable<
	ComponentProps<typeof TabsContext.Provider>["value"]
>;

import { useSidebarSectionSources } from "../../src/hooks/useSidebarSectionSource.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import "../../src/index.css";
import { IDLE_REORDER_SHIFT } from "@ryu/ui/hooks/use-reorder-shift.tsx";

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

const PAYLOADS = {
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
	options?: Parameters<TabsContextValue["openTab"]>[1]
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

const tabsFixture = { openTab: recordOpenTab } satisfies Pick<
	TabsContextValue,
	"openTab"
>;
// SAFETY: this fixture mounts DynamicSidebarSection, whose only tabs selector
// reads openTab; recordOpenTab implements that actual owner contract.
const tabs = tabsFixture as TabsContextValue;

const noopDnd = {
	draggingKey: null,
	dragOverKey: null,
	onDragEnd: () => undefined,
	onDragOver: () => undefined,
	onDragStart: () => undefined,
	onDrop: () => undefined,
	shift: IDLE_REORDER_SHIFT,
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

const measurePolling = new URLSearchParams(location.search).has("polling");
if (measurePolling && APP_SECTIONS[0].spec.source) {
	APP_SECTIONS[0].spec.source.refreshMs = 1000;
}
const sourceReadTimes: number[] = [];
const payloadsByPath = new Map(Object.entries(PAYLOADS));
const realFetch = Object.assign(
	globalThis.fetch.bind(globalThis),
	globalThis.fetch
);
globalThis.fetch = Object.assign(
	(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = input instanceof Request ? input.url : String(input);
		const path = new URL(url, location.href).pathname;
		const payload = payloadsByPath.get(path);
		if (payload) {
			if (path === "/api/blueprint/plans") {
				sourceReadTimes.push(performance.now());
				document.documentElement.dataset.sourceReadTimes =
					JSON.stringify(sourceReadTimes);
			}
			document.documentElement.dataset.sectionReads = String(
				Number(document.documentElement.dataset.sectionReads ?? 0) + 1
			);
			return Promise.resolve(
				new Response(JSON.stringify(payload), {
					headers: { "content-type": "application/json" },
					status: 200,
				})
			);
		}
		return realFetch(input, init);
	},
	globalThis.fetch
);

function SharedReader() {
	useSidebarSectionSources(
		APP_SECTIONS.map((section) => ({
			...section,
			approved_grants: ["ui:declarative-http"],
			http_policy: "core",
		}))
	);
	return null;
}

function Story() {
	const [shared, setShared] = useState(!measurePolling);
	return (
		<QueryClientProvider client={queryClient}>
			<TabsContext.Provider value={tabs}>
				{shared && <SharedReader />}
				<main className={proofStyles.fixture1}>
					{measurePolling && (
						<Button onClick={() => setShared(true)}>Mount shared reader</Button>
					)}
					<h1 className={proofStyles.fixture2}>
						App-contributed sidebar sections
					</h1>
					<p className={proofStyles.fixture3}>
						Seven app-owned record pickers rendered by one desktop primitive.
					</p>
					<div className={proofStyles.fixture4}>
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
					<pre className={proofStyles.fixture5} id="opened" />
					<pre className={proofStyles.fixture6} id="opened-context" />
				</main>
			</TabsContext.Provider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
