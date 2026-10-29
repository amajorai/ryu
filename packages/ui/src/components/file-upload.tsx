"use client";

// packages/ui/src/components/file-upload.tsx
//
// A drag-and-drop upload queue: a dropzone, then one row per file carrying its
// progress, outcome, and the two actions an outcome can need (retry, remove).
//
// ## The queue is CONTROLLED, deliberately
//
// There is no uncontrolled mode and no internal "start the upload" timer. The
// component renders `items` and reports intent (`onFilesAdded`, `onRetry`,
// `onRemove`); whoever owns the transfer owns the state. That split is what keeps
// {@link FileUploadItem.progress} honest — a component that drove its own progress
// could only do it with a timer, and a timer-driven bar is a picture of an upload
// rather than a report on one.
//
// `progress: null` is therefore a first-class value, not a missing number: it means
// "in flight, fraction unknown", and renders as an indeterminate bar. A caller that
// cannot measure its transfer passes null and gets an honest indeterminate state
// instead of a fabricated percentage.

import { Progress } from "@base-ui/react/progress";
import {
	Alert01Icon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	File01Icon,
	RefreshIcon,
	Upload04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type CSSProperties,
	type DragEvent,
	type ReactNode,
	useId,
	useRef,
	useState,
} from "react";

interface UploadProgressStyle extends CSSProperties {
	"--upload-progress": string;
}

/** Where a queued file has got to. `pending` is queued-but-not-started. */
export type FileUploadStatus = "error" | "pending" | "success" | "uploading";

export interface FileUploadItem {
	/** Shown on `status: "error"`; this is what the retry button is offering to
	 *  re-attempt, so it should say what went wrong, not just "failed". */
	error?: string;
	id: string;
	name: string;
	/** A secondary line under the name — used for an outcome the status alone
	 *  cannot express (e.g. "stored, but nothing here can read this format"). */
	note?: ReactNode;
	/** `0`–`1`, or `null` for "in flight, fraction unknown" (indeterminate). */
	progress?: number | null;
	/** Whether an error can be retried unchanged. Omitted keeps Retry available. */
	retryable?: boolean;
	/** Bytes. Omitted renders no size. */
	size?: number;
	status: FileUploadStatus;
}

/** Byte counts as a person reads them. Binary units, one decimal only where it
 *  carries information. */
function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded =
		value >= 10 || Number.isInteger(value) ? Math.round(value) : value;
	return `${Number(rounded.toFixed(1))} ${units[unit]}`;
}

function StatusIcon({ status }: { status: FileUploadStatus }) {
	if (status === "success") {
		return (
			<HugeiconsIcon
				className="size-4 text-status-success"
				icon={CheckmarkCircle02Icon}
			/>
		);
	}
	if (status === "error") {
		return (
			<HugeiconsIcon
				className="size-4 text-status-destructive"
				icon={Alert01Icon}
			/>
		);
	}
	return (
		<HugeiconsIcon className="size-4 text-muted-foreground" icon={File01Icon} />
	);
}

function FileUploadRow({
	item,
	onRemove,
	onRetry,
}: {
	item: FileUploadItem;
	onRemove?: (item: FileUploadItem) => void;
	onRetry?: (item: FileUploadItem) => void;
}) {
	const tl = useLiteralMessages();
	const inFlight = item.status === "uploading";
	// Base UI reads `null` as indeterminate, which is exactly the distinction
	// `progress: null` carries — so it maps straight through rather than being
	// flattened to a 0 that would render as a stalled bar.
	const value =
		item.progress === null || item.progress === undefined
			? null
			: Math.round(item.progress * 100);

	const progressStyle: UploadProgressStyle = {
		"--upload-progress": `${value}%`,
	};
	return (
		<li
			className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2"
			data-status={item.status}
		>
			<StatusIcon status={item.status} />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="truncate font-medium text-foreground text-sm">
						{item.name}
					</span>
					{item.size === undefined ? null : (
						<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
							{formatSize(item.size)}
						</span>
					)}
				</div>
				{inFlight ? (
					// `Progress.Root` stays for the ARIA (`progressbar`, `aria-valuenow`,
					// and `aria-valuenow` correctly ABSENT when indeterminate), but the
					// fill is rendered by hand, because Base UI draws an indeterminate
					// indicator at FULL width — a bar that reads as "finished" on a file
					// that has not started. Unknown progress gets the design system's
					// sweeping band instead (same treatment as `TrayProgressLine`), which
					// is the one shape that cannot be mistaken for a percentage.
					<Progress.Root className="w-full" value={value}>
						<Progress.Track className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
							{value === null ? (
								<span aria-hidden="true" className="t-progress-marquee" />
							) : (
								<div
									className="h-full w-(--upload-progress) rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
									style={progressStyle}
								/>
							)}
						</Progress.Track>
					</Progress.Root>
				) : null}
				{item.status === "error" && item.error ? (
					<span className="text-status-destructive text-xs">{item.error}</span>
				) : null}
				{item.status !== "error" && item.note ? (
					<span className="text-muted-foreground text-xs">{item.note}</span>
				) : null}
			</div>
			{item.status === "error" && item.retryable !== false && onRetry ? (
				<button
					aria-label={tl("Retry {name}", { name: item.name })}
					className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground motion-reduce:transition-none"
					onClick={() => onRetry(item)}
					type="button"
				>
					<HugeiconsIcon icon={RefreshIcon} size={14} />
				</button>
			) : null}
			{onRemove ? (
				<button
					aria-label={tl("Remove {name}", { name: item.name })}
					className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground motion-reduce:transition-none"
					// Removing mid-flight would leave the transfer running with nothing
					// rendering it, so the row keeps its file until the owner settles it.
					disabled={inFlight}
					onClick={() => onRemove(item)}
					type="button"
				>
					<HugeiconsIcon icon={Cancel01Icon} size={14} />
				</button>
			) : null}
		</li>
	);
}

