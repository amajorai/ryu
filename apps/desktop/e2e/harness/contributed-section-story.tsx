// Standalone browser story for the REAL `DynamicSidebarSection` — the generic
// renderer behind every app-contributed `sidebar_sections` entry. Mounts it with
// the Agent Status app's actual "Working" spec and a stubbed `fetch` standing in
// for Core's `/api/runs`, so the whole declarative path runs for real: source
// fetch → `sourceItemsFromResponse` (filter + limit + `basename` transform) → the
// two-line row.
//
// Why a browser story rather than a unit test: the deliverable is a row that is
// TALLER and carries its project underneath, and that is a rendered-height fact.
// A type-check cannot see it, and the mapping helpers are already unit-tested in
// `packages/app-host/src/views.test.ts`.
//
// The only stubs are the two seams a section cannot supply itself — `fetch` (no
// Core here) and the tabs context (its provider needs the app's whole provider
// tree). Everything between them is the shipping component.

import type { SidebarSectionSpec } from "@ryu/app-host/views";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DynamicSidebarSection } from "../../src/components/layout/AppSidebar.tsx";
import {
	TabsContext,
	type TabsContextValue,
} from "../../src/contexts/TabsContext.tsx";
import "../../src/index.css";

/** Canned `/api/runs` payload: two running rows (one without a folder, which must
 *  stay single-line), plus rows the section's filter has to drop. */
const RUNS = {
	runs: [
		{
			id: "run-alpha",
			title: "Fix the flaky auth test",
			run_status: "running",
			folder_path: "/Users/dev/code/ryu-closed",
			branch: "fix/auth-flake",
		},
		{
			id: "run-beta",
			title: "Draft the release notes",
			run_status: "running",
			folder_path: null,
			branch: null,
		},
		{
			id: "run-gamma",
			title: "Ship the sidebar",
			run_status: "completed",
			folder_path: "/Users/dev/code/ryu-closed",
		},
	],
};

const WORKING_SPEC: SidebarSectionSpec = {
	source: {
		http: { method: "GET", path: "/api/runs" },
		items: "runs",
		filter: [{ key: "run_status", equals: "running" }],
		map: {
			id: "id",
			title: "title",
			titleFallback: "Untitled run",
			subtitle: "folder_path",
			subtitleTransform: "basename",
		},
		limit: 25,
	},
	itemTarget: "/chat?conversationId={{item.id}}",
	emptyState: { title: "Nothing running" },
};

/** Records what the section asked `openTab` for, so the spec can assert a row
 *  opens a CONVERSATION (path + option) rather than a bare `/chat`. */
function recordOpenTab(path: string, opts?: { conversationId?: string }) {
	const out = document.getElementById("opened");
	if (out) {
		out.textContent = `${path} :: ${opts?.conversationId ?? ""}`;
	}
	return "tab-1";
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

// Stand in for Core: answer the section's `/api/runs` read, 404 anything else.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	if (url.includes("/api/runs")) {
		return Promise.resolve(
			new Response(JSON.stringify(RUNS), {
				status: 200,
				headers: { "content-type": "application/json" },
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
				<div style={{ padding: 40 }}>
					<div style={{ width: 240 }}>
						<DynamicSidebarSection
							collapsed={false}
							contribution={{
								approved_grants: ["ui:declarative-http"],
								id: "working",
								http_policy: "core",
								plugin: "@ryu/agent-status",
								title: "Working",
								icon: "lucide:loader-circle",
								spec: WORKING_SPEC,
							}}
							dnd={noopDnd}
							menu={noopMenu}
							onToggleCollapsed={() => undefined}
							pageSize={0}
							sort="default"
						/>
					</div>
					<pre data-testid="opened" id="opened" />
				</div>
			</TabsContext.Provider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
