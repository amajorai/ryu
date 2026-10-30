import type { ReactNode } from "react";

// ── ContextPill ───────────────────────────────────────────────────────────

export interface ContextPillProps {
	activeApp: string | null | undefined;
	capturePaused: boolean;
	contextReadEnabled: boolean;
	loading: boolean;
	onOpenSettings: () => void;
	overflow: boolean;
	selectedText: string | undefined;
	unavailable: boolean;
}

/** Renders the context pill content based on the current consent and capture state. */
export function ContextPill({
	contextReadEnabled,
	capturePaused,
	loading,
	unavailable,
	activeApp,
	selectedText,
	overflow,
	onOpenSettings,
}: ContextPillProps): ReactNode {
	if (!contextReadEnabled) {
		return (
			<span className="text-muted-foreground">
				Context read is disabled. Enable it in{" "}
				<button
					className="underline hover:text-foreground"
					onClick={onOpenSettings}
					type="button"
				>
					Settings
				</button>
				.
			</span>
		);
	}
	if (capturePaused) {
		return (
			<span className="text-muted-foreground">
				Capture is paused — resume in{" "}
				<button
					className="underline hover:text-foreground"
					onClick={onOpenSettings}
					type="button"
				>
					Settings
				</button>
				.
			</span>
		);
	}
	if (loading) {
		return (
			<span className="animate-skeleton text-muted-foreground">
				Capturing context…
			</span>
		);
	}
	if (unavailable) {
		return (
			<span className="text-muted-foreground">
				Context unavailable — Shadow is not running. Proceeding without screen
				context.
			</span>
		);
	}
	if (activeApp) {
		return (
			<span className="text-muted-foreground">
				<span className="font-medium text-foreground">{activeApp}</span>
				{selectedText ? ` · "${selectedText}${overflow ? "…" : ""}"` : ""}
			</span>
		);
	}
	return (
		<span className="text-muted-foreground">
			Ready — trigger an action to capture context.
		</span>
	);
}

// ── RecordingIndicator ────────────────────────────────────────────────────

/** Always-visible recording indicator — AC3: reflects capture state. */
export function RecordingIndicator({
	paused,
	enabled,
}: {
	paused: boolean;
	enabled: boolean;
}) {
	return (
		<div
			aria-live="polite"
			className="flex items-center gap-2 text-detail text-muted-foreground"
		>
			<span
				aria-hidden
				className={`size-1.5 rounded-full ${paused || !enabled ? "bg-warning" : "bg-success"}`}
			/>
			{enabled ? (paused ? "Capture paused" : "Capturing") : "Capture disabled"}
		</div>
	);
}
