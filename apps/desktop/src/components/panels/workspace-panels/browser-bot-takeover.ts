import { z } from "zod";
import type { BotLaneSelection } from "./browser-bot-lanes.ts";

// Wire contract of a takeover of an agent's tab in the @ryu/browser sidecar
// (`apps-store/browser/sidecar/src/main/control-takeover.ts`): the request an
// agent opened, the owner's answer to it, and the owner's input for the tab
// while they have control.

/** How often the frame is refreshed while the owner has control of the tab. */
export const BOT_TAKEOVER_POLL_MS = 200;
/** Most input events one request carries (the sidecar's limit). */
export const MAX_TAKEOVER_EVENTS = 64;

export const botLaneTakeoverSchema = z.object({
	expires_at: z.string(),
	reason: z.string(),
	requested_at: z.string(),
	status: z.enum(["active", "pending"]),
	tab_id: z.string().min(1),
});

export interface BotLaneTakeover {
	expiresAt: string;
	/** Written by the agent. Untrusted: render it as plain text only. */
	reason: string;
	status: "active" | "pending";
	tabId: string;
}

export function botLaneTakeover(
	wire: z.infer<typeof botLaneTakeoverSchema>
): BotLaneTakeover {
	return {
		expiresAt: wire.expires_at,
		reason: wire.reason,
		status: wire.status,
		tabId: wire.tab_id,
	};
}

export type BotTakeoverAction = "accept" | "decline" | "done";

function laneTabPath(base: string, selection: BotLaneSelection): string {
	return `${base}/lanes/${encodeURIComponent(selection.agentId)}/tabs/${encodeURIComponent(selection.tabId)}`;
}

/** The sidecar path that answers a lane tab's takeover request. */
export function botTakeoverPath(
	base: string,
	selection: BotLaneSelection
): string {
	return `${laneTabPath(base, selection)}/takeover`;
}

/** The sidecar path that takes the owner's input for a lane tab. */
export function botTakeoverInputPath(
	base: string,
	selection: BotLaneSelection
): string {
	return `${laneTabPath(base, selection)}/input`;
}

/**
 * Why an answer to a takeover request was refused, from the HTTP status the
 * sidecar call failed with: 423 while the agent still has a call running, 409
 * when the request is no longer open.
 */
export function botTakeoverFailure(
	error: unknown
): "busy" | "closed" | "other" {
	const status = error instanceof Error ? error.message : "";
	if (status === "423") {
		return "busy";
	}
	return status === "409" ? "closed" : "other";
}

export interface TakeoverModifiers {
	alt?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
}

export type TakeoverInputEvent =
	| {
			action: "down" | "move" | "up";
			button: "left" | "middle" | "none" | "right";
			buttons: number;
			click_count: number;
			modifiers: TakeoverModifiers;
			type: "mouse";
			x: number;
			y: number;
	  }
	| {
			delta_x: number;
			delta_y: number;
			modifiers: TakeoverModifiers;
			type: "wheel";
			x: number;
			y: number;
	  }
	| {
			action: "down" | "up";
			code: string;
			key: string;
			modifiers: TakeoverModifiers;
			type: "key";
	  }
	| { text: string; type: "text" };

interface Box {
	height: number;
	left: number;
	top: number;
	width: number;
}

/**
 * The page point under a pointer position, or null outside the picture. The
 * frame is drawn `object-contain` inside `box`, so the letterbox bars around
 * it are not part of the page.
 */
export function takeoverPagePoint(
	pointer: { x: number; y: number },
	box: Box,
	frame: { height: number; width: number }
): { x: number; y: number } | null {
	if (
		!(frame.width > 0 && frame.height > 0 && box.width > 0 && box.height > 0)
	) {
		return null;
	}
	const scale = Math.min(box.width / frame.width, box.height / frame.height);
	const shownWidth = frame.width * scale;
	const shownHeight = frame.height * scale;
	const x = (pointer.x - box.left - (box.width - shownWidth) / 2) / scale;
	const y = (pointer.y - box.top - (box.height - shownHeight) / 2) / scale;
	if (x < 0 || y < 0 || x > frame.width || y > frame.height) {
		return null;
	}
	return { x: Math.round(x), y: Math.round(y) };
}

const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

/** The takeover name of a `MouseEvent.button` number. */
export function takeoverButton(
	button: number
): "left" | "middle" | "none" | "right" {
	return MOUSE_BUTTONS[button] ?? "none";
}

const WHEEL_LINE_PIXELS = 40;
const MAX_WHEEL_DELTA = 10_000;

/** A wheel delta in pixels, whatever unit the wheel event used. */
export function takeoverWheelDelta(delta: number, deltaMode: number): number {
	const pixels = deltaMode === 0 ? delta : delta * WHEEL_LINE_PIXELS;
	return Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, pixels));
}

/**
 * Sends the owner's input to the sidecar in order, one request at a time.
 * Events that arrive while a request is running wait for the next one, and a
 * run of pointer moves keeps only its newest position.
 */
export class TakeoverInputQueue {
	private pending: TakeoverInputEvent[] = [];
	private sending = false;
	private closed = false;

	constructor(
		private readonly send: (events: TakeoverInputEvent[]) => Promise<boolean>,
		private readonly onRefused: () => void
	) {}

	push(event: TakeoverInputEvent): void {
		if (this.closed) {
			return;
		}
		const last = this.pending.at(-1);
		if (
			event.type === "mouse" &&
			event.action === "move" &&
			last?.type === "mouse" &&
			last.action === "move"
		) {
			this.pending[this.pending.length - 1] = event;
		} else {
			this.pending.push(event);
		}
		this.flush().catch(() => undefined);
	}

	/** Stop sending and forget what has not been sent. */
	close(): void {
		this.closed = true;
		this.pending = [];
	}

	private async flush(): Promise<void> {
		if (this.sending) {
			return;
		}
		this.sending = true;
		try {
			while (this.pending.length > 0 && !this.closed) {
				const batch = this.pending.splice(0, MAX_TAKEOVER_EVENTS);
				const accepted = await this.send(batch).catch(() => false);
				if (!accepted) {
					// The takeover ended (Done, timeout) or the tab is gone.
					this.pending = [];
					this.onRefused();
					return;
				}
			}
		} finally {
			this.sending = false;
		}
	}
}
