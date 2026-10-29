/* @jsxImportSource @opentui/react */

import type {
	BorderCharacters,
	BoxRenderable,
	ScrollBoxRenderable,
} from "@opentui/core";
import { type RefObject, useCallback, useRef, useState } from "react";
import { Diff } from "@/components/ui/diff.tsx";
import { useTheme, useUnicode } from "@/components/ui/theme-provider.tsx";
import {
	type ChatPermission,
	type ChatPermissionOption,
	isRejectPermissionOption,
	type PermissionToolDetail,
	permissionToolTitle,
} from "../../core/chatPermission.ts";
import { tf } from "../../i18n/translate.ts";

const PERMISSION_BAR: BorderCharacters = {
	topLeft: " ",
	topRight: " ",
	bottomLeft: " ",
	bottomRight: " ",
	horizontal: " ",
	vertical: "┃",
	topT: " ",
	bottomT: " ",
	leftT: " ",
	rightT: " ",
	cross: " ",
};
const PERMISSION_BAR_ASCII: BorderCharacters = {
	...PERMISSION_BAR,
	vertical: "|",
};

/**
 * Rows kept outside the detail body: the prompt's header, title, options and
 * hint plus the chat chrome (tab bar, status rows, workspace bar, footer).
 */
const PERMISSION_CHROME_ROWS = 12;
const PERMISSION_BODY_MAX_ROWS = 15;
const PERMISSION_BODY_MIN_ROWS = 3;

/**
 * The detail body's row budget: up to 15 rows, but always leaving the option
 * row and hint on screen in an 80x24 terminal.
 */
export function permissionBodyMaxHeight(terminalHeight: number): number {
	return Math.min(
		PERMISSION_BODY_MAX_ROWS,
		Math.max(PERMISSION_BODY_MIN_ROWS, terminalHeight - PERMISSION_CHROME_ROWS)
	);
}

const KIND_GLYPHS: Record<string, readonly [string, string]> = {
	execute: ["#", "#"],
	edit: ["✎", "~"],
	delete: ["✗", "x"],
	move: ["⇆", ">"],
	read: ["→", ">"],
	search: ["✱", "*"],
	fetch: ["%", "%"],
	think: ["◇", "?"],
};

/** One glyph per ACP tool kind, so the title says what sort of call it is. */
export function permissionKindGlyph(
	kind: string | undefined,
	unicode: boolean
): string {
	const glyphs = (kind ? KIND_GLYPHS[kind] : undefined) ?? ["⚙", "*"];
	return unicode ? glyphs[0] : glyphs[1];
}

/** The rough number of wrapped rows `text` takes at `width` columns. */
const wrappedRows = (text: string, width: number): number =>
	text
		.split("\n")
		.reduce(
			(rows, line) => rows + Math.max(1, Math.ceil(line.length / width)),
			0
		);

function permissionBodyRows(
	detail: PermissionToolDetail,
	width: number
): number {
	let rows = 0;
	if (detail.path && !detail.diff) {
		rows += wrappedRows(tf("path: {path}", { path: detail.path }), width);
	}
	if (detail.command) {
		rows += wrappedRows(`$ ${detail.command}`, width);
	}
	if (detail.cwd) {
		rows += wrappedRows(tf("cwd: {cwd}", { cwd: detail.cwd }), width);
	}
	if (detail.diff) {
		// The Diff frame adds a border row above and below its lines.
		rows += detail.diff.length + 2;
	}
	return rows;
}

function optionColor(
	option: ChatPermissionOption,
	colors: ReturnType<typeof useTheme>["colors"]
): string {
	if (isRejectPermissionOption(option)) {
		return colors.error;
	}
	return option.kind.startsWith("allow") ? colors.success : colors.foreground;
}

/**
 * PermissionPrompt - takes the composer's place while an agent waits for tool
 * approval: a warning bar, what the tool will run or change, and numbered
 * option pills (1-n or a click choose immediately, enter confirms, esc
 * rejects, page up/down scroll a body taller than its row budget).
 */
