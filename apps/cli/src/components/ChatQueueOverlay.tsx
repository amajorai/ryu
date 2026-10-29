/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../i18n/translate.ts";

import {
	type ChatQueueEntry,
	type ChatQueueMoveHandler,
	ChatQueuePreviewRow,
	type ChatQueueRemoveHandler,
	type ChatQueueSelectHandler,
	chatQueueEntryKey,
} from "./ChatQueueBar.tsx";

const DEFAULT_MAX_VISIBLE_ROWS = 8;
const DEFAULT_PREVIEW_LENGTH = 68;
const DEFAULT_WIDTH = "80%" as const;

export interface ChatQueueOverlayProps {
	/** Text shown for the clear action. */
	clearHint?: string;
	/** Whether this overlay currently owns keyboard input. */
	focused?: boolean;
	items: readonly ChatQueueEntry[];
	maxPreviewLength?: number;
	/** Maximum number of queue rows rendered at once. */
	maxVisibleRows?: number;
	onCancel?: () => void;
	onClear?: () => void;
	onMove?: ChatQueueMoveHandler;
	onRemove?: ChatQueueRemoveHandler;
	onSelect?: ChatQueueSelectHandler;
	/** The host-controlled highlighted row. */
	selectedIndex?: number;
	title?: string;
	width?: number | `${number}%`;
}

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

interface VisibleQueueWindow {
	end: number;
	start: number;
}

function visibleWindow(
	length: number,
	selectedIndex: number,
	maxVisibleRows: number
): VisibleQueueWindow {
	if (length <= maxVisibleRows) {
		return { end: length, start: 0 };
	}

	const centeredStart = selectedIndex - Math.floor(maxVisibleRows / 2);
	const lastStart = length - maxVisibleRows;
	const start = Math.min(lastStart, Math.max(0, centeredStart));
	return { end: start + maxVisibleRows, start };
}

const overlayHints = (
	clearHint: string,
	onClear: ChatQueueOverlayProps["onClear"],
	onMove: ChatQueueOverlayProps["onMove"],
	onRemove: ChatQueueOverlayProps["onRemove"]
): string =>
	[
		"↑↓ move",
		onMove ? "⇧↑↓ reorder" : null,
		onRemove ? "x remove" : null,
		onClear ? clearHint : null,
		"Esc cancel",
	]
		.filter((hint): hint is string => Boolean(hint))
		.join(" · ");

export function ChatQueueOverlay({
	clearHint = "c clear",
	focused = true,
	items,
	maxPreviewLength = DEFAULT_PREVIEW_LENGTH,
	maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
	onCancel,
	onClear,
	onMove,
	onRemove,
	onSelect,
	selectedIndex = 0,
	title = "Queued prompts",
	width = DEFAULT_WIDTH,
}: ChatQueueOverlayProps) {
	const theme = useTheme();
	const rowLimit = positiveInteger(maxVisibleRows, DEFAULT_MAX_VISIBLE_ROWS);
	const currentIndex = clampIndex(selectedIndex, items.length);
	const { end, start } = visibleWindow(items.length, currentIndex, rowLimit);

	useKeyboard((key) => {
		if (!focused) {
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
				currentIndex,
				key.name === "up" || key.name === "k" ? "up" : "down"
			);
			return;
		}
		if (key.name === "up" || key.name === "k") {
			onSelect?.(clampIndex(currentIndex - 1, items.length));
			return;
		}
		if (key.name === "down" || key.name === "j") {
			onSelect?.(clampIndex(currentIndex + 1, items.length));
			return;
		}
		if (
			onRemove &&
			items.length > 0 &&
			(key.name === "x" || key.name === "delete" || key.name === "backspace")
		) {
			const entry = items[currentIndex];
			if (entry !== undefined) {
				onRemove(currentIndex, entry);
			}
			return;
		}
		if (
			onClear &&
			items.length > 0 &&
			key.name === "c" &&
			!key.ctrl &&
			!key.meta
		) {
			onClear();
		}
	});

	const hints = overlayHints(clearHint, onClear, onMove, onRemove);

	return (
		<box
			alignItems="center"
			height="100%"
			justifyContent="center"
			position="absolute"
			width="100%"
			zIndex={20}
		>
			<box
				backgroundColor={theme.colors.background}
				borderColor={focused ? theme.colors.focusRing : theme.colors.border}
				borderStyle="rounded"
				flexDirection="column"
				maxHeight={rowLimit + 6}
				maxWidth="100%"
				overflow="hidden"
				padding={1}
				width={width}
			>
				<box flexDirection="row" justifyContent="space-between">
					<text fg={theme.colors.primary}>
						<b>{title}</b>
					</text>
					<text fg={theme.colors.mutedForeground}>
						{tf("{count} queued", { count: String(items.length) })}
					</text>
				</box>

				{items.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>Queue is empty</text>
				) : (
					items.slice(start, end).map((entry, offset) => {
						const index = start + offset;
						return (
							<ChatQueuePreviewRow
								entry={entry}
								index={index}
								key={chatQueueEntryKey(entry, index)}
								onRemove={onRemove}
								previewLength={maxPreviewLength}
								selected={index === currentIndex}
							/>
						);
					})
				)}

				<box flexDirection="row" justifyContent="space-between" marginTop={1}>
					<text fg={theme.colors.mutedForeground}>{hints}</text>
					<text fg={theme.colors.mutedForeground}>
						{items.length > 0 ? `${currentIndex + 1}/${items.length}` : "0/0"}
					</text>
				</box>
			</box>
		</box>
	);
}
