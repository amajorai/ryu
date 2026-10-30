// apps/desktop/src/components/clips/RecordingControls.tsx
//
// The record bar for Ryu Clips: a video-source picker (screen / display / window)
// plus mic + system-audio toggles, then Start; and once rolling, a live mm:ss
// elapsed timer with real Pause / Resume and Stop. The 1s timer is owned here (a
// `useEffect` interval calling the store's `tick`) - the store never holds a
// timer. Pause/Resume hit the backend (which excludes the paused span from the
// clip duration) so on resume the elapsed tracks backend duration, not local wall
// clock over the pause. On Stop the finalized `ClipContext` is handed back via
// `onClipReady` so the composer can turn it into an attachment.

import {
	ArrowDown01Icon,
	BrowserIcon,
	ComputerIcon,
	Mic01Icon,
	PauseIcon,
	PlayIcon,
	StopIcon,
	Tick02Icon,
	Video01Icon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type ClipCaptureSources,
	type ClipContext,
	type ClipSources,
	type ClipTarget,
	getSources,
} from "@/src/lib/api/clips.ts";
import { recordingScope, useClipStore } from "@/src/store/useClipStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Format a millisecond duration as `mm:ss`. */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const mm = minutes.toString().padStart(2, "0");
	const ss = seconds.toString().padStart(2, "0");
	return `${mm}:${ss}`;
}

/** One glyph for each audio input toggle, in display order. */
const AUDIO_META: {
	icon: IconSvgElement;
	key: keyof ClipCaptureSources;
	label: string;
}[] = [
	{ key: "mic", label: "Microphone", icon: Mic01Icon },
	{ key: "systemAudio", label: "System audio", icon: VolumeHighIcon },
];

/** Resolve the label + glyph for the currently-selected video surface. */
function describeTarget(target: ClipTarget, sources: ClipSources | null) {
	if (target.kind === "display") {
		const display = sources?.displays.find((d) => d.id === target.displayId);
		return { label: display?.label ?? "Display", Icon: ComputerIcon };
	}
	if (target.kind === "window") {
		const win = sources?.windows.find((w) => w.id === target.windowId);
		return { label: win?.title ?? "Window", Icon: BrowserIcon };
	}
	return { label: "Screen", Icon: ComputerIcon };
}

export interface RecordingControlsProps {
	/** Called once a recording is stopped and its context finalized. */
	onClipReady: (context: ClipContext) => void;
}

