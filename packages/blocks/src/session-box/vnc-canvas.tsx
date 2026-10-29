/// <reference path="./novnc.d.ts" />
"use client";

// VncCanvas: the shared noVNC viewer behind every remote screen in Ryu.
//
// The node's Virtual Desktop panel and the per-session Box screen both render a
// live RFB stream. They differ only in how a stream is reached, so the viewer
// takes a `connect` factory and never builds URLs or holds credentials itself:
//
// - The factory runs on EVERY connect and reconnect. Box screen tokens are
//   single-use and live for seconds, so a reconnect always mints a fresh one.
// - The URL is dialed verbatim and the factory's `protocols` are offered as
//   WebSocket subprotocols (`wsProtocols`). A Box screen token travels as a
//   subprotocol, never in a query string, so it never reaches an access log.
// - `viewOnly` is applied to the client as well as to the token the factory
//   asked for, so a watcher's keyboard and mouse never leave the page.
//
// noVNC treats its target as a container: it appends its own screen div and
// framebuffer canvas inside it, so the target is a sized `<div>`, never a
// canvas. Every connect attempt carries a generation number; a stale async
// connect, or a retired client's events, never touch the live session.

import RFB, { type RfbEventDetail } from "@novnc/novnc";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";

/** Where a screen is dialed: an absolute `ws:`/`wss:` URL and its subprotocols. */
export interface VncEndpoint {
	protocols: string[];
	url: string;
}

/** The viewer's connection state, reported through `onStatusChange`. */
export type VncConnectionStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "disconnected"
	| "error";

/** A downscaled JPEG of the current frame, for a dock thumbnail or PiP. */
export interface VncPreviewFrame {
	id: string;
	imageUrl: string;
	title: string;
}

/** Waits before each automatic reconnect after an unclean drop. */
export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [
	1000, 3000, 10_000,
];

/** Widest frame published to the live-media preview (dock thumbnail and PiP). */
const MAX_PREVIEW_WIDTH = 1280;
const PREVIEW_INTERVAL_MS = 350;
const DIALABLE_PROTOCOLS = new Set(["ws:", "wss:"]);

export interface VncCanvasProps {
	/** Connect only while the hosting tab is visible. Defaults to true. */
	active?: boolean;
	className?: string;
	/** Mint a stream endpoint. Called again on every reconnect. */
	connect: () => Promise<VncEndpoint>;
	/** Stable id of this screen in the live-media preview. */
	mediaSourceId: string;
	/** The preview stopped (disconnect, inactive, or unmount). */
	onPreviewClear?: (id: string) => void;
	/** Receives preview frames while connected. Omit to publish none. */
	onPreviewFrame?: (frame: VncPreviewFrame) => void;
	onStatusChange?: (status: VncConnectionStatus, error: string | null) => void;
	/** Delays for automatic reconnects after an unclean drop. */
	reconnectDelaysMs?: readonly number[];
	/** Accessible name of the screen, also the preview title. */
	title: string;
	/** Watch without sending keyboard or mouse input. */
	viewOnly?: boolean;
}

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/** Refuse anything but an absolute WebSocket URL; never resolve a relative one. */
function assertDialable(endpoint: VncEndpoint): void {
	let parsed: URL;
	try {
		parsed = new URL(endpoint.url);
	} catch {
		throw new Error("The screen address is not an absolute URL.");
	}
	if (!DIALABLE_PROTOCOLS.has(parsed.protocol)) {
		throw new Error("The screen address is not a WebSocket URL.");
	}
}

function previewFrame(
	canvas: HTMLCanvasElement,
	scratch: { canvas: HTMLCanvasElement | null }
): HTMLCanvasElement {
	if (canvas.width <= MAX_PREVIEW_WIDTH) {
		return canvas;
	}
	scratch.canvas ??= document.createElement("canvas");
	const target = scratch.canvas;
	const width = MAX_PREVIEW_WIDTH;
	const height = Math.round((canvas.height * width) / canvas.width);
	if (target.width !== width || target.height !== height) {
		target.width = width;
		target.height = height;
	}
	target.getContext("2d")?.drawImage(canvas, 0, 0, width, height);
	return target;
}

const STATUS_TEXT: Record<VncConnectionStatus, string> = {
	idle: "",
	connecting: "Connecting to the screen…",
	connected: "",
	reconnecting: "Reconnecting to the screen…",
	disconnected: "The screen disconnected.",
	error: "Couldn't connect to the screen.",
};

/**
 * A live, interactive remote screen. Remount it with a new `key` to force a
 * fresh connection (for example from a Reconnect button).
 */
