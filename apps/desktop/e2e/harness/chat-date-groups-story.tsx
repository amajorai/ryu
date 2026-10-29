// Standalone browser story for the REAL transcript's day grouping — the
// centred date separators and the floating sticky date chip
// (`packages/blocks/src/desktop/agent-elements/{date-groups,date-separator,
// floating-date-header}.*`), mounted through the desktop's own `AgentChat`
// exactly as ChatPage does.
//
// Why a real browser rather than a render test: every claim worth making here
// is a LAYOUT claim. The chip is absolutely positioned in the same 36px lane
// the pinned-user-message bar was pushed out of (`sticky top-9`), and "they do
// not overlap" is a question about two rects, not about markup. Which day the
// chip names is driven by `useMessageScrollerVisibility`, which only produces a
// `currentAnchorId` once elements have been measured and observed. And the
// regression this feature could most easily reintroduce — the React #185
// "Maximum update depth" loop that a scroll-driven IN-FLOW element caused — is
// only observable by scrolling a live document and watching the console.
//
// Two cases from one page, selected by query string:
//   (default)      pinned user message ON  — chip and pin bar share the top
//   ?pin=off       the Appearance toggle is off — the chip must not move
//
// The fixture spans three days and is dated through `createdAt`, the same field
// ChatPage's `resolveCreatedAt` puts on every message. This is deliberately NOT
// a restamp of `chat-scroll-story.tsx`: that fixture carries no `createdAt` at
// all, which is exactly why chat-scroll-story.spec.ts and
// chat-message-align.spec.ts keep seeing a transcript with zero separators.

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

const params = new URLSearchParams(window.location.search);
const pinOff = params.get("pin") === "off";

// Drive the REAL persisted toggles rather than the context defaults, so the
// "pin off" case exercises the same read path the Appearance switch writes to.
try {
	localStorage.setItem("ryu:pin-user-message", pinOff ? "false" : "true");
	localStorage.setItem("ryu:open-chat-at-bottom", "true");
	// Pin the display zone so the day boundaries below are exact wherever this
	// runs, and the expected labels are not a function of the CI machine.
	localStorage.setItem("ryu:timezone", "UTC");
} catch {
	// Persistence is best-effort; the providers fall back to their defaults.
}

const MS_PER_DAY = 86_400_000;
/** Turns per day — enough that a day is more than one viewport tall. */
const TURNS_PER_DAY = 8;
/** How long ChatPage's history fetch is stood in for. */
const HYDRATION_DELAY_MS = 60;

/**
 * Three consecutive days ending today, so the labels exercise all three
 * branches of `dayLabel`: an explicit weekday, then Yesterday, then Today.
 */
const DAY_OFFSETS = [2, 1, 0] as const;

/** Midday on the day `daysAgo` back — comfortably inside the day in UTC. */
function stampFor(daysAgo: number, turn: number): Date {
	const midnightToday = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
	const noon = midnightToday - daysAgo * MS_PER_DAY + MS_PER_DAY / 2;
	return new Date(noon + turn * 60_000);
}

function buildHistory(): DatedFixtureMessage[] {
	const messages: DatedFixtureMessage[] = [];
	for (const daysAgo of DAY_OFFSETS) {
		for (let i = 0; i < TURNS_PER_DAY; i += 1) {
			const at = stampFor(daysAgo, i);
			messages.push({
				id: `d${daysAgo}-user-${i}`,
				role: "user",
				parts: [{ type: "text", text: `Question ${i} on day -${daysAgo}` }],
				createdAt: at,
			});
			messages.push({
				id: `d${daysAgo}-assistant-${i}`,
				role: "assistant",
				parts: [
					{
						type: "text",
						// Long enough that a turn is taller than the 10rem intrinsic size
						// the transcript's `content-visibility` items estimate with.
						text: `Answer ${i}.\n\n${"The reply runs on for several lines so each turn is taller than the placeholder estimate. ".repeat(6)}`,
					},
				],
				createdAt: new Date(at.getTime() + 30_000),
			});
		}
	}
	return messages;
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
				data-message-count={messages.length}
				data-pin={pinOff ? "off" : "on"}
				data-testid="story-state"
			/>
			<div className="flex min-h-0 flex-1 flex-col">
				<ChatDisplayPrefs>
					<AgentChat
						conversationKey="conv-days"
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
