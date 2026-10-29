/**
 * Cross-window live-media state.
 *
 * The main workspace owns the source (browser tab, remote desktop, or evidence
 * recording). The native `media-pip` Tauri window is a separate webview, so a
 * small BroadcastChannel keeps it in sync without making either renderer own the
 * other's React tree.
 */

import { z } from "zod";

export const MEDIA_RECORDING_EVENT = "ryu:media-recording";

export type MediaSourceKind =
	| "agent-browser"
	| "browser"
	| "desktop"
	| "recording";

export interface MediaSource {
	id: string;
	imageUrl?: string;
	kind: MediaSourceKind;
	posterUrl?: string;
	tabId?: string;
	title: string;
	updatedAt: number;
	videoUrl?: string;
}

export interface MediaRecordingDetail {
	id: string;
	posterUrl?: string;
	title?: string;
	url: string;
}

type MediaMessage =
	| { source: MediaSource; type: "source" }
	| { id?: string; type: "clear" }
	| { type: "request" };

const CHANNEL_NAME = "ryu:media-pip";

let activeSource: MediaSource | null = null;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();

const mediaSourceSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		updatedAt: z.number(),
		kind: z.enum(["agent-browser", "browser", "desktop", "recording"]),
		imageUrl: z.string().optional(),
		videoUrl: z.string().optional(),
		posterUrl: z.string().optional(),
		tabId: z.string().optional(),
	})
	.passthrough();
const mediaMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("source"), source: mediaSourceSchema }),
	z.object({ type: z.literal("clear"), id: z.string().optional() }),
	z.object({ type: z.literal("request") }),
]);
export const mediaRecordingDetailSchema = z.object({
	id: z.string(),
	url: z.string(),
	title: z.string().optional(),
	posterUrl: z.string().optional(),
});
type MediaSourceContent = Omit<MediaSource, "updatedAt">;
interface MediaSourceDraft extends MediaSourceContent {
	updatedAt?: number;
}

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
}

function receive(event: MessageEvent): void {
	const parsed = mediaMessageSchema.safeParse(event.data);
	if (!parsed.success) {
		return;
	}
	const candidate = parsed.data;
	if (candidate.type === "source") {
		activeSource = candidate.source;
		notify();
		return;
	}
	if (candidate.type === "clear") {
		if (candidate.id && activeSource?.id !== candidate.id) {
			return;
		}
		activeSource = null;
		notify();
		return;
	}
	if (candidate.type === "request" && activeSource) {
		channel?.postMessage({
			source: activeSource,
			type: "source",
		} satisfies MediaMessage);
	}
}

function ensureChannel(): BroadcastChannel | null {
	if (
		channel ||
		globalThis.window === undefined ||
		!("BroadcastChannel" in window)
	) {
		return channel;
	}
	channel = new BroadcastChannel(CHANNEL_NAME);
	channel.addEventListener("message", receive);
	return channel;
}

export function getMediaSourceSnapshot(): MediaSource | null {
	return activeSource;
}

export function subscribeMediaSource(listener: () => void): () => void {
	ensureChannel();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function requestMediaSource(): void {
	ensureChannel()?.postMessage({ type: "request" } satisfies MediaMessage);
}

export function publishMediaSource(source: MediaSourceDraft): void {
	activeSource = {
		...source,
		updatedAt: source.updatedAt ?? Date.now(),
	};
	notify();
	ensureChannel()?.postMessage({
		source: activeSource,
		type: "source",
	} satisfies MediaMessage);
}

export function clearMediaSource(sourceId?: string): void {
	if (sourceId && activeSource?.id !== sourceId) {
		return;
	}
	activeSource = null;
	notify();
	ensureChannel()?.postMessage({
		id: sourceId,
		type: "clear",
	} satisfies MediaMessage);
}

export function mediaRecordingSource(
	detail: MediaRecordingDetail | null | undefined
): MediaSourceContent | null {
	const parsed = mediaRecordingDetailSchema.safeParse(detail);
	if (!parsed.success) {
		return null;
	}
	const candidate = parsed.data;
	const url = candidate.url.trim();
	if (!url) {
		return null;
	}
	return {
		id: candidate.id,
		kind: "recording",
		posterUrl: candidate.posterUrl,
		title: candidate.title?.trim() || "Evidence recording",
		videoUrl: url,
	};
}
