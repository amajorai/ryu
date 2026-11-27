// The transcript file card: a file the agent created or attached, with its
// type icon, name, type badge and size, an optional inline preview, and the
// Download and Open buttons.
//
// The card owns the download state only. Where the bytes come from
// (`loadBlob`) and what Open does (`onOpen`) are passed in, so the same card
// serves an inline attachment (bytes in the message) and a created Space file
// (bytes behind the node API).

import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { saveBlobAs } from "./file-card-download.ts";
import {
	extensionForMime,
	fileExtension,
	fileTypeBadge,
} from "./file-card-logic.ts";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { formatByteSize } from "./locale-format.ts";

export type FileCardState =
	| "ready"
	| "downloading"
	| "downloaded"
	| "failed"
	| "unavailable";

export interface FileCardProps {
	className?: string;
	/** Fetches the bytes for Download. Absent when the file cannot be reached:
	 *  the card then says so and Download is off. */
	loadBlob?: () => Promise<Blob | null>;
	mime?: string;
	name: string;
	/** Opens the file in an in-app viewer. Absent: no Open button. */
	onOpen?: () => void;
	/** Inline preview drawn between the header row and the buttons. */
	preview?: React.ReactNode;
	/** Hands the bytes to the browser as a download. Tests replace it. */
	save?: (blob: Blob, name: string) => void;
	size?: number;
}

function saveToBrowser(blob: Blob, name: string) {
	saveBlobAs(blob, name);
}

export function FileCard({
	className,
	loadBlob,
	mime,
	name,
	onOpen,
	preview,
	save = saveToBrowser,
	size,
}: FileCardProps) {
	const tl = useLiteralMessages();
	const [progress, setProgress] = useState<
		"ready" | "downloading" | "downloaded" | "failed"
	>("ready");
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const state: FileCardState = loadBlob ? progress : "unavailable";
	const badge = fileTypeBadge(name, mime);
	// The icon is chosen by extension; a name without one borrows the type's.
	const mimeExtension = extensionForMime(mime);
	const iconPath =
		fileExtension(name) || !mimeExtension ? name : `${name}.${mimeExtension}`;

	const download = async () => {
		if (!loadBlob || progress === "downloading") {
			return;
		}
		setProgress("downloading");
		let next: "downloaded" | "failed" = "failed";
		try {
			const blob = await loadBlob();
			if (blob) {
				save(blob, name);
				next = "downloaded";
			}
		} catch {
			next = "failed";
		}
		if (mounted.current) {
			setProgress(next);
		}
	};

	let status: string | null = null;
	if (state === "downloading") {
		status = tl("Downloading…");
	} else if (state === "downloaded") {
		status = tl("Downloaded");
	} else if (state === "failed") {
		status = tl("Could not read this file");
	} else if (state === "unavailable") {
		status = tl("File not found");
	}

	return (
		<div
			className={cn(
				"flex w-full min-w-0 max-w-md flex-col overflow-hidden rounded-xl border border-border bg-background",
				className
			)}
			data-state={state}
			data-testid="file-card"
		>
			<div className="flex min-w-0 items-center gap-3 p-3">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
					<FileTypeIcon className="size-5" path={iconPath} />
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span
						className="truncate font-medium text-foreground text-sm"
						data-ryu-i18n="off"
						data-testid="file-card-name"
						dir="auto"
						title={name}
					>
						{name}
					</span>
					<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
						{badge ? (
							<span
								className="shrink-0"
								data-ryu-i18n="off"
								data-testid="file-card-type"
							>
								{badge}
							</span>
						) : (
							<span className="shrink-0" data-testid="file-card-type">
								{tl("File")}
							</span>
						)}
						{size === undefined ? null : (
							<span
								className="shrink-0 border-border border-s ps-1.5"
								data-testid="file-card-size"
							>
								{formatByteSize(size)}
							</span>
						)}
					</span>
				</div>
			</div>
			{preview}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-border border-t px-2 py-1.5">
				<span
					aria-live="polite"
					className={cn(
						"min-w-0 flex-1 ps-1 text-xs",
						state === "failed"
							? "text-status-destructive"
							: "text-muted-foreground"
					)}
					data-testid="file-card-status"
				>
					{status}
				</span>
				<div className="ms-auto flex shrink-0 items-center gap-1">
					{onOpen ? (
						<Button
							aria-label={tl("Open {filename}", { filename: name })}
							data-testid="file-card-open"
							onClick={onOpen}
							size="sm"
							type="button"
							variant="ghost-muted"
						>
							<span>{tl("Open")}</span>
						</Button>
					) : null}
					<Button
						aria-label={
							state === "failed"
								? undefined
								: tl("Download {filename}", { filename: name })
						}
						data-testid="file-card-download"
						disabled={state === "unavailable" || state === "downloading"}
						onClick={download}
						size="sm"
						type="button"
						variant="ghost-muted"
					>
						<HugeiconsIcon
							aria-hidden
							className="size-4"
							icon={Download01Icon}
						/>
						<span>{state === "failed" ? tl("Retry") : tl("Download")}</span>
					</Button>
				</div>
			</div>
		</div>
	);
}
