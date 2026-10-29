import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type CoworkContextPanelProps,
	extractSubagents,
	SubagentActivityChips,
} from "../../src/components/panels/CoworkContextPanel.tsx";
import { PinnedSummaryPanel } from "../../src/components/panels/PinnedSummaryPanel.tsx";
import type { BtwEntry } from "../../src/lib/api/btw.ts";
import type { Artifact } from "../../src/lib/artifacts.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import "../../src/index.css";

const target = {
	url: "http://side-chat-fixture.test",
	token: "fixture-node-token",
};
interface FixtureWindow extends Window {
	__contextAction?: unknown;
	__contextActions?: unknown[];
	__openedSideChat?: BtwEntry;
}
const contextMessages: CoworkContextPanelProps["messages"] = [
	{
		role: "assistant",
		parts: [
			{ type: "text", text: "```html\n<h1>Reviewed result</h1>\n```" },
			{ type: "tool-Read", input: { file_path: "/fixture/context.ts" } },
			{
				type: "tool-Task",
				toolCallId: "fixture-subagent",
				state: "output-available",
				input: {
					description: "Review context",
					prompt: "Review the context controls.",
					subagent_type: "reviewer",
				},
				output: "Controls reviewed.",
			},
		],
	},
];
function recordContextAction<Value>(value: Value) {
	const fixtureWindow =
		/* SAFETY: This module alone writes these private optional captures; action values remain unknown and the side-chat callback receives the existing native BtwEntry input. */ window as FixtureWindow;
	fixtureWindow.__contextAction = value;
	fixtureWindow.__contextActions ??= [];
	fixtureWindow.__contextActions.push(value);
}
const controlMessages: CoworkContextPanelProps["messages"] = [
	{
		role: "assistant",
		parts: [
			...Array.from({ length: 6 }, (_, index) => ({
				type: "tool-WebFetch",
				toolCallId: `web-${index}`,
				input: { url: `https://fixture-links.test/source-${index}` },
				output: { title: `Reviewed source ${index}` },
			})),
			...Array.from({ length: 6 }, (_, index) => ({
				type: "tool-Task",
				toolCallId: `control-subagent-${index}`,
				state: "output-available",
				input: {
					description: `Review control ${index}`,
					prompt: `Inspect control ${index}.`,
					subagent_type: "reviewer",
				},
				output: `Control ${index} reviewed.`,
			})),
		],
	},
];
function Story() {
	const [currentTarget, setTarget] = useState(target);
	const [refreshKey, setRefreshKey] = useState(0);
	const params = new URLSearchParams(location.search);
	const controls = params.has("controls");
	const [worktreeMode, setWorktreeMode] = useState(false);
	const [running, setRunning] = useState(params.has("running"));
	const selectedMessages = controls
		? controlMessages
		: params.has("context")
			? contextMessages
			: [];
	const openSubagent: NonNullable<CoworkContextPanelProps["onOpenSubagent"]> = (
		subagent
	) =>
		recordContextAction({
			kind: "subagent",
			id: subagent.id,
			transcript: subagent.transcript,
		});
	return (
		<>
			<button
				onClick={() => setTarget({ ...target, token: "fixture-new-token" })}
			>
				Change fixture identity
			</button>
			<button onClick={() => setRefreshKey((value) => value + 1)}>
				Refresh fixture side chats
			</button>
			{controls && (
				<SubagentActivityChips
					onOpen={openSubagent}
					subagents={extractSubagents(selectedMessages)}
				/>
			)}
			<PinnedSummaryPanel
				conversationId="conversation/fixture"
				cowork={{
					messages: selectedMessages,
					onOpenSources: () => recordContextAction({ kind: "sources" }),
					onOpenSubagents: () => recordContextAction({ kind: "subagents" }),
					onOpenSubagent: (subagent) =>
						recordContextAction({
							kind: "subagent",
							id: subagent.id,
							transcript: subagent.transcript,
						}),
					onOpenArtifact: (artifact: Artifact) =>
						recordContextAction({
							kind: "artifact",
							content: artifact.content,
						}),
					runId: "conversation/fixture",
					target: currentTarget,
					chatStatus: running ? "streaming" : "ready",
					sideChatsEnabled: true,
					sideChatsRefreshKey: refreshKey,
					onOpenSideChat: (entry) => {
						/* SAFETY: This module alone writes these private optional captures; action values remain unknown and the side-chat callback receives the existing native BtwEntry input. */ (
							window as FixtureWindow
						).__openedSideChat = entry;
					},
				}}
				folder={params.has("project") ? "/fixture/pinned-project" : null}
				onHandOffToWorktree={(branch) => {
					setWorktreeMode(true);
					recordContextAction({
						kind: "handoff",
						branch,
						interrupted: running,
					});
				}}
				onInterruptChat={() => {
					setRunning(false);
					recordContextAction({ kind: "interrupt" });
				}}
				onWorktreeModeChange={(enabled) => {
					setWorktreeMode(enabled);
					recordContextAction({ kind: "mode", enabled });
				}}
				pullRequestsEnabled={params.has("github")}
				target={currentTarget}
				worktreeModeOverride={worktreeMode}
			/>
		</>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<div className="dark min-h-screen bg-background p-8 text-foreground">
				<div className="mx-auto h-[600px] w-80">
					<Story />
				</div>
			</div>
		</QueryClientProvider>
	);
}
