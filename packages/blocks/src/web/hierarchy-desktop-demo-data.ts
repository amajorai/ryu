/** One scripted session the coordinator delegates. */
export interface DemoSession {
	agent: string;
	id: string;
	reply: string;
	title: string;
	transcript: { role: "user" | "assistant"; text: string }[];
}

export const SESSIONS: DemoSession[] = [
	{
		agent: "scout",
		id: "demo-session-copy",
		reply: "Landing copy is tightened and the hero CTA now matches pricing.",
		title: "Audit landing copy",
		transcript: [
			{
				role: "user",
				text: "Audit the launch page copy against the pricing page and fix mismatches.",
			},
			{
				role: "assistant",
				text: "Found 3 mismatches. Updated the hero CTA, the plan names, and the FAQ answer about seats.",
			},
		],
	},
	{
		agent: "designer",
		id: "demo-session-og",
		reply: "Social cards exported in light and dark.",
		title: "Make social cards",
		transcript: [
			{ role: "user", text: "Make the Open Graph images for the launch." },
			{
				role: "assistant",
				text: "Exported 1200×630 cards in light and dark, using the new wordmark.",
			},
		],
	},
	{
		agent: "qa",
		id: "demo-session-qa",
		reply: "All 42 checks pass on the staging build.",
		title: "Run launch checks",
		transcript: [
			{ role: "user", text: "Run the launch checklist on staging." },
			{
				role: "assistant",
				text: "All 42 checks pass. Lighthouse 98, no broken links, forms submit.",
			},
		],
	},
];

export type Phase = 0 | 1 | 2 | 3 | 4;

/** Which status each session shows at each phase of the loop. */
export function sessionState(
	index: number,
	phase: Phase
): "starting" | "running" | "done" {
	if (phase === 0) {
		return "starting";
	}
	if (phase >= 2 + index) {
		return "done";
	}
	return "running";
}

/** A tool part shaped exactly like the one Core streams for `threads.*`. */
export function sessionPart(
	session: DemoSession,
	state: "starting" | "running" | "done"
) {
	if (state === "starting") {
		return {
			input: { agent_id: session.agent, title: session.title },
			output: { ok: true, thread_id: session.id, title: session.title },
			state: "output-available",
			toolName: "threads.create_thread",
			type: "dynamic-tool",
		};
	}
	return {
		input: {
			message: session.transcript[0]?.text,
			thread_id: session.id,
			wait: state === "done",
		},
		// Core echoes the session's title and bot on every threads.* result.
		output:
			state === "done"
				? {
						agent_id: session.agent,
						ok: true,
						reply: session.reply,
						thread_id: session.id,
						title: session.title,
					}
				: {
						agent_id: session.agent,
						dispatched: true,
						ok: true,
						status: "running",
						thread_id: session.id,
						title: session.title,
					},
		state: "output-available",
		toolName: "threads.send_message_to_thread",
		type: "dynamic-tool",
	};
}
