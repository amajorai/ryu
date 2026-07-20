// apps/desktop/src/components/clips/ClipsList.tsx
//
// The clip picker for the composer toolbar: a Base UI dropdown listing the
// recordings on the active node. Picking one hands its id to `onPick`, which the
// composer controls turn into a chat attachment (context summary + key frames).

import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { IconMovie } from "@tabler/icons-react";
import { useMemo } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import { useClipStore } from "@/src/store/useClipStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Format a millisecond duration compactly (e.g. `1:04` or `0:12`). */
function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export interface ClipsListProps {
	/** Called with the chosen clip id. */
	onPick: (clipId: string) => void;
}

export function ClipsList({ onPick }: ClipsListProps) {
	const node = useNodeStore((s) => s.getActiveNode());
	const target = useMemo(() => toTarget(node), [node]);
	const clips = useClipStore((s) => s.clips);
	const refresh = useClipStore((s) => s.refresh);

	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (open) {
					refresh(target);
				}
			}}
		>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="Attach recording"
						className="size-7 rounded-full"
						size="icon"
						title="Attach recording"
						type="button"
						variant="ghost"
					/>
				}
			>
				<IconMovie className="size-4 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-56" sideOffset={6}>
				{clips.length === 0 ? (
					<DropdownMenuItem disabled>No recordings yet</DropdownMenuItem>
				) : (
					clips.map((clip) => (
						<DropdownMenuItem key={clip.id} onClick={() => onPick(clip.id)}>
							<span className="flex min-w-0 flex-1 items-center gap-2">
								<IconMovie className="size-4 shrink-0 text-muted-foreground" />
								<span className="truncate">
									{clip.title || "Untitled clip"}
								</span>
							</span>
							<span className="ml-2 shrink-0 text-muted-foreground text-xs tabular-nums">
								{formatDuration(clip.durationMs)}
							</span>
						</DropdownMenuItem>
					))
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
