/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { z } from "zod";

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../i18n/translate.ts";

/** The display fields shared by string queues and richer queued turns. */
export interface ChatQueueItem {
	readonly id?: string;
	readonly text: string;
}

/** Queue entries can remain strings until the scheduler adds turn metadata. */
export type ChatQueueEntry = string | ChatQueueItem;

export type ChatQueueRemoveHandler = (
	index: number,
	item: ChatQueueEntry
) => void;

export type ChatQueueSelectHandler = (index: number) => void;

export type ChatQueueMoveHandler = (
	index: number,
	direction: "up" | "down"
) => void;

const DEFAULT_PREVIEW_LENGTH = 56;
const DEFAULT_PREVIEW_ROWS = 2;

const clampIndex = (index: number, length: number): number => {
	if (length === 0) {
		return 0;
	}
	return Math.min(length - 1, Math.max(0, Math.trunc(index)));
};

const positiveInteger = (value: number, fallback: number): number => {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.trunc(value));
};

const queueTextSchema = z.string();
function isQueueText(entry: ChatQueueEntry): entry is string {
	return queueTextSchema.safeParse(entry).success;
}
export function chatQueueEntryText(entry: ChatQueueEntry): string {
	return isQueueText(entry) ? entry : entry.text;
}
export function chatQueueEntryKey(
	entry: ChatQueueEntry,
	index: number
): string {
	return isQueueText(entry)
		? `${index}:${entry}`
		: (entry.id ?? `${index}:${entry.text}`);
}

/** Collapse multi-line prompts and keep previews bounded for narrow terminals. */
export function truncateChatQueuePreview(
	text: string,
	maxLength = DEFAULT_PREVIEW_LENGTH
): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	const length = positiveInteger(maxLength, DEFAULT_PREVIEW_LENGTH);

	if (normalized.length === 0) {
		return "…";
	}
	if (normalized.length <= length) {
		return normalized;
	}
	if (length === 1) {
		return "…";
	}
	return `${normalized.slice(0, length - 1)}…`;
}

export interface ChatQueuePreviewRowProps {
	entry: ChatQueueEntry;
	index: number;
	onRemove?: ChatQueueRemoveHandler;
	previewLength?: number;
	selected?: boolean;
}

/** One compact, reusable queue preview row. The host still owns all actions. */
export function ChatQueuePreviewRow({
	entry,
	index,
	onRemove,
	previewLength = DEFAULT_PREVIEW_LENGTH,
	selected = false,
}: ChatQueuePreviewRowProps) {
	const theme = useTheme();
	const rowForeground = selected
		? theme.colors.selectionForeground
		: theme.colors.foreground;
	const preview = truncateChatQueuePreview(
		chatQueueEntryText(entry),
		previewLength
	);
	const prefix = `${selected ? "›" : " "} ${index + 1}. `;
	const suffix = onRemove ? " ×" : "";

	return (
		<box
			backgroundColor={selected ? theme.colors.selection : undefined}
			height={1}
			width="100%"
		>
			<text fg={rowForeground}>{`${prefix}${preview}${suffix}`}</text>
		</box>
	);
}

export interface ChatQueueBarProps {
	/** Text shown for the focused queue's escape action. */
	cancelHint?: string;
	/** Text shown beside the clear affordance. */
	clearHint?: string;
	/** Whether this bar currently owns queue navigation keys. */
	focused?: boolean;
	/** Text shown when Enter opens the bounded queue view. */
	focusHint?: string;
	items: readonly ChatQueueEntry[];
	label?: string;
	maxPreviewLength?: number;
	maxPreviewRows?: number;
	onCancel?: () => void;
	onClear?: () => void;
	onFocus?: () => void;
	onMove?: ChatQueueMoveHandler;
	onRemove?: ChatQueueRemoveHandler;
	onSelect?: ChatQueueSelectHandler;
	/** The host-controlled highlighted row. */
	selectedIndex?: number;
}

