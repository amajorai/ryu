// apps/desktop/src/components/clips/AttachRecentActivityControl.tsx
//
// The "Attach recent activity" entry for the composer toolbar, sitting alongside
// RecordingControls (record a clip), ClipsList (pick a saved clip), and
// AttachVideoControl (ingest an external video). It pulls the last N minutes of
// ambient screen activity from Shadow's timeline keyframes (via Core's
// `/api/clips/recent-activity` proxy) and stages it as a chat attachment: the
// even-subsampled frames become image chips and the markdown summary rides the
// next turn, both handed to the SAME `onAttach` sink a recorded clip uses.
//
// Unlike a clip, this is FULLY EPHEMERAL: nothing is saved to the Clips space and
// the frames already carry inline data URLs (no per-frame fetch), so there is no
// persistence or clip-id involved. It is a "what was I just doing" context grab.

import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconAlertTriangle,
	IconHistory,
	IconLoader2,
} from "@tabler/icons-react";
import { useCallback, useId, useState } from "react";
import type { ComposerSendFile } from "@/src/components/assistant/useComposerSlot.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import { fetchRecentActivity } from "@/src/lib/api/clips.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Default window to grab, in minutes. Core also clamps 1..=15 server-side, so
 * the input constraint here is belt-and-suspenders, not the source of truth. */
const DEFAULT_MINUTES = 3;
const MIN_MINUTES = 1;
const MAX_MINUTES = 15;

/** Keep the requested window inside the contract's 1..=15 range. */
function clampMinutes(value: number): number {
	if (Number.isNaN(value)) {
		return DEFAULT_MINUTES;
	}
	return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(value)));
}

export interface AttachRecentActivityControlProps {
	className?: string;
	/** Same sink a recorded clip uses (attachClip): summary text + image frames. */
	onAttach: (text: string, frames: ComposerSendFile[]) => void;
}

export function AttachRecentActivityControl({
	className,
	onAttach,
}: AttachRecentActivityControlProps) {
	const node = useNodeStore((s) => s.getActiveNode());
	const minutesFieldId = useId();

	const [isOpen, setIsOpen] = useState(false);
	const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = useCallback(() => {
		if (busy) {
			return;
		}
		const requested = clampMinutes(minutes);
		setBusy(true);
		setError(null);
		fetchRecentActivity(toTarget(node), requested)
			.then((bundle) => {
				const frames: ComposerSendFile[] = bundle.frames.map((frame) => ({
					type: "file",
					filename: `activity-frame-${frame.atMs}.jpg`,
					mediaType: "image/jpeg",
					url: frame.dataUrl,
				}));
				if (frames.length === 0 && !bundle.summary.trim()) {
					setError("No recent activity was captured.");
					return;
				}
				onAttach(bundle.summary, frames);
				setMinutes(DEFAULT_MINUTES);
				setError(null);
				setIsOpen(false);
			})
			.catch((err: unknown) => {
				setError(
					err instanceof Error
						? err.message
						: "Failed to attach recent activity"
				);
			})
			.finally(() => setBusy(false));
	}, [busy, minutes, node, onAttach]);

	return (
		<Popover
			onOpenChange={(nextOpen) => {
				// Never let the popover close mid-fetch (the spinner must stay visible).
				if (busy && !nextOpen) {
					return;
				}
				setIsOpen(nextOpen);
			}}
			open={isOpen}
		>
			<PopoverTrigger
				render={
					<Button
						aria-label="Attach recent activity"
						className={cn("size-7 rounded-full", className)}
						size="icon"
						title="Attach recent activity"
						type="button"
						variant="ghost"
					/>
				}
			>
				<IconHistory className="size-4 text-muted-foreground" />
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 gap-3" sideOffset={6}>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={minutesFieldId}>Minutes to attach</Label>
					<Input
						disabled={busy}
						id={minutesFieldId}
						max={MAX_MINUTES}
						min={MIN_MINUTES}
						onChange={(e) => setMinutes(Number(e.target.value))}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								handleSubmit();
							}
						}}
						type="number"
						value={minutes}
					/>
					<p className="text-muted-foreground text-xs">
						Grabs the last {clampMinutes(minutes)} min of screen activity as
						ephemeral context (nothing is saved). Max {MAX_MINUTES}.
					</p>
				</div>

				{error ? (
					<p className="flex items-start gap-1.5 text-destructive text-xs">
						<IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
						<span>{error}</span>
					</p>
				) : null}

				<Button
					className="gap-1.5"
					disabled={busy}
					onClick={handleSubmit}
					type="button"
				>
					{busy ? (
						<>
							<IconLoader2 className="size-4 animate-spin" />
							Gathering…
						</>
					) : (
						"Attach recent activity"
					)}
				</Button>
			</PopoverContent>
		</Popover>
	);
}