export function PermissionPrompt({
	bodyScrollRef,
	detail,
	index,
	onChoose,
	permission,
	terminal,
}: {
	/** The detail body, so the surface's key handler can page through it. */
	bodyScrollRef?: RefObject<ScrollBoxRenderable | null>;
	detail: PermissionToolDetail;
	index: number;
	/** Submit the option at this index (a pill was clicked). */
	onChoose?: (index: number) => void;
	permission: ChatPermission;
	terminal: { height: number; width: number };
}) {
	const theme = useTheme();
	const unicode = useUnicode();
	// A diff already names its file in its header rows.
	const showPath = detail.path !== undefined && detail.diff === null;
	// The pane can be much narrower than the terminal (sidebar, splits), so the
	// estimate only seeds the first frame; the body's laid-out height wins.
	const bodyRef = useRef<BoxRenderable | null>(null);
	const [measuredRows, setMeasuredRows] = useState<number | null>(null);
	const measureBody = useCallback(() => {
		const height = bodyRef.current?.height;
		if (height !== undefined && height > 0) {
			setMeasuredRows(height);
		}
	}, []);
	const bodyRows =
		measuredRows ??
		permissionBodyRows(detail, Math.max(10, terminal.width - 6));
	const bodyHeight = Math.min(
		bodyRows,
		permissionBodyMaxHeight(terminal.height)
	);
	const count = permission.options.length;
	const dot = unicode ? "·" : "-";
	const arrows = unicode ? "←/→" : "left/right";
	const hint = [
		count > 1 ? `1-${count} select` : "1 select",
		`${arrows} move`,
		"Enter confirm",
		"Esc reject",
		...(bodyRows > bodyHeight ? ["PgUp/PgDn scroll"] : []),
	].join(` ${dot} `);
	return (
		<box
			border={["left"]}
			borderColor={theme.colors.warning}
			customBorderChars={unicode ? PERMISSION_BAR : PERMISSION_BAR_ASCII}
			flexDirection="column"
			flexShrink={0}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.colors.warning}>
				<b>
					{tf("{glyph} Permission required", { glyph: unicode ? "△" : "!" })}
				</b>
			</text>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={theme.colors.warning} flexShrink={0}>
					{permissionKindGlyph(detail.kind, unicode)}
				</text>
				<text
					fg={theme.colors.foreground}
					flexShrink={1}
					truncate
					wrapMode="none"
				>
					{tf("Allow the agent to {action}?", {
						action: permissionToolTitle(permission.toolCall),
					})}
				</text>
			</box>
			{bodyRows > 0 ? (
				<scrollbox flexShrink={0} height={bodyHeight} ref={bodyScrollRef}>
					<box
						flexDirection="column"
						flexShrink={0}
						onSizeChange={measureBody}
						ref={bodyRef}
					>
						{detail.command ? (
							<text fg={theme.colors.foreground}>{`$ ${detail.command}`}</text>
						) : null}
						{detail.cwd ? (
							<text fg={theme.colors.mutedForeground}>
								{tf("cwd: {cwd}", { cwd: detail.cwd })}
							</text>
						) : null}
						{showPath ? (
							<text fg={theme.colors.mutedForeground}>
								{tf("path: {path}", { path: detail.path ?? "" })}
							</text>
						) : null}
						{detail.diff ? <Diff lines={detail.diff} /> : null}
					</box>
				</scrollbox>
			) : null}
			<box flexDirection="row" flexWrap="wrap" marginTop={1}>
				{permission.options.map((option, i) => {
					const selected = i === index;
					const color = optionColor(option, theme.colors);
					// The selected pill inverts into its kind's colour.
					return (
						<text
							bg={selected ? color : undefined}
							fg={selected ? theme.colors.background : color}
							key={option.optionId}
							marginRight={1}
							onMouseDown={() => onChoose?.(i)}
						>
							{` [${i + 1}] ${option.name} `}
						</text>
					);
				})}
			</box>
			<text fg={theme.colors.mutedForeground}>{hint}</text>
		</box>
	);
}
