"use client";

// Renders other people's carets and text selections over the Plate editable.
// Adapted from the Plate registry overlay (itself lifted from slate-yjs), which
// reads remote cursor positions out of the shared y-protocols Awareness via
// `@slate-yjs/react`. It is wired as `YjsPlugin`'s `render.afterEditable` and
// only ever mounts on a collaborative editor (the one path that applies
// `withCursors`), so the editor is always a cursor-capable editor here.
//
// Unlike the upstream registry component this does NOT gate on the plugin's
// `_isSynced` option: that flag is only set by the built-in provider wrappers,
// not by a pre-instantiated custom provider (our `RyuYjsProvider`), so gating on
// it would hide cursors forever. Instead we render directly — the positions hook
// returns an empty list until a remote peer publishes awareness, so nothing
// shows before the first remote cursor arrives.

import {
	type CursorOverlayData,
	useRemoteCursorOverlayPositions,
} from "@slate-yjs/react";
import { useEditorContainerRef } from "platejs/react";
import type { CSSProperties } from "react";

/** Per-peer cursor metadata carried in awareness (set via `cursors.data`). */
interface CursorData {
	color: string;
	name: string;
}

const SELECTION_ALPHA = 0.5;

/**
 * Append an alpha channel to a `#rrggbb` color, producing `#rrggbbaa`. Keeps the
 * remote selection highlight translucent so the underlying text stays readable.
 */
function withAlpha(hexColor: string, opacity: number): string {
	const clamped = Math.round(Math.min(Math.max(opacity, 0), 1) * 255);
	return hexColor + clamped.toString(16).padStart(2, "0").toUpperCase();
}

export function RemoteCursorOverlay() {
	const containerRef = useEditorContainerRef();
	const [cursors] = useRemoteCursorOverlayPositions<CursorData>({
		containerRef,
	});

	return (
		<>
			{cursors.map((cursor) => (
				<RemoteSelection key={cursor.clientId} {...cursor} />
			))}
		</>
	);
}

function RemoteSelection({
	caretPosition,
	data,
	selectionRects,
}: CursorOverlayData<CursorData>) {
	if (!data) {
		return null;
	}

	const selectionStyle: CSSProperties = {
		backgroundColor: withAlpha(data.color, SELECTION_ALPHA),
	};

	return (
		<>
			{selectionRects.map((position) => (
				<div
					className="pointer-events-none absolute"
					key={`${position.top}-${position.left}-${position.width}-${position.height}`}
					style={{ ...selectionStyle, ...position }}
				/>
			))}
			{caretPosition && <Caret caretPosition={caretPosition} data={data} />}
		</>
	);
}

function Caret({
	caretPosition,
	data,
}: Pick<CursorOverlayData<CursorData>, "caretPosition" | "data">) {
	// Hover-to-emphasize is pure CSS (group-hover): no mouse handlers, so no
	// interactive-handler accessibility lint and no React state for a cosmetic
	// effect. The caret + its name label brighten together on hover.
	return (
		<div
			className="group absolute w-0.5 opacity-70 transition-opacity hover:opacity-100"
			style={{ ...caretPosition, background: data?.color }}
		>
			<div
				className="absolute top-0 -translate-y-full whitespace-nowrap rounded rounded-bl-none px-1.5 py-0.5 text-white text-xs"
				style={{ background: data?.color }}
			>
				{data?.name}
			</div>
		</div>
	);
}