const queueBarHints = ({
	cancelHint,
	clearHint,
	focused,
	focusHint,
	onClear,
	onMove,
	onRemove,
}: Pick<
	ChatQueueBarProps,
	| "cancelHint"
	| "clearHint"
	| "focused"
	| "focusHint"
	| "onClear"
	| "onMove"
	| "onRemove"
>): string => {
	if (!focused) {
		return [focusHint, onClear ? clearHint : null]
			.filter((hint): hint is string => Boolean(hint))
			.join(" · ");
	}

	return [
		"↑↓ move",
		onMove ? "⇧↑↓ reorder" : null,
		onRemove ? "x remove" : null,
		onClear ? "c clear" : null,
		cancelHint,
	]
		.filter((hint): hint is string => Boolean(hint))
		.join(" · ");
};

export function ChatQueueBar({
	cancelHint = "Esc cancel",
	clearHint = "c clear",
	focused = false,
	focusHint = "Enter inspect",
	items,
	label = "Queue",
	maxPreviewLength = DEFAULT_PREVIEW_LENGTH,
	maxPreviewRows = DEFAULT_PREVIEW_ROWS,
	onCancel,
	onClear,
	onFocus,
	onMove,
	onRemove,
	onSelect,
	selectedIndex,
}: ChatQueueBarProps) {
	const theme = useTheme();
	const visibleRows = positiveInteger(maxPreviewRows, DEFAULT_PREVIEW_ROWS);
	const selected =
		selectedIndex === undefined ? -1 : clampIndex(selectedIndex, items.length);
	const keyboardIndex = clampIndex(selectedIndex ?? 0, items.length);

	useKeyboard((key) => {
		if (!focused || items.length === 0) {
			return;
		}
		if (key.name === "return") {
			onFocus?.();
			return;
		}
		if (key.name === "escape") {
			onCancel?.();
			return;
		}
		if (
			onMove &&
			(key.name === "up" ||
				key.name === "k" ||
				key.name === "down" ||
				key.name === "j") &&
			key.shift
		) {
			onMove(
				keyboardIndex,
				key.name === "up" || key.name === "k" ? "up" : "down"
			);
			return;
		}
		if (key.name === "up" || key.name === "k") {
			onSelect?.(clampIndex(keyboardIndex - 1, items.length));
			return;
		}
		if (key.name === "down" || key.name === "j") {
			onSelect?.(clampIndex(keyboardIndex + 1, items.length));
			return;
		}
		if (
			onRemove &&
			(key.name === "x" || key.name === "delete" || key.name === "backspace")
		) {
			const entry = items[keyboardIndex];
			if (entry !== undefined) {
				onRemove(keyboardIndex, entry);
			}
			return;
		}
		if (onClear && key.name === "c" && !key.ctrl && !key.meta) {
			onClear();
		}
	});

	if (items.length === 0) {
		return null;
	}

	const previews = items.slice(0, visibleRows);
	const hiddenCount = items.length - previews.length;
	const hints = queueBarHints({
		cancelHint,
		clearHint,
		focused,
		focusHint,
		onClear,
		onMove,
		onRemove,
	});

	return (
		<box
			borderColor={focused ? theme.colors.focusRing : theme.colors.border}
			borderStyle="rounded"
			flexDirection="column"
			height={previews.length + 4 + (hiddenCount > 0 ? 1 : 0)}
			paddingLeft={1}
			paddingRight={1}
			width="100%"
		>
			<box flexDirection="row" height={1} justifyContent="space-between">
				<text fg={theme.colors.primary}>
					<b>
						{tf("{label} · {count} queued", {
							count: String(items.length),
							label,
						})}
					</b>
				</text>
				{focused ? <text fg={theme.colors.focusRing}>focused</text> : null}
			</box>
			{previews.map((entry, index) => (
				<ChatQueuePreviewRow
					entry={entry}
					index={index}
					key={chatQueueEntryKey(entry, index)}
					onRemove={onRemove}
					previewLength={maxPreviewLength}
					selected={index === selected}
				/>
			))}
			{hiddenCount > 0 ? (
				<text fg={theme.colors.mutedForeground} height={1}>
					{tf("+{hiddenCount} more", { hiddenCount: String(hiddenCount) })}
				</text>
			) : null}
			<text fg={theme.colors.mutedForeground} height={1}>
				{hints}
			</text>
		</box>
	);
}