export function VncCanvas({
	active = true,
	className,
	connect,
	mediaSourceId,
	onPreviewClear,
	onPreviewFrame,
	onStatusChange,
	reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
	title,
	viewOnly = false,
}: VncCanvasProps) {
	const screenRef = useRef<HTMLDivElement>(null);
	const rfbRef = useRef<RFB | null>(null);
	// Generation of the current connect attempt. Every teardown or new attempt
	// bumps it, so a stale async connect never attaches to the live session.
	const attemptRef = useRef(0);
	const retriesRef = useRef(0);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The latest callbacks, read at call time so a parent passing new closures
	// each render does not reconnect the stream.
	const connectRef = useRef(connect);
	connectRef.current = connect;
	const delaysRef = useRef(reconnectDelaysMs);
	delaysRef.current = reconnectDelaysMs;
	const previewRef = useRef({ onPreviewClear, onPreviewFrame, title });
	previewRef.current = { onPreviewClear, onPreviewFrame, title };
	const statusListenerRef = useRef(onStatusChange);
	statusListenerRef.current = onStatusChange;

	const [status, setStatus] = useState<VncConnectionStatus>("idle");
	const [error, setError] = useState<string | null>(null);

	const clearRetry = useCallback(() => {
		if (retryTimerRef.current !== null) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
	}, []);

	const teardown = useCallback(() => {
		attemptRef.current += 1;
		clearRetry();
		const rfb = rfbRef.current;
		rfbRef.current = null;
		rfb?.disconnect();
	}, [clearRetry]);

	const open = useCallback(
		async (watchOnly: boolean, retry: boolean) => {
			teardown();
			const attempt = attemptRef.current;
			setStatus(retry ? "reconnecting" : "connecting");
			if (!retry) {
				setError(null);
			}
			const scheduleRetry = (reason: string) => {
				const delays = delaysRef.current;
				const index = retriesRef.current;
				if (index >= delays.length) {
					setStatus("error");
					setError(reason);
					return;
				}
				retriesRef.current = index + 1;
				setStatus("reconnecting");
				setError(reason);
				clearRetry();
				retryTimerRef.current = setTimeout(() => {
					retryTimerRef.current = null;
					if (attempt === attemptRef.current) {
						open(watchOnly, true).catch(() => undefined);
					}
				}, delays[index]);
			};
			let endpoint: VncEndpoint;
			try {
				endpoint = await connectRef.current();
				assertDialable(endpoint);
			} catch (failure) {
				if (attempt === attemptRef.current) {
					scheduleRetry(messageOf(failure, STATUS_TEXT.error));
				}
				return;
			}
			const target = screenRef.current;
			if (attempt !== attemptRef.current || !target) {
				return;
			}
			const rfb = new RFB(target, endpoint.url, {
				credentials: {},
				shared: true,
				wsProtocols: [...endpoint.protocols],
			});
			rfb.viewOnly = watchOnly;
			rfb.scaleViewport = true;
			rfb.resizeSession = false;
			rfbRef.current = rfb;

			rfb.addEventListener("connect", () => {
				if (rfbRef.current !== rfb) {
					return;
				}
				retriesRef.current = 0;
				setStatus("connected");
				setError(null);
			});
			rfb.addEventListener(
				"disconnect",
				(event: CustomEvent<RfbEventDetail>) => {
					if (rfbRef.current !== rfb) {
						return;
					}
					rfbRef.current = null;
					if (event.detail?.clean) {
						setStatus("disconnected");
						setError(event.detail.message ?? STATUS_TEXT.disconnected);
						return;
					}
					scheduleRetry(event.detail?.message ?? STATUS_TEXT.disconnected);
				}
			);
			const refuse = (message: string) => {
				if (rfbRef.current !== rfb) {
					return;
				}
				rfbRef.current = null;
				attemptRef.current += 1;
				setStatus("error");
				setError(message);
				rfb.disconnect();
			};
			rfb.addEventListener("credentialsrequired", () =>
				refuse("The screen asked for credentials, which Ryu never sends.")
			);
			rfb.addEventListener(
				"securityfailure",
				(event: CustomEvent<RfbEventDetail>) =>
					refuse(event.detail?.reason ?? "The screen refused the connection.")
			);
		},
		[clearRetry, teardown]
	);

	useEffect(() => {
		if (!active) {
			return;
		}
		retriesRef.current = 0;
		open(viewOnly, false).catch(() => undefined);
		return () => {
			teardown();
			setStatus("idle");
			setError(null);
		};
	}, [active, open, teardown, viewOnly]);

	useEffect(() => {
		statusListenerRef.current?.(status, error);
	}, [status, error]);

	const connected = status === "connected";
	useEffect(() => {
		if (!(active && connected && previewRef.current.onPreviewFrame)) {
			return;
		}
		const scratch: { canvas: HTMLCanvasElement | null } = { canvas: null };
		const publish = () => {
			const publishFrame = previewRef.current.onPreviewFrame;
			// noVNC's own framebuffer canvas; the newest screen is appended last.
			const canvases = screenRef.current?.querySelectorAll("canvas");
			const canvas = canvases?.[canvases.length - 1];
			if (!(publishFrame && canvas && canvas.width > 0 && canvas.height > 0)) {
				return;
			}
			try {
				publishFrame({
					id: mediaSourceId,
					imageUrl: previewFrame(canvas, scratch).toDataURL("image/jpeg", 0.76),
					title: previewRef.current.title,
				});
			} catch {
				// A canvas can be cleared while noVNC is tearing down. The next tick
				// retries once the client paints again.
			}
		};
		publish();
		const timer = setInterval(publish, PREVIEW_INTERVAL_MS);
		return () => {
			clearInterval(timer);
			previewRef.current.onPreviewClear?.(mediaSourceId);
		};
	}, [active, connected, mediaSourceId]);

	const overlay = connected ? "" : (error ?? STATUS_TEXT[status]);
	return (
		<section
			aria-label={title}
			className={cn("relative h-full min-h-0 w-full bg-black", className)}
			data-live-media-source="desktop"
			data-vnc-status={status}
		>
			<div className="absolute inset-0 h-full w-full" ref={screenRef} />
			{overlay ? (
				<div
					className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-muted-foreground text-xs"
					role="status"
				>
					{overlay}
				</div>
			) : null}
		</section>
	);
}
