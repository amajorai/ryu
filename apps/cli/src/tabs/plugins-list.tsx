/* @jsxImportSource @opentui/react */
// Plugins tab list — the windowed rows of the Plugins tab (plugins.tsx).

import type { AppInfo } from "@ryuhq/core-client/plugins";
import { ListPosition, SelectableRow } from "../ui/SelectableRow.tsx";
import { useListWindow } from "../ui/useListWindow.ts";
import {
	chipFor,
	NAME_WIDTH,
	STATE_WIDTH,
	type ThemeValue,
} from "./plugins-lifecycle.ts";

function PluginRow({
	app,
	selected,
	busy,
	theme,
}: {
	app: AppInfo;
	busy: boolean;
	selected: boolean;
	theme: ThemeValue;
}) {
	const chip = chipFor(app);
	const name = app.name.padEnd(NAME_WIDTH);
	const stateText = (busy ? "working" : chip.label).padEnd(STATE_WIDTH);
	const version = app.installedVersion ?? app.version ?? "";
	const muted = selected
		? theme.colors.selectionForeground
		: theme.colors.mutedForeground;
	// State tones are tuned for the page background and fall below text
	// contrast on the selection background; the label still carries the state.
	const toneColor = busy ? theme.colors.info : chip.color(theme);
	const stateColor = selected ? theme.colors.selectionForeground : toneColor;
	return (
		<SelectableRow selected={selected}>
			<text
				fg={
					selected ? theme.colors.selectionForeground : theme.colors.foreground
				}
				flexShrink={0}
			>
				{selected ? <b>{name}</b> : name}
			</text>
			<text fg={stateColor} flexShrink={0}>
				{stateText}
			</text>
			{app.builtIn ? (
				<text fg={muted} flexShrink={0}>
					[built-in]
				</text>
			) : null}
			{version ? (
				<text fg={muted} truncate wrapMode="none">
					{version}
				</text>
			) : null}
		</SelectableRow>
	);
}

export function PluginList({
	apps,
	index,
	busy,
	theme,
}: {
	apps: AppInfo[];
	busy: string | null;
	index: number;
	theme: ThemeValue;
}) {
	// Window the rows to the measured space so the selection stays visible
	// without a focus-capturing scrollbox (which would fight the shell for arrow
	// keys) — parity with apps.tsx.
	const { start, end, onSizeChange } = useListWindow({
		count: apps.length,
		index,
		linesPerRow: 1,
	});
	const visible = apps.slice(start, end);

	return (
		<>
			<box
				flexBasis={0}
				flexDirection="column"
				flexGrow={1}
				minHeight={0}
				onSizeChange={onSizeChange}
				overflow="hidden"
			>
				{visible.map((app, i) => {
					const absolute = start + i;
					return (
						<PluginRow
							app={app}
							busy={busy === app.id}
							key={app.id}
							selected={absolute === index}
							theme={theme}
						/>
					);
				})}
			</box>
			<ListPosition
				count={apps.length}
				index={index}
				visible={visible.length}
			/>
		</>
	);
}
