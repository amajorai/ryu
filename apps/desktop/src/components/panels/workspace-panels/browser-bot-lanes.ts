import { z } from "zod";

// Wire contract of the @ryu/browser sidecar's read-only Bot-lane live view
// (`apps-store/browser/sidecar/src/main/control-live-view.ts`).

/** How often the open live view asks for the lane tab's latest frame. */
export const BOT_LIVE_VIEW_POLL_MS = 500;
/** How often the lane list is refreshed while the live view is open. */
export const BOT_LANES_POLL_MS = 3000;

const laneTabSchema = z.object({
	id: z.string().min(1),
	title: z.string().catch(""),
	url: z.string().catch(""),
});

const botLanesReplySchema = z.object({
	lanes: z.array(
		z.object({
			agent_id: z.string().min(1),
			tabs: z.array(laneTabSchema),
		})
	),
});

const liveFrameReplySchema = z.object({
	frame: z
		.object({
			captured_at: z.string(),
			height: z.number().nonnegative(),
			image: z.string().min(1),
			mime: z.literal("image/jpeg"),
			seq: z.number().int().nonnegative(),
			width: z.number().nonnegative(),
		})
		.nullable(),
});

export interface BotLaneTab {
	id: string;
	title: string;
	url: string;
}

export interface BotLane {
	agentId: string;
	tabs: BotLaneTab[];
}

export interface BotLaneSelection {
	agentId: string;
	tabId: string;
}

export interface BotLiveFrame {
	capturedAt: string;
	height: number;
	seq: number;
	src: string;
	width: number;
}

/** The sidecar's `GET /lanes` reply, or an empty list for anything else. */
export function parseBotLanes(value: unknown): BotLane[] {
	const parsed = botLanesReplySchema.safeParse(value);
	if (!parsed.success) {
		return [];
	}
	return parsed.data.lanes.map((lane) => ({
		agentId: lane.agent_id,
		tabs: lane.tabs,
	}));
}

/** The latest frame from a screencast reply; null when there is none yet. */
export function parseBotLiveFrame(value: unknown): BotLiveFrame | null {
	const parsed = liveFrameReplySchema.safeParse(value);
	const frame = parsed.success ? parsed.data.frame : null;
	if (!frame) {
		return null;
	}
	return {
		capturedAt: frame.captured_at,
		height: frame.height,
		seq: frame.seq,
		src: `data:${frame.mime};base64,${frame.image}`,
		width: frame.width,
	};
}

/**
 * Keep the watched tab while it is still open; otherwise watch the first tab
 * of the first lane that has one, or nothing.
 */
export function pickBotLaneTab(
	lanes: BotLane[],
	current: BotLaneSelection | null
): BotLaneSelection | null {
	if (
		current &&
		lanes.some(
			(lane) =>
				lane.agentId === current.agentId &&
				lane.tabs.some((tab) => tab.id === current.tabId)
		)
	) {
		return current;
	}
	for (const lane of lanes) {
		const first = lane.tabs[0];
		if (first) {
			return { agentId: lane.agentId, tabId: first.id };
		}
	}
	return null;
}

/** The sidecar path of one lane tab's screencast, under the ext-proxy `base`. */
export function botLaneScreencastPath(
	base: string,
	selection: BotLaneSelection
): string {
	return `${base}/lanes/${encodeURIComponent(selection.agentId)}/tabs/${encodeURIComponent(selection.tabId)}/screencast`;
}