/**
 * A dropzone plus the queue of what has been dropped into it.
 *
 * `onFilesAdded` fires for both the drop and the file picker, always with a plain
 * `File[]`; the caller decides what becomes an {@link FileUploadItem}. Nothing is
 * queued by this component itself.
 */
export function FileUpload({
	accept,
	className,
	description = "Anything text-bearing gets indexed for search",
	disabled = false,
	items,
	multiple = true,
	onFilesAdded,
	onRemove,
	onRetry,
	title = "Drop files here",
}: {
	accept?: string;
	className?: string;
	description?: string;
	disabled?: boolean;
	items: FileUploadItem[];
	multiple?: boolean;
	onFilesAdded: (files: File[]) => void;
	onRemove?: (item: FileUploadItem) => void;
	onRetry?: (item: FileUploadItem) => void;
	title?: string;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const inputId = useId();
	const [dragging, setDragging] = useState(false);

	const add = (files: FileList | null) => {
		const list = Array.from(files ?? []);
		if (list.length > 0) {
			onFilesAdded(multiple ? list : list.slice(0, 1));
		}
	};

	const onDrop = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setDragging(false);
		if (!disabled) {
			add(e.dataTransfer.files);
		}
	};

	return (
		<div className={cn("flex w-full flex-col gap-3", className)}>
			<div
				aria-disabled={disabled}
				className={cn(
					"flex flex-col items-center justify-center gap-1 rounded-2xl border border-border border-dashed px-4 py-6 text-center transition-colors motion-reduce:transition-none",
					disabled
						? "cursor-not-allowed opacity-60"
						: "cursor-pointer hover:border-primary/50 hover:bg-muted/40",
					dragging && !disabled && "border-primary bg-primary/5"
				)}
				data-dragging={dragging}
				onClick={() => {
					if (!disabled) {
						inputRef.current?.click();
					}
				}}
				// `dragleave` also fires when the pointer crosses onto a CHILD of the
				// zone, which would flicker the highlight off and on across the icon and
				// the two lines of copy. Only a leave that actually exits the zone counts.
				onDragLeave={(e) => {
					if (
						!(
							e.relatedTarget instanceof Node &&
							e.currentTarget.contains(e.relatedTarget)
						)
					) {
						setDragging(false);
					}
				}}
				onDragOver={(e) => {
					e.preventDefault();
					if (!disabled) {
						setDragging(true);
					}
				}}
				onDrop={onDrop}
				onKeyDown={(e) => {
					if (!disabled && (e.key === "Enter" || e.key === " ")) {
						e.preventDefault();
						inputRef.current?.click();
					}
				}}
				role="button"
				tabIndex={disabled ? -1 : 0}
			>
				<HugeiconsIcon
					className="mb-1 size-5 text-muted-foreground"
					icon={Upload04Icon}
				/>
				<p className="font-medium text-foreground text-sm">{title}</p>
				<p className="text-muted-foreground text-xs">{description}</p>
				<input
					accept={accept}
					className="sr-only"
					disabled={disabled}
					id={inputId}
					multiple={multiple}
					onChange={(e) => {
						add(e.target.files);
						// Clear, so re-picking the same file fires `change` again.
						e.target.value = "";
					}}
					// The zone's own `onClick` opens this input by calling `.click()` on
					// it — and that synthetic click BUBBLES back to the zone, which would
					// open it again, forever. The input is a child of its own trigger, so
					// the recursion is structural; this is the stop.
					onClick={(e) => e.stopPropagation()}
					ref={inputRef}
					type="file"
				/>
			</div>
			{items.length > 0 ? (
				<ul className="scroll-fade flex max-h-60 flex-col gap-1.5 overflow-y-auto">
					{items.map((item) => (
						<FileUploadRow
							item={item}
							key={item.id}
							onRemove={onRemove}
							onRetry={onRetry}
						/>
					))}
				</ul>
			) : null}
		</div>
	);
}
