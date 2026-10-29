// Standalone browser story for MESSAGING-STYLE SENDER RUNS in the real
// transcript — consecutive user messages with no reply between them draw one
// avatar, on the row that closes the run, and sit tighter than unrelated turns
// (`userRunPositions` in `packages/blocks/src/desktop/agent-elements/
// message-list.tsx`, `groupPosition` in `user-message.tsx`).
//
// This fixture exists because NO other one contains two consecutive user
// messages. `chat-scroll-story.tsx` and `chat-date-groups-story.tsx` are both
// strict user/assistant alternations, so every turn there is a run of one and
// the grouping code is entirely untested by them — a collapsed avatar gutter or
// an inverted first/last would pass both of those suites.
//
// Why a real browser: the load-bearing claim is a LAYOUT claim. Omitting the
// avatar on a non-closing row does not merely hide a picture, it collapses
// `Message`'s 32px flex gutter and slides the whole bubble sideways, which is
// only observable as a rect. The run is also not a DOM subtree — it spans
// sibling `MessageScrollerItem`s, because Content's MutationObserver watches
// `childList` with no `subtree` and a per-run wrapper would kill
// scroll-new-turn-to-top — so "these rows are one group" is a claim about
// attributes and geometry, not about nesting.
//
// The fixture, in order:
//   • a run of THREE consecutive user messages, then THREE assistant replies;
//   • a lone user message with a reply (a run of one);
//   • a pair of user messages split by a DAY boundary, which must break the run
//     even though no assistant spoke between them.

import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import type { createMessageDecorator } from "../../src/lib/chat-message-decoration.ts";
import "../../src/index.css";

type DatedFixtureMessage = ReturnType<
	ReturnType<typeof createMessageDecorator<UIMessage>>
>[number];

const MS_PER_DAY = 86_400_000;
/** How long ChatPage's history fetch is stood in for. */
const HYDRATION_DELAY_MS = 60;

// Pin the display zone so the day boundary below falls where the fixture says it
// does, wherever this runs.
try {
	localStorage.setItem("ryu:timezone", "UTC");
	localStorage.setItem("ryu:open-chat-at-bottom", "true");
} catch {
	// Persistence is best-effort; the providers fall back to their defaults.
}

/** Midday `daysAgo` back, plus `minute` — comfortably inside the day in UTC. */
function stampFor(daysAgo: number, minute: number): Date {
	const midnightToday = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
	return new Date(
		midnightToday - daysAgo * MS_PER_DAY + MS_PER_DAY / 2 + minute * 60_000
	);
}

function user(id: string, text: string, at: Date): DatedFixtureMessage {
	return {
		id,
		role: "user",
		parts: [{ type: "text", text }],
		createdAt: at,
	};
}

function assistant(id: string, text: string, at: Date): DatedFixtureMessage {
	return {
		id,
		role: "assistant",
		parts: [{ type: "text", text }],
		createdAt: at,
	};
}

/**
 * Expected `data-group-position`, item by item, for the history below. Exported
 * to the page as a data attribute so the spec asserts against the fixture's own
 * intent rather than a list copied into two places.
 */
const EXPECTED_POSITIONS = [
	// Yesterday: one user message left unanswered at the end of the day. It is
	// followed by another user message, but a DAY SEPARATOR falls between them,
	// so the run must close here.
	"single",
	// Today: three consecutive questions, then a reply.
	"first",
	"middle",
	"last",
	// A question that was answered — a run of one.
	"single",
] as const;

function buildHistory(): UIMessage[] {
	return [
		// --- yesterday: a question nobody answered -------------------------
		user("y-user-0", "Did the nightly build ever finish?", stampFor(1, 0)),
		// --- today ----------------------------------------------------------
		// Three in a row, no reply between them: ONE avatar, on the last.
		user("t-user-0", "Morning — picking this back up.", stampFor(0, 0)),
		user(
			"t-user-1",
			"The failure is in the scheduler, not the queue.",
			stampFor(0, 1)
		),
		user(
			"t-user-2",
			"Can you read `scheduler.rs` and tell me what retries look like?",
			stampFor(0, 2)
		),
		assistant("t-assistant-0", "Retries are capped at three.", stampFor(0, 3)),
		assistant(
			"t-assistant-1",
			"The relevant loop backs off exponentially.",
			stampFor(0, 3)
		),
		assistant(
			"t-assistant-2",
			"It gives up on the fourth attempt.",
			stampFor(0, 3)
		),
		// A single question with a reply: the ungrouped shape.
		user("t-user-3", "And the queue depth?", stampFor(0, 4)),
		assistant(
			"t-assistant-3",
			`Unbounded today.\n\n${"Nothing sheds load, so a slow consumer grows the queue until memory runs out. ".repeat(4)}`,
			stampFor(0, 5)
		),
	];
}

function Story() {
	const [messages, setMessages] = useState<UIMessage[]>([]);

	// Mirrors ChatPage: the conversation id is known at mount, its history is not.
	useEffect(() => {
		const timer = window.setTimeout(() => {
			setMessages(buildHistory());
		}, HYDRATION_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, []);

	return (
		<div className="flex h-screen flex-col bg-background">
			<div
				data-expected-positions={EXPECTED_POSITIONS.join(",")}
				data-message-count={messages.length}
				data-testid="story-state"
			/>
			<div className="flex min-h-0 flex-1 flex-col">
				<ChatDisplayPrefs>
					<AgentChat
						conversationKey="conv-grouping"
						// Without a current user there is no avatar at all, and every
						// gutter assertion below would pass vacuously.
						currentUser={{ id: "me", name: "You" }}
						emptyStatePosition="center"
						messages={messages}
						onSend={() => {
							// The story never sends; the composer is here because the real
							// surface always carries one.
						}}
						onStop={() => {
							// Required by AgentChatProps; nothing streams here.
						}}
						status="ready"
					/>
				</ChatDisplayPrefs>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
