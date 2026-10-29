"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type CursorOverlayData,
	useRemoteCursorOverlayPositions,
} from "@slate-yjs/react";
import { useEditorContainerRef } from "platejs/react";
import type {
	CSSProperties,
	CSSProperties as ReactCSSProperties,
	RefObject,
} from "react";
import editorStyles from "../editor-lint.module.css";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editorremoteCursorOverlay1-background"?: string | number;
}

/** Per-peer cursor metadata carried in awareness (set via `cursors.data`). */
interface CursorData extends Record<string, unknown> {
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
		// SAFETY: The complete native Plate container ref is forwarded unchanged.
		// Installed slate-yjs guards ref.current before resize observation and
		// overlay measurement, accepting the real render-stage null slot despite
		// its narrower RefObject declaration. This does not prove non-nullness.
		containerRef: containerRef as RefObject<HTMLDivElement>,
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

	return (
		<>
			{selectionRects.map((position) => {
				const selectionStyle: CursorVariableStyle = {
					"--cursor-background": withAlpha(data.color, SELECTION_ALPHA),
					"--cursor-left": `${position.left}px`,
					"--cursor-top": `${position.top}px`,
					"--cursor-width": `${position.width}px`,
					"--cursor-height": `${position.height}px`,
				};
				return (
					<div
						className={cn(
							"pointer-events-none absolute",
							editorStyles.cursorGeometry
						)}
						key={`${position.top}-${position.left}-${position.width}-${position.height}`}
						style={selectionStyle}
					/>
				);
			})}
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
	const editorremoteCursorOverlay1Style: EditorVariableStyle = {
		"--editorremoteCursorOverlay1-background": data?.color,
	};
	const caretStyle: CursorVariableStyle = {
		"--cursor-background": data?.color,
		"--cursor-left": `${caretPosition?.left}px`,
		"--cursor-top": `${caretPosition?.top}px`,
		"--cursor-height": `${caretPosition?.height}px`,
	};
	return (
		<div
			className={cn(
				"group absolute w-0.5 opacity-70 transition-opacity hover:opacity-100",
				editorStyles.cursorGeometry
			)}
			style={caretStyle}
		>
			<div
				className={cn(
					"absolute top-0 -translate-y-full whitespace-nowrap rounded rounded-es-none px-1.5 py-0.5 text-white text-xs",
					editorStyles.editorremoteCursorOverlay1
				)}
				style={editorremoteCursorOverlay1Style}
			>
				{data?.name}
			</div>
		</div>
	);
}

interface CursorVariableStyle extends CSSProperties {
	"--cursor-background"?: string;
	"--cursor-height"?: string;
	"--cursor-left"?: string;
	"--cursor-top"?: string;
	"--cursor-width"?: string;
}
