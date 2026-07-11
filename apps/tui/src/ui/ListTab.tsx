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
import { Badge } from "@/components/ui/badge.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import type { ListRow } from "../core/featureList.ts";
import { useInputFocused } from "../core/InputFocusContext.tsx";
import { ErrorView } from "./ErrorView.tsx";
import { Loading } from "./Loading.tsx";

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
	/** Max visible rows before windowing kicks in. */
	height?: number;
	/** Async row loader. Re-invoked on 'r' and when url/token change. */
	load: ListLoader;
	/** Enter on the selected row. Return a string to flash it as the notice. */
	onActivate?: ListAction;
	/** 'a' on the selected row (activate/use). Return a string to flash as notice. */
	onSecondary?: ListAction;
}

const DEFAULT_HEIGHT = 16;

export function ListTab({
	active,
	load,
	onActivate,
	onSecondary,
	emptyLabel = "No items",
	height = DEFAULT_HEIGHT,
}: ListTabProps) {
	const { target, url, token } = useCore();
	const theme = useTheme();
	const inputFocused = useInputFocused();

	const [rows, setRows] = useState<ListRow[]>([]);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [_reloadKey, setReloadKey] = useState(0);

	// Track the latest request so a stale resolve cannot clobber fresh data.
	const reqRef = useRef(0);

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		setError(null);
		load(target)
			.then((next) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setRows(next);
				setIndex((i) => (next.length === 0 ? 0 : Math.min(i, next.length - 1)));
				setLoaded(true);
			})
			.catch((err: unknown) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setError(err instanceof Error ? err.message : String(err));
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
		// url/token are primitives; including them re-loads on a node switch.
	}, [active, runLoad]);

	const selected = rows[index];

	const handleAction = useCallback(
		(action: ListAction | undefined) => {
			if (!(action && selected)) {
				return;
			}
			Promise.resolve(action(selected, target))
				.then((msg) => {
					if (typeof msg === "string") {
						setNotice(msg);
					}
				})
				.catch((err: unknown) => {
					setNotice(
						`error: ${err instanceof Error ? err.message : String(err)}`
					);
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
		return <ErrorView message={error} />;
	}

	// Window the rows so the selection stays visible without a focus-capturing
	// scrollbox (which would fight the shell for arrow keys).
	const start = Math.max(
		0,
		Math.min(index - Math.floor(height / 2), Math.max(0, rows.length - height))
	);
	const visible = rows.slice(start, start + height);

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			{notice ? (
				<box paddingBottom={1}>
					<text fg={theme.colors.success}>{notice}</text>
				</box>
			) : null}
			{rows.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>{emptyLabel}</text>
			) : (
				<box flexDirection="column">
					{visible.map((row, i) => {
						const absolute = start + i;
						const isSel = absolute === index;
						return (
							<box flexDirection="row" gap={1} key={`${row.id}-${absolute}`}>
								<text fg={isSel ? theme.colors.primary : theme.colors.muted}>
									{isSel ? "›" : " "}
								</text>
								<box flexDirection="column" flexGrow={1}>
									<box flexDirection="row" gap={1}>
										<text
											fg={
												isSel ? theme.colors.primary : theme.colors.foreground
											}
										>
											{isSel ? <b>{row.title}</b> : row.title}
										</text>
										{row.badge ? (
											<Badge bordered={false} variant="secondary">
												{row.badge}
											</Badge>
										) : null}
									</box>
									{row.subtitle ? (
										<text fg={theme.colors.mutedForeground}>
											{row.subtitle}
										</text>
									) : null}
								</box>
							</box>
						);
					})}
					{rows.length > visible.length ? (
						<text fg={theme.colors.mutedForeground}>
							{`${index + 1}/${rows.length}`}
						</text>
					) : null}
				</box>
			)}
		</box>
	);
}
