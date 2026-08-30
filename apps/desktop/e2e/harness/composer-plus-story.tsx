// Standalone browser story for the composer's "+" affordance on the REAL shared
// `InputBar` (`@ryu/blocks/desktop/agent-elements/input-bar`) — the one bar the
// chat page, the launchpad, the Ask Ryu dock and the builder panes all render.
//
// What it certifies: the "+" is a DROPDOWN on every surface, including one that
// wires nothing but attach. That regressed silently for a long time — the toolbar
// decided whether to open a menu from the *optional* rows a host supplied (goal,
// ghost, plugin toggles, image/video gen), so the chat page (which wires four of
// them) got a menu while the launchpad and builder panes (which wire none) got a
// bare button that opened the OS file picker. A build can't catch that: both
// spellings compile. Only clicking it can.
//
// Three mounts stand in for the range:
//   - "minimal"  — attach only, the launchpad/builder-pane shape
//   - "full"     — attach + temporary chat + a plugin toggle, the chat-page shape
//   - "compact"  — the same bar at chat-with-history density
// All three must open the same popover; the second just carries more rows.
//
// The "compact" mount also pins the composer's RESPONSIVE TOPOLOGY. A one-line
// textarea shares the row with the controls; when it visually wraps, the same
// editor moves above the normal full controls row. That transition is a layout
// fact only a laid-out browser can assert, so it is asserted here.
//
// Hermetic by construction: `InputBar` is presentational, so no Core node, no
// Tauri, and none of the desktop's context tree is involved.

import type { ComposerMenuGroup } from "@ryu/blocks/desktop/agent-elements/input/composer-menu.tsx";
import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

function noop() {
	return undefined;
}

const DIRECTORY_GROUPS: ComposerMenuGroup[] = [
	{
		id: "plugins",
		label: "Plugins",
		items: [
			{
				id: "plugin:proof",
				label: "Proof",
				description: "Verify the answer step by step",
				badge: "Plugin",
			},
		],
	},
	{
		id: "apps",
		label: "Apps",
		items: [
			{
				id: "app:calendar",
				label: "Calendar",
				description: "Find events and availability",
				badge: "App",
			},
		],
	},
	{
		id: "skills",
		label: "Skills",
		items: [
			{
				description: "Review the answer against a checklist",
				id: "skill:review",
				label: "Review checklist",
				badge: "Skill",
			},
		],
	},
];

