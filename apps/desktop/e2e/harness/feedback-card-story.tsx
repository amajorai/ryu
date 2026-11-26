// Standalone browser story for the in-chat feedback card (`feedback.draft`):
// the REAL `FeedbackTool` in every state a chat can show it in, fed by the
// REAL desktop attachment builder (`feedbackAttachments`), so the lines on the
// card are the redacted lines the app would attach.
//
// What needs a browser and not a unit test:
//
//   1. Layout. The card holds a title field, up to four text areas, a list of
//      attached lines and a footer with a sentence beside two buttons. Whether
//      that footer wraps cleanly at phone width, and whether a long attached
//      line breaks instead of widening the card, is geometry.
//   2. Both themes. The card uses the shared card and muted tokens; only a
//      painted page shows whether the attached lines stay readable in dark.
//
// The host here never touches the clipboard or opens a window. It records what
// the card handed over, on the page, so the spec can read exactly what would
// have been copied.
//
// HARNESS LIMIT: the destination (clipboard plus the feedback board) is a
// recording fake. The real host is covered by `chat-feedback-host.test.tsx`.

import {
	type FeedbackActions,
	FeedbackHostContext,
} from "@ryu/blocks/desktop/agent-elements/feedback-host-context.tsx";
import { writeFeedbackDecision } from "@ryu/blocks/desktop/agent-elements/tools/feedback-tool.ts";
import { FeedbackTool } from "@ryu/blocks/desktop/agent-elements/tools/feedback-tool.tsx";
import { type ReactNode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type FeedbackEnvironment,
	feedbackAttachments,
} from "../../src/lib/feedback-environment.ts";
import "../../src/index.css";

const ENVIRONMENT: FeedbackEnvironment = {
	agentId: "ryu-assistant",
	appVersion: "0.5.2",
	coreVersion: "0.5.2",
	gatewayVersion: "0.5.1",
	locale: "en",
	model: "claude-sonnet-4-5",
	system: "windows-x86_64",
};

// A failed tool call whose error carries a home folder, an email address and a
// credential. None of the three may reach the card.
const MESSAGES = [
	{
		id: "m1",
		parts: [
			{
				errorText:
					"export failed: could not write C:\\Users\\dana\\Documents\\plan.pdf for dana@example.com (Authorization: Bearer story-token-0123456789abcdef)",
				state: "output-error",
				toolName: "files.export_pdf",
				type: "dynamic-tool",
			},
			{
				errorText: "request timed out after 30 s",
				state: "output-error",
				type: "tool-web.fetch",
			},
		],
		role: "assistant",
	},
];

const IDEA_INPUT = {
	body: "I keep my reading list in a table and would like to export it as a PDF with the same dark theme I use in the app. Today the export is always light, which is hard to read at night.",
	kind: "idea",
	title: "Dark theme for PDF exports",
};

const BUG_INPUT = {
	actual: "The export stops with an error and no file is written.",
	body: "Exporting a table to PDF fails every time on my machine since the last update.",
	expected: "A PDF file in my Documents folder.",
	kind: "bug",
	steps:
		"1. Open a table with more than 100 rows.\n2. Choose Export, then PDF.\n3. Pick the Documents folder.",
	title: "PDF export fails for large tables",
};

const THANKS_CALL_ID = "story-thanks";
const DECLINED_CALL_ID = "story-declined";

interface Recorded {
	followUps: string[];
	opened: number;
	reports: string[];
}

function Pane({
	children,
	id,
	label,
}: {
	children: ReactNode;
	id: string;
	label: string;
}) {
	return (
		<section className="flex flex-col gap-2" data-testid={id}>
			<h2 className="text-muted-foreground text-xs">{label}</h2>
			{children}
		</section>
	);
}

function App() {
	const [recorded, setRecorded] = useState<Recorded>({
		followUps: [],
		opened: 0,
		reports: [],
	});
	const host = useMemo<FeedbackActions>(
		() => ({
			collectAttachments: (kind) =>
				Promise.resolve(feedbackAttachments(kind, ENVIRONMENT, MESSAGES)),
			openDestination: () => {
				setRecorded((current) => ({ ...current, opened: current.opened + 1 }));
				return Promise.resolve();
			},
			submitFeedback: (submission) => {
				setRecorded((current) => ({
					...current,
					opened: current.opened + 1,
					reports: [...current.reports, submission.report],
				}));
				return Promise.resolve({ destinationOpened: true, status: "copied" });
			},
		}),
		[]
	);
	const onFollowUp = (text: string) => {
		setRecorded((current) => ({
			...current,
			followUps: [...current.followUps, text],
		}));
	};
	return (
		<div className="min-h-screen bg-background p-4 text-foreground sm:p-6">
			<div className="mx-auto flex max-w-2xl flex-col gap-6">
				<FeedbackHostContext.Provider value={host}>
					<Pane id="story-idea" label="Idea, draft">
						<FeedbackTool
							onFollowUp={onFollowUp}
							part={{
								input: IDEA_INPUT,
								state: "input-available",
								toolCallId: "story-idea",
							}}
						/>
					</Pane>
					<Pane id="story-bug" label="Bug, draft">
						<FeedbackTool
							onFollowUp={onFollowUp}
							part={{
								input: BUG_INPUT,
								state: "input-available",
								toolCallId: "story-bug",
							}}
						/>
					</Pane>
					<Pane id="story-thanks" label="After sending">
						<FeedbackTool
							onFollowUp={onFollowUp}
							part={{
								input: BUG_INPUT,
								state: "output-available",
								toolCallId: THANKS_CALL_ID,
							}}
						/>
					</Pane>
					<Pane id="story-declined" label="After Not now">
						<FeedbackTool
							onFollowUp={onFollowUp}
							part={{
								input: IDEA_INPUT,
								state: "output-available",
								toolCallId: DECLINED_CALL_ID,
							}}
						/>
					</Pane>
				</FeedbackHostContext.Provider>
				<Pane id="story-read-only" label="Chat without a feedback host">
					<FeedbackTool
						part={{
							input: IDEA_INPUT,
							state: "output-available",
							toolCallId: "story-read-only",
						}}
					/>
				</Pane>
				<Pane id="story-streaming" label="While the agent is still writing">
					<FeedbackTool
						part={{ input: { kind: "idea" }, state: "input-streaming" }}
					/>
				</Pane>
				<Pane id="story-recorded" label="What the card handed to the host">
					<output data-testid="story-opened">{recorded.opened}</output>
					<ul data-testid="story-follow-ups">
						{recorded.followUps.map((text) => (
							<li key={text}>{text}</li>
						))}
					</ul>
					{recorded.reports.map((report) => (
						<pre
							className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs"
							data-testid="story-report"
							key={report}
						>
							{report}
						</pre>
					))}
				</Pane>
			</div>
		</div>
	);
}

// Every load starts from the same decisions: two cards already closed, the
// rest open, whatever the previous run clicked.
localStorage.clear();
writeFeedbackDecision(THANKS_CALL_ID, {
	kind: "copied",
	title: BUG_INPUT.title,
});
writeFeedbackDecision(DECLINED_CALL_ID, { kind: "declined" });

// `?theme=dark` paints the dark tokens from the first frame, so a screenshot
// never catches a colour transition half way.
if (new URLSearchParams(window.location.search).get("theme") === "dark") {
	document.documentElement.classList.add("dark");
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
