import { PatchDiff } from "@pierre/diffs/react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { useEffect, useLayoutEffect } from "react";
import { FileTypeIcon } from "./file-type-icon.tsx";
import type {
	AttachedFile,
	AttachedImage,
	InputBarTurnProgress,
	InputConfig,
} from "./input-bar-types.ts";

/**
 * Bars in the full-width recording waveform that replaces the textarea while the
 * mic is live. High enough to read as a dense, ChatGPT-style waveform spanning
 * the whole input; the recorder keeps a longer amplitude history to feed these.
 */
export const RECORDING_WAVE_BARS = 48;

/**
 * Measure the textarea at the compact row's stable width. Measuring a detached
 * clone avoids a layout feedback loop: once the real editor moves into the wider
 * full layout, its own `scrollHeight` can fall back to one line and otherwise
 * make the composer bounce between layouts.
 */
export function textareaWrapsAtWidth(
	textarea: HTMLTextAreaElement,
	value: string,
	width: number
): boolean {
	if (!(value && width > 0)) {
		return false;
	}
	const probe = textarea.cloneNode(false);
	if (!(probe instanceof HTMLTextAreaElement)) {
		return value.includes("\n");
	}
	probe.removeAttribute("id");
	probe.removeAttribute("name");
	probe.setAttribute("aria-hidden", "true");
	probe.tabIndex = -1;
	probe.style.position = "fixed";
	probe.style.top = "0";
	probe.style.left = "-10000px";
	probe.style.width = `${width}px`;
	probe.style.height = "0";
	probe.style.minHeight = "0";
	probe.style.maxHeight = "none";
	probe.style.overflow = "hidden";
	probe.style.pointerEvents = "none";
	probe.style.visibility = "hidden";
	probe.value = "";
	document.body.append(probe);
	try {
		const singleLineHeight = probe.scrollHeight;
		probe.value = value;
		return probe.scrollHeight > singleLineHeight + 1;
	} finally {
		probe.remove();
	}
}

export const DEFAULT_INPUT_CONFIG: InputConfig = {
	inputBarPlaceholder: "What do you want to do?",
	attachmentPreviewStyle: "thumbnail",
};

/** Stable fallback so the voice hook can be called unconditionally. */
export const noopTranscribe = async (): Promise<string> => "";

/** Stable empty lists so attachment-derived memos don't churn every render. */
export const NO_ATTACHED_IMAGES: AttachedImage[] = [];

export const NO_ATTACHED_FILES: AttachedFile[] = [];

export const useSafeLayoutEffect =
	globalThis.window === undefined ? useEffect : useLayoutEffect;

export function TurnProgressFile({
	file,
}: {
	file: InputBarTurnProgress["files"][number];
}) {
	const row = (
		<button
			className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-muted"
			type="button"
		>
			<FileTypeIcon className="size-4 shrink-0" path={file.path} />
			<span className="min-w-0 flex-1 truncate" title={file.path}>
				{file.path}
			</span>
			<span className="text-status-success tabular-nums">
				+{formatNumber(file.insertions)}
			</span>
			<span className="text-status-destructive tabular-nums">
				−{formatNumber(file.deletions)}
			</span>
		</button>
	);
	if (!file.preview) {
		return row;
	}
	return (
		<HoverCard>
			<HoverCardTrigger closeDelay={120} delay={160} render={row} />
			<HoverCardContent
				align="start"
				appearance="composer-preview"
				className="w-[min(42rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden"
				side="top"
				sideOffset={8}
			>
				<div className="mb-1 px-2 py-1 font-mono text-muted-foreground text-xs">
					{file.path}
				</div>
				<div className="max-h-[28rem] overflow-auto rounded-xl border border-border bg-background/60">
					<PatchDiff
						disableWorkerPool
						options={{
							diffStyle: "unified",
							lineHoverHighlight: "line",
						}}
						patch={file.preview}
					/>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