function Story() {
	const [attachCount, setAttachCount] = useState(0);
	const [attachmentOnly, setAttachmentOnly] = useState(false);
	const [attachmentSent, setAttachmentSent] = useState<string | null>(null);
	const [voiceModeStarted, setVoiceModeStarted] = useState(false);
	const [expandedDraft, setExpandedDraft] = useState("");
	const [ghost, setGhost] = useState(false);
	const [flag, setFlag] = useState(false);
	const [temporaryMemory, setTemporaryMemory] = useState(false);
	const [temporaryChatSaved, setTemporaryChatSaved] = useState(false);

	return (
		<div className="flex min-h-screen flex-col gap-8 bg-background p-6">
			{/* The launchpad / builder-pane shape: attach is the ONLY row wired. */}
			<section className="flex flex-col gap-2" data-testid="minimal">
				<h2 className="font-medium text-sm">Attach only</h2>
				<InputBar
					composerMenuGroups={DIRECTORY_GROUPS}
					onAttach={() => setAttachCount((n) => n + 1)}
					onSend={noop}
					onStop={noop}
					placeholder="What do you want to do?"
					status="ready"
					turnProgress={{
						insertions: 18,
						deletions: 3,
						files: [
							{ path: "src/composer.tsx", insertions: 12, deletions: 2 },
							{ path: "src/menu.tsx", insertions: 6, deletions: 1 },
						],
						todos: {
							current: 2,
							total: 3,
							items: [
								{ label: "Inspect", status: "completed" },
								{ label: "Build", status: "in_progress" },
								{ label: "Verify", status: "pending" },
							],
						},
					}}
				/>
			</section>

			{/* An attachment-only turn must use Send even when live voice mode is
			    wired: the staged file is input, so the phone action must not take over
			    the trailing slot. */}
			<section className="flex flex-col gap-2" data-testid="attachment-only">
				<h2 className="font-medium text-sm">Attachment-only send</h2>
				<InputBar
					attachedImages={
						attachmentOnly
							? [
									{
										filename: "brief.png",
										id: "attachment-only-image",
										mimeType: "image/png",
										url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
									},
								]
							: []
					}
					enableImagePreview={false}
					onAttach={() => setAttachmentOnly(true)}
					onSend={(message) => {
						setAttachmentSent(message.content);
						setAttachmentOnly(false);
					}}
					onStop={noop}
					status="ready"
					voiceMode={{ onStart: () => setVoiceModeStarted(true) }}
				/>
				<output data-testid="attachment-stage">
					{attachmentOnly ? "attached" : "empty"}
				</output>
				<output data-testid="attachment-sent">
					{attachmentSent === null
						? "not-sent"
						: attachmentSent || "sent-attachment-only"}
				</output>
				<output data-testid="voice-mode-started">
					{voiceModeStarted ? "started" : "idle"}
				</output>
			</section>

			{/* The chat-page shape: the same menu, carrying its extra rows. */}
			<section className="flex flex-col gap-2" data-testid="full">
				<h2 className="font-medium text-sm">
					Attach + temporary chat + plugin
				</h2>
				<InputBar
					composerMenuGroups={DIRECTORY_GROUPS}
					ghost={ghost}
					ghostControls={{ active: ghost, onToggle: () => setGhost((o) => !o) }}
					onAttach={() => setAttachCount((n) => n + 1)}
					onSend={noop}
					onStop={noop}
					pluginControls={[
						{
							id: "double-check",
							flag: "double_check",
							label: "Double-check",
							enabled: flag,
							onToggle: (_f, next) => setFlag(next),
						},
						...(ghost
							? ([
									{
										description:
											"Allow this temporary chat to use personalized memories and personalization. It still will not be saved.",
										enabled: temporaryMemory,
										flag: "@ryu/memory/temporary-context",
										id: "memory.temporary-context",
										label: "Use memory in temporary chat",
										onToggle: (_f: string, next: boolean) =>
											setTemporaryMemory(next),
									},
								] as const)
							: []),
					]}
					status="ready"
					temporaryChatSaveControls={{
						onSave: () => setTemporaryChatSaved(true),
					}}
				/>
			</section>

			{/* The plugin-owned surface: the host only opts into this feature when
			    @ryu/expanded-composer contributes the chat feature. */}
			<section className="flex flex-col gap-2" data-testid="expanded">
				<h2 className="font-medium text-sm">Expanded Composer plugin</h2>
				<InputBar
					composerMenuGroups={DIRECTORY_GROUPS}
					expandComposer
					onAttach={() => setAttachCount((n) => n + 1)}
					onChange={setExpandedDraft}
					onSend={noop}
					onStop={noop}
					placeholder="Write a longer prompt…"
					status="ready"
					value={expandedDraft}
				/>
			</section>

			{/* Chat-with-history density. `leftActions` stands in for the desktop's
			    agent selector (the real one is `useComposerAgentControls`, which needs
			    the app's context tree). The browser spec grows this textarea to prove
			    the compact row changes into the normal stacked composer. */}
			<section className="flex flex-col gap-2" data-testid="compact">
				<h2 className="font-medium text-sm">Compact (chat with history)</h2>
				<InputBar
					compact
					composerMenuGroups={DIRECTORY_GROUPS}
					leftActions={
						<button data-testid="agent-trigger" type="button">
							Ryu
						</button>
					}
					onAttach={() => setAttachCount((n) => n + 1)}
					onSend={noop}
					onStop={noop}
					status="ready"
				/>
			</section>

			{/* Read back by the spec: proves the attach ROW inside the popover still
			    reaches the host's handler, not just that a menu rendered. */}
			<output data-testid="attach-count">{attachCount}</output>
			<output data-testid="ghost-state">{ghost ? "on" : "off"}</output>
			<output data-testid="temporary-memory-state">
				{temporaryMemory ? "on" : "off"}
			</output>
			<output data-testid="temporary-chat-saved">
				{temporaryChatSaved ? "saved" : "not-saved"}
			</output>
		</div>
	);
}

const container = document.getElementById("root");
if (container) {
	createRoot(container).render(<Story />);
}
