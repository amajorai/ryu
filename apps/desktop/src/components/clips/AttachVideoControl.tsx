// apps/desktop/src/components/clips/AttachVideoControl.tsx
//
// The "Attach video (URL or file)" entry for the composer toolbar, sitting
// alongside RecordingControls (record a clip) and ClipsList (pick a saved clip).
// It ingests an EXTERNAL video - a paste-in URL (yt-dlp on Core) or a picked
// local file - into the exact same agent-context bundle a recorded clip produces,
// then hands that ClipContext to `onIngested` (wired to the composer's
// attachContext), so the result attaches identically: key-moment image frames as
// chips plus a markdown summary that rides the next turn. Ingest is slow
// (download + transcode + keyframe extraction + transcript), so the popover shows
// a spinner and disables submit until it resolves.

import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconAlertTriangle,
	IconFolder,
	IconLoader2,
	IconVideoPlus,
} from "@tabler/icons-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useId, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type ClipContext,
	type ClipDetailMode,
	ingestClip,
} from "@/src/lib/api/clips.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** The selectable detail modes, in ascending frame-density order. `balanced` is
 * the default (scene-detected, capped) - a good ratio of coverage to token cost. */
const DETAIL_OPTIONS: { label: string; value: ClipDetailMode }[] = [
	{ value: "transcript", label: "Transcript only (no frames)" },
	{ value: "efficient", label: "Efficient (~50 frames)" },
	{ value: "balanced", label: "Balanced (scene-detected)" },
	{ value: "tokenBurner", label: "Token burner (every scene)" },
];

const DEFAULT_DETAIL: ClipDetailMode = "balanced";

export interface AttachVideoControlProps {
	className?: string;
	/** Deliver the ingested bundle to the composer (same sink a recorded clip
	 * uses - `attachContext`). */
	onIngested: (context: ClipContext) => void;
}

export function AttachVideoControl({
	className,
	onIngested,
}: AttachVideoControlProps) {
	const node = useNodeStore((s) => s.getActiveNode());
	const urlFieldId = useId();

	const [isOpen, setIsOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [filePath, setFilePath] = useState<string | null>(null);
	const [detail, setDetail] = useState<ClipDetailMode>(DEFAULT_DETAIL);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reset = useCallback(() => {
		setUrl("");
		setFilePath(null);
		setDetail(DEFAULT_DETAIL);
		setError(null);
	}, []);

	const handleChooseFile = useCallback(async () => {
		setError(null);
		const chosen = await open({
			multiple: false,
			filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm"] }],
		});
		if (typeof chosen === "string") {
			setFilePath(chosen);
			// A picked file supersedes a stale URL so `source` is unambiguous.
			setUrl("");
		}
	}, []);

	// The URL takes precedence when present; otherwise fall back to the picked
	// file. Trim so a stray space never becomes a bogus non-empty source.
	const source = url.trim() || filePath || "";

	const handleSubmit = useCallback(() => {
		const resolved = url.trim() || filePath || "";
		if (!resolved || busy) {
			return;
		}
		setBusy(true);
		setError(null);
		ingestClip(toTarget(node), { source: resolved, detail })
			.then((ctx) => {
				onIngested(ctx);
				reset();
				setIsOpen(false);
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : "Failed to ingest video");
			})
			.finally(() => setBusy(false));
	}, [busy, detail, filePath, node, onIngested, reset, url]);

	return (
		<Popover
			onOpenChange={(nextOpen) => {
				// Never let the popover close mid-ingest (the spinner must stay visible).
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
						aria-label="Attach video (URL or file)"
						className={cn("size-7 rounded-full", className)}
						size="icon"
						title="Attach video (URL or file)"
						type="button"
						variant="ghost"
					/>
				}
			>
				<IconVideoPlus className="size-4 text-muted-foreground" />
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 gap-3" sideOffset={6}>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={urlFieldId}>Video URL</Label>
					<Input
						disabled={busy}
						id={urlFieldId}
						onChange={(e) => {
							setUrl(e.target.value);
							if (e.target.value.trim()) {
								setFilePath(null);
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								handleSubmit();
							}
						}}
						placeholder="https://…"
						spellCheck={false}
						value={url}
					/>
				</div>

				<div className="flex items-center gap-2">
					<span className="text-muted-foreground text-xs">or</span>
					<Button
						className="gap-1.5"
						disabled={busy}
						onClick={handleChooseFile}
						size="sm"
						type="button"
						variant="outline"
					>
						<IconFolder className="size-4" />
						Choose file
					</Button>
				</div>
				{filePath ? (
					<p
						className="truncate text-muted-foreground text-xs"
						title={filePath}
					>
						{filePath}
					</p>
				) : null}

				<div className="flex flex-col gap-1.5">
					<Label>Detail</Label>
					<Select
						items={DETAIL_OPTIONS}
						onValueChange={(value) => setDetail(value as ClipDetailMode)}
						value={detail}
					>
						<SelectTrigger className="w-full" disabled={busy}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{DETAIL_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{error ? (
					<p className="flex items-start gap-1.5 text-destructive text-xs">
						<IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
						<span>{error}</span>
					</p>
				) : null}

				<Button
					className="gap-1.5"
					disabled={busy || !source}
					onClick={handleSubmit}
					type="button"
				>
					{busy ? (
						<>
							<IconLoader2 className="size-4 animate-spin" />
							Ingesting…
						</>
					) : (
						"Attach video"
					)}
				</Button>
			</PopoverContent>
		</Popover>
	);
}
