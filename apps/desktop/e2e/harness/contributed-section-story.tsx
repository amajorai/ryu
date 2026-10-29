import { runSummarySchema } from "../../src/lib/api/run-wire-contracts.ts";
import proofStyles from "./contributed-section-story.module.css";
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
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { DynamicSidebarSection } from "../../src/components/layout/AppSidebar.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";

type TabsContextValue = NonNullable<
	ComponentProps<typeof TabsContext.Provider>["value"]
>;
import "../../src/index.css";
import { IDLE_REORDER_SHIFT } from "@ryu/ui/hooks/use-reorder-shift.tsx";

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
	].map((run) =>
		runSummarySchema.parse({
			...run,
			agent_id: null,
			branch: run.branch ?? null,
			created_at: 0,
			message_count: 0,
			updated_at: 0,
			worktree_path: null,
		})
	),
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

const tabsFixture = { openTab: recordOpenTab } satisfies Pick<
	TabsContextValue,
	"openTab"
>;
// SAFETY: this isolated story mounts only DynamicSidebarSection, whose sole tabs
// selector reads openTab; the fixture supplies that actual owner signature.
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

// Stand in for Core: answer the section's `/api/runs` read, 404 anything else.
const realFetch = Object.assign(
	globalThis.fetch.bind(globalThis),
	globalThis.fetch
);
globalThis.fetch = Object.assign(
	(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes("/api/runs")) {
			return Promise.resolve(
				new Response(JSON.stringify(RUNS), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			);
		}
		return realFetch(input, init);
	},
	globalThis.fetch
);

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Story() {
	return (
		<QueryClientProvider client={queryClient}>
			<TabsContext.Provider value={tabs}>
				<div className={proofStyles.stage}>
					<div className={proofStyles.sidebar}>
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
