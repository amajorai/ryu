/* @jsxImportSource @opentui/react */
// Generic data-driven list tab, the TS port of apps/cli's SimpleListTab +
// render_feature_tab. Owns the full lifecycle a list tab needs: lazy load on
// first activation, j/k + arrow selection, Enter (primary action) and 'a'
// (secondary action), 'r' to reload, a transient notice line, and loading/error
// states. Builders give it a `load` function (typically featureListLoader(config)
// or a typed core-client call mapped to ListRow[]) plus optional action handlers,
// and get a consistent, themed list for free.
//
// Keyboard is OWNED here and gated on `active` so an inactive (unmounted) tab and
// the shell never both react. It does NOT use termcn's <List> (which registers its
// own greedy useKeyboard); selection state lives here so it composes with the
// shell's ownership model.

import { useKeyboard } from "@opentui/react";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import type { ListRow } from "../core/featureList.ts";
import { useInputFocused } from "../core/InputFocusContext.tsx";
import { humanizeError, nativeErrorMessage } from "../core/native-errors.ts";
import { sanitizeTerminalText } from "../core/transcriptPresentation.ts";
import { ErrorView } from "./ErrorView.tsx";
import { Loading } from "./Loading.tsx";
import { ListPosition, SelectableRow } from "./SelectableRow.tsx";
import { useListWindow } from "./useListWindow.ts";

const listActionNoticeSchema = z.string();

export type ListLoader = (
	target: ApiTarget,
	signal?: AbortSignal
) => Promise<ListRow[]>;

// Returns a string to flash as the notice, or undefined for no notice. Sync or
// async. (undefined rather than void so the union stays lint-clean; a handler
// that does only a side effect should `return undefined`.)
export type ListAction = (
	row: ListRow,
	target: ApiTarget
) => string | undefined | Promise<string | undefined>;

export interface ListTabProps {
	/** Whether this tab is the active/visible one (gates keyboard + first load). */
	active: boolean;
	/** Shown when the loaded list is empty. */
	emptyLabel?: string;
	/** Optional cap on visible rows. The window otherwise fills the measured
	 *  space the layout gives the list (see useListWindow). */
	height?: number;
	/** Async row loader. Re-invoked on 'r' and when url/token change. */
	load: ListLoader;
	/** Enter on the selected row. Return a string to flash it as the notice. */
	onActivate?: ListAction;
	/** 'a' on the selected row (activate/use). Return a string to flash as notice. */
	onSecondary?: ListAction;
}

export function ListTab({
	active,
	load,
	onActivate,
	onSecondary,
	emptyLabel = "No items",
	height,
}: ListTabProps) {
	const { target } = useCore();
	const theme = useTheme();
	const inputFocused = useInputFocused();

	const [rows, setRows] = useState<ListRow[]>([]);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);

	// Track the latest request so a stale resolve cannot clobber fresh data.
	const reqRef = useRef(0);

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		setError(null);
		// Action notices describe the previous catalog snapshot. Clear them as a
		// refresh begins so a completed install does not keep saying "installing".
		setNotice(null);
		load(target)
			.then((next) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setRows(next);
				setIndex((i) => (next.length === 0 ? 0 : Math.min(i, next.length - 1)));
				setLoaded(true);
			})
			.catch((err) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setError(nativeErrorMessage(err));
				setLoaded(true);
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});
	}, [load, target]);

	// Lazy first load on activation, plus reload on node switch or explicit 'r'.
	useEffect(() => {
		if (active) {
			runLoad();
		}
		// `reloadKey` is load-bearing: the 'r' keybinding only bumps it, so without
		// it 'r' is dead. Add ONLY that — do not also re-add `url, token`: `runLoad`
		// already changes identity on a node switch (it closes over `target` from
		// CoreContext), so including them would double-load.
	}, [active, runLoad, reloadKey]);

	const selected = rows[index];
	// Window the rows to the measured space so the selection stays visible
	// without a focus-capturing scrollbox (which would fight the shell for arrow
	// keys), and so a short terminal never overlaps rows.
	const linesPerRow = rows.some((row) => row.subtitle) ? 2 : 1;
	const { start, end, onSizeChange } = useListWindow({
		count: rows.length,
		index,
		linesPerRow,
		maxRows: height,
	});

	const handleAction = useCallback(
		(action: ListAction | undefined) => {
			if (!(action && selected)) {
				return;
			}
			Promise.resolve(action(selected, target))
				.then((msg) => {
					const notice = listActionNoticeSchema.safeParse(msg);
					if (notice.success) {
						setNotice(notice.data);
					}
				})
				.catch((err) => {
					setNotice(`error: ${nativeErrorMessage(err)}`);
				});
		},
		[selected, target]
	);

	useKeyboard((key) => {
		if (!active || inputFocused) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down" || key.name === "j") {
			setIndex((i) => Math.min(Math.max(0, rows.length - 1), i + 1));
		} else if (key.name === "return") {
			handleAction(onActivate);
		} else if (key.name === "a") {
			handleAction(onSecondary);
		} else if (key.name === "r") {
			setReloadKey((k) => k + 1);
		}
	});

	if (loading && !loaded) {
		return <Loading label="Loading…" />;
	}
	if (error) {
		return (
			<ErrorView
				message={sanitizeTerminalText(
					humanizeError(error, { url: target.url })
				)}
				onRetry
			/>
		);
	}

	const visible = rows.slice(start, end);

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			minHeight={0}
			paddingLeft={1}
			paddingTop={1}
		>
			{notice ? (
				<box flexShrink={0} paddingBottom={1}>
					<text fg={theme.colors.success}>{sanitizeTerminalText(notice)}</text>
				</box>
			) : null}
			{rows.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>
					{sanitizeTerminalText(emptyLabel)}
				</text>
			) : (
				<>
					<box
						flexBasis={0}
						flexDirection="column"
						flexGrow={1}
						minHeight={0}
						onSizeChange={onSizeChange}
						overflow="hidden"
					>
						{visible.map((row, i) => {
							const absolute = start + i;
							return (
								<SelectableRow
									key={`${row.id}-${absolute}`}
									linesPerRow={linesPerRow}
									selected={absolute === index}
									subtitle={
										row.subtitle
											? sanitizeTerminalText(row.subtitle)
											: undefined
									}
									title={sanitizeTerminalText(row.title)}
									titleSuffix={
										row.badge ? (
											<Badge
												bordered={false}
												color={
													absolute === index
														? theme.colors.selectionForeground
														: undefined
												}
												variant="secondary"
											>
												{sanitizeTerminalText(row.badge)}
											</Badge>
										) : undefined
									}
								/>
							);
						})}
					</box>
					<ListPosition
						count={rows.length}
						index={index}
						visible={visible.length}
					/>
				</>
			)}
		</box>
	);
}