export function RecordingControls({ onClipReady }: RecordingControlsProps) {
	const tl = useLiteralMessages();
	const node = useNodeStore((s) => s.getActiveNode());
	const target = useMemo(() => toTarget(node), [node]);
	const targetScope = recordingScope(target);
	const currentTargetScope = useRef(targetScope);
	currentTargetScope.current = targetScope;
	const sourceRequestId = useRef(0);

	const abandonRecording = useClipStore((s) => s.abandonRecording);
	const syncSessionTarget = useClipStore((s) => s.syncSessionTarget);
	useEffect(() => {
		// Recording state lives in the store and outlives this component (the
		// assistant panel unmounts it when closed). A remount, a new node object,
		// or a rotated managed-node delegation for the same identity must keep
		// Stop reachable; only a recording from another scope is abandoned, and
		// the store stops it on the node that owns it - including when the scope
		// moved while this component was unmounted.
		const { sessionScope, status } = useClipStore.getState();
		if (status !== "idle" && sessionScope !== targetScope) {
			abandonRecording();
		}
		setAvailable(null);
		setSourcesError(null);
		setSourcesLoading(false);
		return () => {
			// Invalidate completion handlers on target changes and unmount.
			sourceRequestId.current += 1;
		};
	}, [targetScope, abandonRecording]);
	// Declared after the scope check so a changed scope is abandoned first; a
	// same-scope target (fresh delegation) becomes the recording's stop target.
	useEffect(() => {
		syncSessionTarget(target);
	}, [target, syncSessionTarget]);

	const status = useClipStore((s) => s.status);
	const error = useClipStore((s) => s.error);
	const pendingAction = useClipStore((s) => s.pendingAction);
	const elapsedMs = useClipStore((s) => s.elapsedMs);
	const isPaused = useClipStore((s) => s.isPaused);
	const sources = useClipStore((s) => s.sources);
	const captureTarget = useClipStore((s) => s.captureTarget);
	const setSource = useClipStore((s) => s.setSource);
	const setCaptureTarget = useClipStore((s) => s.setCaptureTarget);
	const start = useClipStore((s) => s.start);
	const stop = useClipStore((s) => s.stop);
	const pause = useClipStore((s) => s.pause);
	const resume = useClipStore((s) => s.resume);
	const tick = useClipStore((s) => s.tick);

	// Enumerated capture surfaces, fetched lazily when the picker opens.
	const [available, setAvailable] = useState<ClipSources | null>(null);

	const [sourcesError, setSourcesError] = useState<string | null>(null);
	const [sourcesLoading, setSourcesLoading] = useState(false);
	const isStarting = status === "starting";
	const isRecording = status === "recording";
	const isStopping = status === "stopping";

	// The component owns the 1s tick so it is torn down with the component; the
	// store stays timer-free. Skipped while idle or paused (backend holds capture).
	useEffect(() => {
		if (!isRecording || isPaused) {
			return;
		}
		const interval = setInterval(() => tick(), 1000);
		return () => clearInterval(interval);
	}, [isRecording, isPaused, tick]);

	const handleStart = () => {
		start(target);
	};

	const handleStop = () => {
		stop(target).then((context) => {
			if (context) {
				onClipReady(context);
			}
		});
	};

	const handlePauseToggle = () => {
		if (isPaused) {
			resume(target);
		} else {
			pause(target);
		}
	};

	const loadSources = (open: boolean) => {
		if (!open) {
			return;
		}
		const requestId = ++sourceRequestId.current;
		const requestScope = targetScope;
		const isCurrentRequest = () =>
			requestId === sourceRequestId.current &&
			requestScope === currentTargetScope.current;
		setSourcesLoading(true);
		setSourcesError(null);
		getSources(target)
			.then((next) => {
				if (isCurrentRequest()) {
					setAvailable(next);
				}
			})
			.catch((err) => {
				if (!isCurrentRequest()) {
					return;
				}
				setSourcesError(
					err instanceof Error ? err.message : "Unable to load capture sources"
				);
			})
			.finally(() => {
				if (isCurrentRequest()) {
					setSourcesLoading(false);
				}
			});
	};

	const { Icon: TargetIcon, label: targetLabel } = describeTarget(
		captureTarget,
		available
	);

	if (isRecording || isStopping) {
		return (
			<div className="flex flex-wrap items-center gap-1.5">
				{error ? (
					<span className="text-status-destructive text-xs" role="alert">
						{error}
					</span>
				) : null}
				<span
					className={cn(
						"inline-flex items-center gap-1.5 font-medium text-xs tabular-nums",
						isPaused ? "text-muted-foreground" : "text-foreground"
					)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							isPaused
								? "bg-muted-foreground"
								: "bg-destructive motion-safe:animate-pulse"
						)}
					/>
					{formatElapsed(elapsedMs)}
				</span>
				<Button
					aria-label={isPaused ? "Resume recording" : "Pause recording"}
					className="size-7"
					disabled={isStopping || pendingAction !== null}
					onClick={handlePauseToggle}
					radius="pill"
					size="icon"
					type="button"
					variant="ghost"
				>
					{isPaused ? (
						<HugeiconsIcon className="size-4" icon={PlayIcon} />
					) : (
						<HugeiconsIcon className="size-4" icon={PauseIcon} />
					)}
				</Button>
				<Button
					appearance="dictation-recording"
					aria-label="Stop recording"
					className="size-7"
					disabled={isStopping || pendingAction !== null}
					onClick={handleStop}
					radius="pill"
					size="icon"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={StopIcon} />
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-1">
			{error ? (
				<span className="text-status-destructive text-xs" role="alert">
					{error}
				</span>
			) : null}
			<DropdownMenu onOpenChange={loadSources}>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={tl("Capture source: {targetLabel}", { targetLabel })}
							className="h-7"
							disabled={isStarting}
							radius="pill"
							size="sm"
							title="Choose what to record"
							type="button"
							variant="ghost-muted"
						/>
					}
				>
					<HugeiconsIcon className="size-4" icon={TargetIcon} />
					<span className="max-w-24 truncate text-xs">{targetLabel}</span>
					<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-56" sideOffset={6}>
					{sourcesLoading ? (
						<div className="px-2 py-1 text-muted-foreground text-xs">
							Loading capture sources…
						</div>
					) : null}
					{sourcesError ? (
						<div
							className="px-2 py-1 text-status-destructive text-xs"
							role="alert"
						>
							{tl("{sourcesError}. Close and reopen to retry.", {
								sourcesError,
							})}
						</div>
					) : null}
					<DropdownMenuItem
						onClick={() => setCaptureTarget({ kind: "screen" })}
					>
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={ComputerIcon}
						/>
						<span className="flex-1 truncate">Primary screen</span>
						{captureTarget.kind === "screen" ? (
							<HugeiconsIcon className="size-4 shrink-0" icon={Tick02Icon} />
						) : null}
					</DropdownMenuItem>

					{available && available.displays.length > 0 ? (
						<DropdownMenuGroup>
							<DropdownMenuSeparator />
							<DropdownMenuLabel>Displays</DropdownMenuLabel>
							{available.displays.map((display) => {
								const activeDisplay =
									captureTarget.kind === "display" &&
									captureTarget.displayId === display.id;
								return (
									<DropdownMenuItem
										key={display.id}
										onClick={() =>
											setCaptureTarget({
												kind: "display",
												displayId: display.id,
											})
										}
									>
										<HugeiconsIcon
											className="size-4 shrink-0 text-muted-foreground"
											icon={ComputerIcon}
										/>
										<span className="flex-1 truncate">
											{display.label}
											{display.primary ? " (primary)" : ""}
										</span>
										{activeDisplay ? (
											<HugeiconsIcon
												className="size-4 shrink-0"
												icon={Tick02Icon}
											/>
										) : null}
									</DropdownMenuItem>
								);
							})}
						</DropdownMenuGroup>
					) : null}

					{available && available.windows.length > 0 ? (
						<DropdownMenuGroup>
							<DropdownMenuSeparator />
							<DropdownMenuLabel>Windows</DropdownMenuLabel>
							{available.windows.map((win) => {
								const activeWindow =
									captureTarget.kind === "window" &&
									captureTarget.windowId === win.id;
								return (
									<DropdownMenuItem
										key={win.id}
										onClick={() =>
											setCaptureTarget({ kind: "window", windowId: win.id })
										}
									>
										<HugeiconsIcon
											className="size-4 shrink-0 text-muted-foreground"
											icon={BrowserIcon}
										/>
										<span className="flex-1 truncate" title={win.title}>
											{win.title}
										</span>
										{activeWindow ? (
											<HugeiconsIcon
												className="size-4 shrink-0"
												icon={Tick02Icon}
											/>
										) : null}
									</DropdownMenuItem>
								);
							})}
						</DropdownMenuGroup>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>

			{AUDIO_META.map(({ key, label, icon: Icon }) => {
				const active = sources[key];
				return (
					<Button
						aria-label={`${active ? "Disable" : "Enable"} ${label}`}
						aria-pressed={active}
						className="size-7"
						disabled={isStarting}
						key={key}
						onClick={() => setSource(key, !active)}
						radius="pill"
						size="icon"
						title={label}
						type="button"
						variant={active ? "secondary" : "ghost-muted"}
					>
						<HugeiconsIcon className="size-4" icon={Icon} />
					</Button>
				);
			})}
			<Button
				aria-label={isStarting ? "Starting recording" : "Start recording"}
				className="size-7"
				disabled={isStarting}
				onClick={handleStart}
				radius="pill"
				size="icon"
				title="Start recording"
				type="button"
				variant="ghost"
			>
				<HugeiconsIcon className="size-4" icon={Video01Icon} />
			</Button>
		</div>
	);
}
