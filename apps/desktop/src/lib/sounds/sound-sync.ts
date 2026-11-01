// Cross-window sound bookkeeping. Each Ryu window (main, tear-offs, companion
// windows) is its own JS realm with its own sound engine, so a cue played in
// one window, a Stop pressed in one, or a new turn started in one must reach
// the others or the same run would sound twice (or a stopped run would still
// sound from the main window's run feed). A same-origin BroadcastChannel
// carries those facts; the clock they carry is wall-clock milliseconds, which
// every window shares.

import { z } from "zod";

export const SOUND_SYNC_CHANNEL = "ryu:ui-sounds";

const soundSyncMessageSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("played"),
		key: z.string().min(1),
		at: z.number(),
	}),
	z.object({
		kind: z.literal("stopped"),
		conversationId: z.string().min(1),
		at: z.number(),
	}),
	z.object({
		kind: z.literal("started"),
		conversationId: z.string().min(1),
		at: z.number(),
	}),
]);

export type SoundSyncMessage = z.infer<typeof soundSyncMessageSchema>;

/** Validate a message from another window; anything else is ignored. */
export function parseSoundSyncMessage(data: unknown): SoundSyncMessage | null {
	const parsed = soundSyncMessageSchema.safeParse(data);
	return parsed.success ? parsed.data : null;
}

/** The slice of BroadcastChannel this module uses (tests pass a fake). */
export interface SoundSyncChannel {
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void
	): void;
	close(): void;
	postMessage(message: unknown): void;
	removeEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void
	): void;
}

export interface SoundSync {
	dispose(): void;
	post(message: SoundSyncMessage): void;
}

/** Open the browser channel, or null where BroadcastChannel is missing. */
export function openBrowserSoundChannel(): SoundSyncChannel | null {
	try {
		if (!("BroadcastChannel" in globalThis)) {
			return null;
		}
		return new BroadcastChannel(SOUND_SYNC_CHANNEL);
	} catch {
		return null;
	}
}

/**
 * Relay sound bookkeeping between windows. `apply` receives every valid
 * message another window posts; `post` never throws into a caller.
 */
export function createSoundSync(
	channel: SoundSyncChannel | null,
	apply: (message: SoundSyncMessage) => void
): SoundSync {
	if (!channel) {
		return { post: () => undefined, dispose: () => undefined };
	}
	const listener = (event: { data: unknown }) => {
		const message = parseSoundSyncMessage(event.data);
		if (!message) {
			return;
		}
		try {
			apply(message);
		} catch {
			// A bad message must not break the channel for later ones.
		}
	};
	channel.addEventListener("message", listener);
	let open = true;
	return {
		post(message) {
			if (!open) {
				return;
			}
			try {
				channel.postMessage(message);
			} catch {
				// A closing window can refuse the post; the cue already played.
			}
		},
		dispose() {
			if (!open) {
				return;
			}
			open = false;
			channel.removeEventListener("message", listener);
			try {
				channel.close();
			} catch {
				// Already closed.
			}
		},
	};
}
