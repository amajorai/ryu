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

import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconAppWindow,
	IconCheck,
	IconChevronDown,
	IconDeviceDesktop,
	IconMicrophone,
	IconPlayerPause,
	IconPlayerPlay,
	IconPlayerStopFilled,
	IconVideo,
	IconVolume,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type ClipCaptureSources,
	type ClipContext,
	type ClipSources,
	type ClipTarget,
	getSources,
} from "@/src/lib/api/clips.ts";
import { useClipStore } from "@/src/store/useClipStore.ts";
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
	icon: typeof IconMicrophone;
	key: keyof ClipCaptureSources;
	label: string;
}[] = [
	{ key: "mic", label: "Microphone", icon: IconMicrophone },
	{ key: "systemAudio", label: "System audio", icon: IconVolume },
];

/** Resolve the label + glyph for the currently-selected video surface. */
function describeTarget(
	target: ClipTarget,
	sources: ClipSources | null
): { Icon: typeof IconDeviceDesktop; label: string } {
	if (target.kind === "display") {
		const display = sources?.displays.find((d) => d.id === target.displayId);
		return { label: display?.label ?? "Display", Icon: IconDeviceDesktop };
	}
	if (target.kind === "window") {
		const win = sources?.windows.find((w) => w.id === target.windowId);
		return { label: win?.title ?? "Window", Icon: IconAppWindow };
	}
	return { label: "Screen", Icon: IconDeviceDesktop };
}

export interface RecordingControlsProps {
	/** Called once a recording is stopped and its context finalized. */
	onClipReady: (context: ClipContext) => void;
}

export function RecordingControls({ onClipReady }: RecordingControlsProps) {
	const node = useNodeStore((s) => s.getActiveNode());
	const target = useMemo(() => toTarget(node), [node]);

	const status = useClipStore((s) => s.status);
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
		getSources(target)
			.then((next) => setAvailable(next))
			.catch(() => setAvailable({ displays: [], windows: [] }));
	};

	const { Icon: TargetIcon, label: targetLabel } = describeTarget(
		captureTarget,
		available
	);

	if (isRecording || isStopping) {
		return (
			<div className="flex items-center gap-1.5">
				<span
					className={cn(
						"inline-flex items-center gap-1.5 font-medium text-xs tabular-nums",
						isPaused ? "text-muted-foreground" : "text-foreground"
					)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							isPaused ? "bg-muted-foreground" : "animate-pulse bg-red-500"
						)}
					/>
					{formatElapsed(elapsedMs)}
				</span>
				<Button
					aria-label={isPaused ? "Resume recording" : "Pause recording"}
					className="size-7 rounded-full"
					disabled={isStopping}
					onClick={handlePauseToggle}
					size="icon"
					type="button"
					variant="ghost"
				>
					{isPaused ? (
						<IconPlayerPlay className="size-4" />
					) : (
						<IconPlayerPause className="size-4" />
					)}
				</Button>
				<Button
					aria-label="Stop recording"
					className="size-7 rounded-full text-red-500"
					disabled={isStopping}
					onClick={handleStop}
					size="icon"
					type="button"
					variant="ghost"
				>
					<IconPlayerStopFilled className="size-4" />
				</Button>
			</div>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<DropdownMenu onOpenChange={loadSources}>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={`Capture source: ${targetLabel}`}
							className="h-7 gap-1 rounded-full px-2 text-muted-foreground"
							size="sm"
							title="Choose what to record"
							type="button"
							variant="ghost"
						/>
					}
				>
					<TargetIcon className="size-4" />
					<span className="max-w-24 truncate text-xs">{targetLabel}</span>
					<IconChevronDown className="size-3" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-56" sideOffset={6}>
					<DropdownMenuItem
						onClick={() => setCaptureTarget({ kind: "screen" })}
					>
						<IconDeviceDesktop className="size-4 shrink-0 text-muted-foreground" />
						<span className="flex-1 truncate">Primary screen</span>
						{captureTarget.kind === "screen" ? (
							<IconCheck className="size-4 shrink-0" />
						) : null}
					</DropdownMenuItem>

					{available && available.displays.length > 0 ? (
						<>
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
										<IconDeviceDesktop className="size-4 shrink-0 text-muted-foreground" />
										<span className="flex-1 truncate">
											{display.label}
											{display.primary ? " (primary)" : ""}
										</span>
										{activeDisplay ? (
											<IconCheck className="size-4 shrink-0" />
										) : null}
									</DropdownMenuItem>
								);
							})}
						</>
					) : null}

					{available && available.windows.length > 0 ? (
						<>
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
										<IconAppWindow className="size-4 shrink-0 text-muted-foreground" />
										<span className="flex-1 truncate">{win.title}</span>
										{activeWindow ? (
											<IconCheck className="size-4 shrink-0" />
										) : null}
									</DropdownMenuItem>
								);
							})}
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>

			{AUDIO_META.map(({ key, label, icon: Icon }) => {
				const active = sources[key];
				return (
					<Button
						aria-label={`${active ? "Disable" : "Enable"} ${label}`}
						aria-pressed={active}
						className={cn(
							"size-7 rounded-full",
							active ? "bg-primary/15 text-primary" : "text-muted-foreground"
						)}
						key={key}
						onClick={() => setSource(key, !active)}
						size="icon"
						title={label}
						type="button"
						variant="ghost"
					>
						<Icon className="size-4" />
					</Button>
				);
			})}
			<Button
				aria-label="Start recording"
				className="size-7 rounded-full"
				onClick={handleStart}
				size="icon"
				title="Start recording"
				type="button"
				variant="ghost"
			>
				<IconVideo className="size-4" />
			</Button>
		</div>
	);
}
