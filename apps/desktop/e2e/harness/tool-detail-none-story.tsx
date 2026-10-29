// Standalone browser story for Detail level "None" — the rung of the Appearance
// → Chat ladder that shows no tool calls and no file edits at all, leaving a
// plain messaging view. The REAL `MessageList` renders the SAME fixture twice,
// once with `hideToolDetail` off and once with it on, so any difference between
// the two panes is attributable to that one pref.
//
// Why this needs a real browser and not a unit test: the interesting failure is
// not "a tool row is still visible", it is "a turn that renders nothing left an
// EMPTY row behind". Those rows are `MessageScrollerItem`s carrying
// `content-visibility:auto` with a 10rem intrinsic estimate — an empty one is
// invisible to the eye in a screenshot and invisible to a render-count
// assertion, but it still occupies a scroll slot and still puts a gap in the
// transcript. Counting the items the scroller actually emitted, and checking
// that none of them is empty, is the assertion that catches it.
//
// The fixture covers the four turn shapes that decide the behaviour:
//   0. assistant-only, pure tool calls (no user message) — must vanish at None
//   1. user + assistant prose + a tool call    — prose stays, tool row goes
//   2. user + assistant with ONLY tool calls   — user prompt stays, no reply row
//   3. user + a FAILED tool call               — the failure must survive
//   4. user + an INTERRUPTED tool-only reply   — turn status must survive
//
// HARNESS LIMIT: this asserts what the transcript emits. It says nothing about
// the settings UI that writes the pref (see tool-detail-ladder.test.ts for the
// ladder arithmetic).

import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import type { ToolUIPart, UIMessage } from "ai";
import { createRoot } from "react-dom/client";
import { MessageList } from "../../components/agent-elements/message-list.tsx";
import proofStyles from "./tool-detail-none-story.module.css";
import "../../src/index.css";

/**
 * Text unique to each fixture element. The spec asserts on these verbatim; it
 * keeps its own copies rather than importing them, because a Playwright spec and
 * a browser story do not share a module graph.
 */
const MARKERS = {
	failedCommand: "deploy-to-prod.sh",
	openingToolOnly: "opening-scan.ts",
	prose: "The build passes on the current branch.",
	silentToolOnly: "silent-refactor.ts",
	userQuestion: "Does the build pass",
} as const;

const toolPart = (id: string, file: string): ToolUIPart => ({
	type: "tool-Read",
	toolCallId: id,
	state: "output-available",
	input: { file_path: file },
	output: { content: `contents of ${file}` },
});

interface InterruptedProofMessage extends UIMessage {
	_interrupted?: boolean;
}

const MESSAGES: InterruptedProofMessage[] = [
	// 0 — a head turn with no user message at all, made only of tool calls.
	{
		id: "a-opening",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			toolPart("call-open", MARKERS.openingToolOnly),
		],
	},
	// 1 — prose plus a tool call.
	{
		id: "u-1",
		role: "user",
		parts: [{ type: "text", text: `${MARKERS.userQuestion}?` }],
	},
	{
		id: "a-1",
		role: "assistant",
		parts: [
			toolPart("call-1", "build.ts"),
			{ type: "text", text: MARKERS.prose },
		],
	},
	// 2 — a reply that is nothing but tool work.
	{
		id: "u-2",
		role: "user",
		parts: [{ type: "text", text: "Clean that up please" }],
	},
	{
		id: "a-2",
		role: "assistant",
		parts: [
			toolPart("call-2a", MARKERS.silentToolOnly),
			toolPart("call-2b", "silent-refactor.test.ts"),
		],
	},
	// 3 — a reply whose only content is a FAILED call.
	{
		id: "u-3",
		role: "user",
		parts: [{ type: "text", text: "Ship it" }],
	},
	{
		id: "a-3",
		role: "assistant",
		parts: [
			{
				type: "tool-Bash",
				toolCallId: "call-3",
				state: "output-error",
				input: { command: `./${MARKERS.failedCommand}` },
				errorText: "exit 1: permission denied",
			},
		],
	},
	// 4 — a turn cut off mid-stream, carrying NOTHING but hidden tool work. The
	// marker rides on the message as `_interrupted` metadata, not as a part, so
	// this is the case that proves turn STATUS is not treated as tool detail: get
	// it wrong and a crashed turn disappears entirely at None.
	{
		id: "u-4",
		role: "user",
		parts: [{ type: "text", text: "Carry on" }],
	},
	{
		id: "a-4",
		role: "assistant",
		_interrupted: true,
		parts: [toolPart("call-4", "carry-on.ts")],
	},
];

function Variant({
	hideToolDetail,
	testId,
}: {
	hideToolDetail: boolean;
	testId: string;
}) {
	return (
		<ChatDisplayPrefsProvider value={{ hideToolDetail }}>
			<div
				className={`${proofStyles.transcriptPane} flex flex-col border border-border`}
				data-testid={testId}
			>
				<MessageList messages={MESSAGES} status="ready" />
			</div>
		</ChatDisplayPrefsProvider>
	);
}

function Story() {
	return (
		<div className="flex items-start gap-6 bg-background p-4">
			<Variant hideToolDetail={false} testId="with-detail" />
			<Variant hideToolDetail={true} testId="no-detail" />
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
