import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImageLightbox } from "@ryu/blocks/desktop/agent-elements/image-lightbox.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { z } from "zod";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	clearMediaSource,
	getMediaSourceSnapshot,
	MEDIA_RECORDING_EVENT,
	type MediaSource,
	mediaRecordingSource,
	publishMediaSource,
	requestMediaSource,
	subscribeMediaSource,
} from "@/src/lib/media-pip.ts";
import { invokeWhenReady, isTauriReady } from "@/src/lib/tauri-ready.ts";

function useMediaSource(): MediaSource | null {
	return useSyncExternalStore(
		subscribeMediaSource,
		getMediaSourceSnapshot,
		getMediaSourceSnapshot
	);
}

function sourceKindLabel(source: MediaSource): string {
	if (source.kind === "desktop") {
		return "Remote desktop";
	}
	if (source.kind === "recording") {
		return "Evidence recording";
	}
	if (source.kind === "agent-browser") {
		return "Agent Browser";
	}
	return "Browser tab";
}

interface LiveMediaLightboxProps {
	onClose: () => void;
	open: boolean;
	originRef: React.RefObject<HTMLElement | null>;
	source: MediaSource;
}

/** Video counterpart to ImageLightbox: same origin thumbnail, but keeps a
 * recording playable instead of flattening it to a poster frame. */
function LiveMediaLightbox({
	onClose,
	open,
	originRef,
	source,
}: LiveMediaLightboxProps) {
	const tl = useLiteralMessages();
	const reduced = useReducedMotion();
	const [mounted, setMounted] = useState(false);
	const [origin, setOrigin] = useState<DOMRect | null>(null);

	useEffect(() => setMounted(true), []);
	useLayoutEffect(() => {
		if (open) {
			setOrigin(originRef.current?.getBoundingClientRect() ?? null);
		}
	}, [open, originRef]);

	if (!mounted || globalThis.document === undefined) {
		return null;
	}
	const safeVideoUrl = safeMediaUrl(source.videoUrl);
	const safePosterUrl = safeMediaUrl(source.posterUrl);
	if (!safeVideoUrl) {
		return null;
	}

	const initial = origin
		? {
				x: origin.left + origin.width / 2 - window.innerWidth / 2,
				y: origin.top + origin.height / 2 - window.innerHeight / 2,
				scale: Math.max(
					0.08,
					origin.width / Math.min(window.innerWidth - 32, 960)
				),
				opacity: 1,
			}
		: { opacity: 0, scale: 0.96 };

	return (
		<Dialog
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent
				appearance="media-lightbox"
				aria-describedby={undefined}
				data-media-lightbox="true"
				data-media-lightbox-kind="recording"
				finalFocus={originRef}
				mobileFullPage
				showCloseButton={false}
			>
				<DialogTitle className="sr-only">
					{tl("{title} fullscreen", { title: source.title })}
				</DialogTitle>
				<motion.div
					animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
					className="relative flex max-h-full max-w-full items-center justify-center overflow-hidden"
					initial={reduced ? false : initial}
					transition={
						reduced
							? { duration: 0 }
							: { damping: 28, stiffness: 190, type: "spring" }
					}
				>
					<video
						aria-label={source.title}
						autoPlay
						className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] object-contain sm:max-h-[calc(100vh-6rem)] sm:max-w-[calc(100vw-6rem)]"
						controls
						playsInline
						poster={safePosterUrl ?? undefined}
						src={safeVideoUrl}
					/>
					<Button
						aria-label="Close fullscreen media"
						className="absolute top-3 right-3"
						onClick={onClose}
						size="icon"
						type="button"
						variant="secondary"
					>
						<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					</Button>
				</motion.div>
			</DialogContent>
		</Dialog>
	);
}

