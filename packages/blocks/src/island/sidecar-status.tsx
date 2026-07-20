"use client";

// Sidecar status + capture controls for the expanded island. Shows Core/Shadow
// reachability dots, the live recording indicator, a pause/incognito toggle, and
// a "Start Shadow" affordance (Core sidecar start) when Shadow is down.
//
// Presentational view: the live island wraps this and supplies the real sidecar
// snapshot + start/pause handlers.

import { RecordingIndicator } from "./recording-indicator.tsx";

function StatusDot({ up, label }: { label: string; up: boolean }) {
	return (
		<span className="flex items-center gap-1.5 text-neutral-300 text-xs">
			<span
				className={`size-2 rounded-full ${up ? "bg-emerald-400" : "bg-neutral-600"}`}
			/>
			{label}
		</span>
	);
}

export interface SidecarSnapshotView {
	coreUp: boolean;
	paused: boolean;
	recording: boolean;
	shadowUp: boolean;
}

export interface SidecarStatusViewProps {
	/** Whether `contextRead` consent is granted; Shadow is hard-gated on it. */
	contextReadAllowed?: boolean;
	onStartShadow?: () => void;
	onTogglePause?: () => void;
	pausing?: boolean;
	snapshot?: SidecarSnapshotView;
	starting?: boolean;
}

const DEMO_SNAPSHOT: SidecarSnapshotView = {
	coreUp: true,
	shadowUp: true,
	recording: true,
	paused: false,
};

const noop = (): void => {
	// Static-render default; the live island injects the real capture controls.
};

/** Status + capture controls. `contextReadAllowed` gates all Shadow access. */
export function SidecarStatusView({
	contextReadAllowed = true,
	snapshot = DEMO_SNAPSHOT,
	starting = false,
	pausing = false,
	onStartShadow = noop,
	onTogglePause = noop,
}: SidecarStatusViewProps) {
	const showStartShadow =
		contextReadAllowed && snapshot.coreUp && !snapshot.shadowUp;

	return (
		<section className="flex flex-col gap-2 rounded-2xl bg-white/5 p-3">
			<div className="flex items-center justify-between">
				<div className="flex gap-3">
					<StatusDot label="Core" up={snapshot.coreUp} />
					<StatusDot label="Shadow" up={snapshot.shadowUp} />
				</div>
				{contextReadAllowed ? (
					<RecordingIndicator
						paused={snapshot.paused}
						recording={snapshot.recording}
					/>
				) : (
					<span className="text-[11px] text-neutral-500">Capture off</span>
				)}
			</div>

			{showStartShadow ? (
				<button
					className="rounded-full bg-white/10 px-3 py-1 font-medium text-neutral-100 text-xs hover:bg-white/20 disabled:opacity-50"
					disabled={starting}
					onClick={onStartShadow}
					type="button"
				>
					{starting ? "Starting Shadow…" : "Start Shadow"}
				</button>
			) : null}

			{contextReadAllowed && snapshot.shadowUp ? (
				<button
					className="rounded-full bg-white/10 px-3 py-1 font-medium text-neutral-100 text-xs hover:bg-white/20 disabled:opacity-50"
					disabled={pausing}
					onClick={onTogglePause}
					type="button"
				>
					{snapshot.paused ? "Resume capture" : "Pause capture (incognito)"}
				</button>
			) : null}
		</section>
	);
}
