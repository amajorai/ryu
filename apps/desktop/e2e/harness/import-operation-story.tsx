// Browser story for the "Import agent setup" dialog on the operations service.
//
// The story stands in for the node through `window.fetch`, with a scan of twelve
// items, `POST /api/import/run` that answers 202 with an operation, and
// operation reads that advance one item per read. Nothing else is faked: the
// real dialog, the real operations store, the real hook and the real live
// activity adapter run, so the screenshots show what a user sees.
//
// Scenarios, picked with the query parameter `scenario`.
//   plain        the import runs to the end (default)
//   resumed      the node "restarts" after four items and continues, marked
//                as resumed
//   interrupted  the node "restarts" after four items and does not continue;
//                Retry then runs the rest
//   failing      two of the twelve items fail
//   theirs       the node's list holds another user's running import (as an
//                admin of an org-bound node sees a member's). The story's node
//                is the active node and the app-wide operations feed runs, so
//                the dialog could adopt it; it must not, and the Live section
//                shows no card for it.

import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportSetupDialog } from "../../src/components/chat/ImportSetupDialog.tsx";
import { useOperationsStream } from "../../src/hooks/useOperationsStream.ts";
import { useOperationLiveActivities } from "../../src/live/adapters/operations.ts";
import { useLiveActivities } from "../../src/store/useLiveActivityStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useOperationsStore } from "../../src/store/useOperationsStore.ts";
import "../../src/index.css";

const TOTAL = 12;
const HOME = "/home/demo";
const scenario =
	new URLSearchParams(location.search).get("scenario") ?? "plain";

interface StoryOperation {
	cancelRequested: boolean;
	done: number;
	/** The one "restart" of the interrupted scenario already happened. */
	interrupted: boolean;
	resumed: boolean;
	status: string;
	updates: number;
}

declare global {
	interface Window {
		importStory: {
			/** The ids in the client's operations mirror. */
			mirrored: () => string[];
			/** Operation reads answered so far. */
			reads: number;
			/** `POST /api/import/run` bodies, as sent. */
			starts: unknown[];
			/** Requests about the other user's import (read, cancel, retry). */
			theirs: string[];
		};
	}
}
window.importStory = {
	mirrored: () => Object.keys(useOperationsStore.getState().operations),
	reads: 0,
	starts: [],
	theirs: [],
};

/** Another user's import, running on the node, as the node lists it. */
const THEIRS = {
	attempt: 1,
	cancelRequested: false,
	createdAt: "2026-11-18T10:00:30.000Z",
	id: "op_theirs",
	kind: "import.setup",
	ownerUserId: "member-b",
	progress: { done: 3, total: 40 },
	resumable: true,
	resumed: false,
	status: "running",
	title: "member-project",
	updatedAt: "2026-11-18T10:00:30.000Z",
};

const SCAN_ITEMS = Array.from({ length: TOTAL }, (_, index) => ({
	detail: `skills/skill-${index + 1}/SKILL.md`,
	id: `skills/skill-${index + 1}`,
	kind: "skill",
	title: `Skill ${index + 1}`,
}));

let operation: StoryOperation | null = null;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function outcomeOf(index: number) {
	const failed = scenario === "failing" && (index === 2 || index === 7);
	return {
		detail: failed ? "The file is not a readable skill." : undefined,
		id: SCAN_ITEMS[index]?.id ?? `item-${index}`,
		kind: "skill",
		status: failed ? "failed" : "imported",
		title: SCAN_ITEMS[index]?.title ?? `Item ${index}`,
	};
}

/** The record as the node would serve it; `full` adds checkpoint and result. */
function record(current: StoryOperation, full: boolean) {
	const results = Array.from({ length: current.done }, (_, index) =>
		outcomeOf(index)
	);
	// A later change always carries a later time, as on the node.
	const stamp = new Date(
		Date.UTC(2026, 10, 18, 10, 0, 0) + current.updates * 1000
	).toISOString();
	return {
		attempt: current.resumed ? 2 : 1,
		cancelRequested: current.cancelRequested,
		createdAt: "2026-11-18T10:00:00.000Z",
		cursor: full ? { results } : undefined,
		id: "op_story",
		kind: "import.setup",
		progress: { done: current.done, total: TOTAL },
		result:
			full && current.status === "succeeded"
				? { results, root: `${HOME}/.claude` }
				: undefined,
		resumable: true,
		resumed: current.resumed,
		status: current.status,
		title: ".claude",
		updatedAt: stamp,
	};
}