export function MediaPipDock() {
	const { canUseNativeShell } = useAppSurface();
	const source = useMediaSource();
	const [lightboxOpen, setLightboxOpen] = useState(false);
	const [pipError, setPipError] = useState<string | null>(null);
	const originRef = useRef<HTMLButtonElement>(null);
	const tl = useLiteralMessages();

	useAgentBrowserStream();

	useEffect(() => {
		const onRecording = (event: Event) => {
			if (!(event instanceof CustomEvent)) {
				return;
			}
			const next = mediaRecordingSource(event.detail);
			if (next) {
				publishMediaSource(next);
			}
		};
		window.addEventListener(MEDIA_RECORDING_EVENT, onRecording);
		return () => window.removeEventListener(MEDIA_RECORDING_EVENT, onRecording);
	}, []);

	useEffect(() => {
		setLightboxOpen(false);
	}, [source?.id]);

	const openPip = async () => {
		setPipError(null);
		try {
			await invokeWhenReady("open_media_pip");
			window.setTimeout(requestMediaSource, 80);
		} catch (error) {
			setPipError(
				error instanceof Error ? error.message : "PiP is unavailable"
			);
		}
	};

	if (!source) {
		return null;
	}

	const imageUrl = safeMediaUrl(source.imageUrl ?? source.posterUrl);
	const videoUrl = safeMediaUrl(source.videoUrl);
	const posterUrl = safeMediaUrl(source.posterUrl);
	const isVideo = Boolean(videoUrl);
	const previewLabel = tl("{title} live preview", { title: source.title });

	return (
		<>
			<AnimatePresence>
				<motion.section
					animate={{ opacity: 1, y: 0 }}
					aria-label="Live media"
					className="fixed right-4 bottom-4 z-[70] w-64 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
					data-media-pip-dock="true"
					exit={{ opacity: 0, y: 18 }}
					initial={{ opacity: 0, y: 18 }}
				>
					<button
						aria-label={tl("Expand {previewLabel}", { previewLabel })}
						className="group relative block aspect-video w-full overflow-hidden bg-black/80 text-left"
						data-media-pip-preview="true"
						onClick={() => setLightboxOpen(true)}
						ref={originRef}
						type="button"
					>
						{isVideo ? (
							<video
								aria-label={previewLabel}
								autoPlay
								className="h-full w-full object-cover"
								loop
								muted
								playsInline
								poster={posterUrl ?? undefined}
								src={videoUrl ?? undefined}
							/>
						) : imageUrl ? (
							// live frames are data URLs, not static assets.
							<img
								alt={previewLabel}
								className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
								src={imageUrl}
							/>
						) : (
							<div className="flex h-full items-center justify-center text-muted-foreground text-xs">
								Waiting for media…
							</div>
						)}
						<div className="scrim-t pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-3 pt-4 pb-2 text-white">
							<span
								className="truncate text-xs"
								title={sourceKindLabel(source)}
							>
								{sourceKindLabel(source)}
							</span>
							<span className="size-1.5 shrink-0 rounded-full bg-status-success" />
						</div>
					</button>
					<div className="flex items-center gap-2 px-3 py-2.5">
						<div className="min-w-0 flex-1">
							<p
								className="truncate font-medium text-foreground text-xs"
								title={source.title}
							>
								{source.title}
							</p>
							<p className="truncate text-muted-foreground text-xs">
								{isVideo
									? "Recording is ready"
									: source.kind === "recording"
										? "Latest captured frame"
										: "Following the active tab"}
							</p>
						</div>
						{canUseNativeShell ? (
							<Button
								data-media-pip-open="true"
								onClick={openPip}
								size="dense"
								typography="caption"
								variant="secondary"
							>
								Open PiP
							</Button>
						) : null}
					</div>
					{pipError && (
						<p className="px-3 pb-2 text-status-destructive text-xs">
							{pipError}
						</p>
					)}
				</motion.section>
			</AnimatePresence>
			{imageUrl && !isVideo && (
				<ImageLightbox
					images={[{ id: source.id, filename: source.title, url: imageUrl }]}
					onClose={() => setLightboxOpen(false)}
					open={lightboxOpen}
					originRef={originRef}
				/>
			)}
			{isVideo && (
				<LiveMediaLightbox
					onClose={() => setLightboxOpen(false)}
					open={lightboxOpen}
					originRef={originRef}
					source={source}
				/>
			)}
		</>
	);
}

// Mirrors the serialized AgentBrowserStreamStatus command result: native bools and an optional u16 port.
const agentBrowserStreamStatusSchema = z.object({
	connected: z.boolean(),
	enabled: z.boolean(),
	port: z.number().int().min(0).max(65_535).nullable(),
	screencasting: z.boolean(),
});