/** One step of the fake node, taken on every read of the operation. */
function advance(current: StoryOperation): void {
	if (current.status !== "running" && current.status !== "queued") {
		return;
	}
	current.updates += 1;
	if (current.cancelRequested) {
		current.status = "cancelled";
		current.cancelRequested = false;
		return;
	}
	if (
		current.done === 4 &&
		scenario === "interrupted" &&
		!current.interrupted
	) {
		current.interrupted = true;
		current.status = "interrupted";
		return;
	}
	if (current.done === 4 && scenario === "resumed" && !current.resumed) {
		current.resumed = true;
		return;
	}
	current.done += 1;
	if (current.done >= TOTAL) {
		current.status = "succeeded";
	}
}

window.fetch = async (input, init) => {
	const path = new URL(
		input instanceof Request ? input.url : String(input),
		window.location.origin
	).pathname;
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();

	if (path === "/api/workspace/list") {
		return json({ entries: [], home: HOME, parent: null, path: HOME });
	}
	if (path === "/api/import/scan") {
		return json({ items: SCAN_ITEMS, root: `${HOME}/.claude`, warnings: [] });
	}
	if (path === "/api/import/run" && method === "POST") {
		window.importStory.starts.push(JSON.parse(String(init?.body ?? "{}")));
		operation = {
			cancelRequested: false,
			done: 0,
			interrupted: false,
			resumed: false,
			status: "running",
			updates: 0,
		};
		return json(
			{ operation: record(operation, false), operationId: "op_story" },
			202
		);
	}
	if (path === "/api/operations") {
		const listed = operation ? [record(operation, false)] : [];
		return json({
			operations: scenario === "theirs" ? [THEIRS, ...listed] : listed,
		});
	}
	if (path.startsWith("/api/operations/op_theirs")) {
		window.importStory.theirs.push(`${method} ${path}`);
		return json(THEIRS);
	}
	if (path === "/api/operations/op_story/cancel" && operation) {
		operation.cancelRequested = true;
		operation.updates += 1;
		return json(record(operation, true));
	}
	if (path === "/api/operations/op_story/retry" && operation) {
		operation.status = "running";
		operation.updates += 1;
		return json(record(operation, true));
	}
	if (path === "/api/operations/op_story" && operation) {
		window.importStory.reads += 1;
		advance(operation);
		return json(record(operation, true));
	}
	return json({}, 404);
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const target = { token: null, url: location.origin };

if (scenario === "theirs") {
	// The story's node is the active node, as for the sidebar's dialog.
	useNodeStore.setState({
		autoSelect: false,
		autoSelectedNode: null,
		defaultNode: "story",
		nodes: [{ name: "story", ...target }],
		tabOverrides: {},
	});
}

/** The app-wide operations feed (one list per node connect), "theirs" only. */
function NodeFeed() {
	useOperationsStream();
	return null;
}

/** What the Live section would list, straight from the live-activity store. */
function LiveCards() {
	useOperationLiveActivities();
	const activities = useLiveActivities();
	return (
		<section
			className="w-80 rounded-xl border border-border/60 bg-sidebar p-4"
			data-testid="live-cards"
		>
			<p className="mb-2 font-medium text-muted-foreground text-xs">Live</p>
			{activities.length === 0 ? (
				<p className="text-muted-foreground text-sm" data-testid="live-empty">
					Nothing running
				</p>
			) : (
				activities.map((activity) => (
					<div
						className="flex flex-col gap-0.5 text-sm"
						data-testid="live-card"
						key={activity.id}
					>
						<span className="font-medium">{activity.title}</span>
						<span className="text-muted-foreground text-xs">
							{activity.detail}
						</span>
					</div>
				))
			)}
		</section>
	);
}

function Story() {
	const [open, setOpen] = useState(true);
	return (
		<I18nProvider>
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
				<QueryClientProvider client={queryClient}>
					<main className="flex min-h-screen flex-col gap-4 bg-background p-10 text-foreground">
						{scenario === "theirs" && <NodeFeed />}
						<LiveCards />
						<button
							className="w-fit rounded-lg border border-border px-3 py-1.5 text-sm"
							data-testid="open-import"
							onClick={() => setOpen(true)}
							type="button"
						>
							Import agent setup…
						</button>
						<ImportSetupDialog
							onOpenChange={setOpen}
							open={open}
							target={target}
						/>
					</main>
				</QueryClientProvider>
			</ThemeProvider>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