const agentBrowserFrameSchema = z.object({
	type: z.literal("frame"),
	data: z.string(),
});

/** Bridges the documented Agent Browser localhost stream into the same media
 * source used by the Browser and Virtual Desktop dock panels. It is fail-soft:
 * a normal desktop with no Agent Browser process simply has no extra source. */
function useAgentBrowserStream(): void {
	const socketRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		if (!isTauriReady()) {
			return;
		}
		let disposed = false;

		const connect = async () => {
			if (disposed || socketRef.current) {
				return;
			}
			const status = await invokeWhenReady("agent_browser_stream_status")
				.then((value) => agentBrowserStreamStatusSchema.parse(value))
				.catch(() => null);
			if (disposed || !status?.enabled || !status.port) {
				return;
			}
			const socket = new WebSocket(`ws://127.0.0.1:${status.port}`);
			socketRef.current = socket;
			socket.addEventListener("open", () => {
				socket.send(JSON.stringify({ maxFps: 8, type: "config" }));
			});
			socket.addEventListener("message", (event) => {
				try {
					const decoded = agentBrowserFrameSchema.safeParse(
						JSON.parse(String(event.data))
					);
					if (!decoded.success) {
						return;
					}
					const current = getMediaSourceSnapshot();
					if (
						current &&
						(current.kind === "browser" || current.kind === "desktop") &&
						Date.now() - current.updatedAt < 2000
					) {
						return;
					}
					publishMediaSource({
						id: "agent-browser:active",
						imageUrl: `data:image/jpeg;base64,${decoded.data.data}`,
						kind: "agent-browser",
						title: "Agent Browser",
					});
				} catch {
					// Ignore malformed frames; the next stream frame remains usable.
				}
			});
			const clearSocket = () => {
				if (socketRef.current === socket) {
					socketRef.current = null;
				}
			};
			socket.addEventListener("close", clearSocket);
			socket.addEventListener("error", clearSocket);
		};

		connect().catch(() => undefined);
		const timer = window.setInterval(() => {
			connect().catch(() => undefined);
		}, 5000);
		return () => {
			disposed = true;
			window.clearInterval(timer);
			socketRef.current?.close();
			socketRef.current = null;
			clearMediaSource("agent-browser:active");
		};
	}, []);
}

export function MediaPipWindow() {
	const source = useMediaSource();

	useEffect(() => {
		requestMediaSource();
	}, []);

	const close = () => {
		invokeWhenReady("close_media_pip").catch(() => undefined);
	};
	const videoUrl = safeMediaUrl(source?.videoUrl);
	const posterUrl = safeMediaUrl(source?.posterUrl);
	const imageUrl = safeMediaUrl(source?.imageUrl);
	const sourceTitle = source?.title ?? "Live media";

	return (
		<div
			className="flex h-screen min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
			data-media-pip-window="true"
		>
			<header
				className="flex h-9 shrink-0 items-center gap-2 border-border border-b bg-sidebar/90 px-3"
				data-tauri-drag-region
			>
				<span className="size-1.5 rounded-full bg-status-success" />
				<span className="min-w-0 flex-1 truncate font-medium text-xs">
					{source?.title ?? "Live media"}
				</span>
				<button
					aria-label="Close picture in picture"
					className="grid size-6 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
					onClick={close}
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
				</button>
			</header>
			<div
				className={cn(
					"relative min-h-0 flex-1 bg-black",
					!source && "grid place-items-center p-5"
				)}
			>
				{videoUrl ? (
					<video
						aria-label={sourceTitle}
						autoPlay
						className="h-full w-full object-contain"
						controls
						loop
						muted
						playsInline
						poster={posterUrl ?? undefined}
						src={videoUrl}
					/>
				) : imageUrl ? (
					// live frame data URLs are not static assets.
					<img
						alt={sourceTitle}
						className="h-full w-full object-contain"
						src={imageUrl}
					/>
				) : (
					<p className="text-center text-muted-foreground text-xs">
						Waiting for a browser, desktop, or evidence source…
					</p>
				)}
			</div>
		</div>
	);
}
