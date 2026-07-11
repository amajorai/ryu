/* @jsxImportSource @opentui/react */
// Store-wide search results - the TUI analog of apps/desktop StoreSearchResults.
// When the store shell has a query it replaces the section content with one
// aggregated, realm-tagged result list drawn from every searchable realm (Plugins /
// Models / Skills / MCP). Catalogs are loaded once (and on a node switch) via the
// shared featureListLoader-backed loaders in sections.ts, then filtered client-side
// as the query changes - so search rewrites no fetch logic.
//
// Keyboard is OWNED here and gated on `active` (the shell passes active=false while
// the search input itself is focused, so typing and result navigation never fight).
// j/k move the selection; Enter opens the selected result's realm as a section.

import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import type { ListRow } from "../../core/featureList.ts";
import { ErrorView } from "../../ui/ErrorView.tsx";
import { Loading } from "../../ui/Loading.tsx";
import { SEARCH_REALMS, type StoreSection } from "./sections.ts";

const LIST_HEIGHT = 14;

interface StoreSearchProps {
	/** Gates the result-navigation keyboard (false while the input is focused). */
	active: boolean;
	/** Open a realm as a store section (clears the query in the shell). */
	onOpen: (section: StoreSection) => void;
	/** The current store-wide query. */
	query: string;
}

interface Result {
	badge?: string;
	id: string;
	realm: StoreSection;
	realmLabel: string;
	subtitle?: string;
	title: string;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function matches(row: ListRow, needle: string): boolean {
	const haystack = `${row.title} ${row.subtitle ?? ""}`.toLowerCase();
	return haystack.includes(needle);
}

// Flatten every realm's rows (kept realm-tagged) so filtering + selection work over
// one list. The per-realm shape is preserved via the realm/realmLabel fields.
function buildResults(byRealm: Map<StoreSection, ListRow[]>): Result[] {
	const out: Result[] = [];
	for (const realm of SEARCH_REALMS) {
		const rows = byRealm.get(realm.id) ?? [];
		for (const row of rows) {
			out.push({
				id: `${realm.id}:${row.id || row.title}`,
				realm: realm.id,
				realmLabel: realm.label,
				title: row.title,
				subtitle: row.subtitle,
				badge: row.badge,
			});
		}
	}
	return out;
}

export function StoreSearch({ active, query, onOpen }: StoreSearchProps) {
	const { target, url, token } = useCore();
	const theme = useTheme();

	const [all, setAll] = useState<Result[]>([]);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [index, setIndex] = useState(0);

	// Guard against a stale multi-realm load clobbering fresher data on node switch.
	const reqRef = useRef(0);

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		setError(null);
		Promise.all(
			SEARCH_REALMS.map((realm) =>
				realm.load(target).catch(() => [] as ListRow[])
			)
		)
			.then((lists) => {
				if (reqRef.current !== reqId) {
					return;
				}
				const byRealm = new Map<StoreSection, ListRow[]>();
				for (const [i, realm] of SEARCH_REALMS.entries()) {
					byRealm.set(realm.id, lists[i]);
				}
				setAll(buildResults(byRealm));
				setLoaded(true);
			})
			.catch((err: unknown) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setError(errText(err));
				setLoaded(true);
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});
	}, [target]);

	// Load once when the search first mounts, and again on a node switch (url/token).
	useEffect(() => {
		runLoad();
	}, [runLoad]);

	const needle = query.trim().toLowerCase();
	const results = all.filter((row) => matches(row, needle));

	// Keep the selection in range as the filtered set shrinks/grows.
	useEffect(() => {
		setIndex((i) =>
			results.length === 0 ? 0 : Math.min(i, results.length - 1)
		);
	}, [results.length]);

	useKeyboard((key) => {
		if (!active) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down" || key.name === "j") {
			setIndex((i) => Math.min(Math.max(0, results.length - 1), i + 1));
		} else if (key.name === "return") {
			const chosen = results[index];
			if (chosen) {
				onOpen(chosen.realm);
			}
		} else if (key.name === "r") {
			runLoad();
		}
	});

	if (loading && !loaded) {
		return <Loading label="Searching the store…" />;
	}
	if (error) {
		return <ErrorView message={error} />;
	}
	if (results.length === 0) {
		return (
			<box paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.mutedForeground}>
					{`No store matches for "${query.trim()}"`}
				</text>
			</box>
		);
	}

	// Window the flat list so the selection stays visible without a focus-capturing
	// scrollbox (which would fight the shell for arrow keys).
	const start = Math.max(
		0,
		Math.min(
			index - Math.floor(LIST_HEIGHT / 2),
			Math.max(0, results.length - LIST_HEIGHT)
		)
	);
	const visible = results.slice(start, start + LIST_HEIGHT);

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			{visible.map((row, i) => (
				<ResultRow
					key={row.id}
					row={row}
					selected={start + i === index}
					theme={theme}
				/>
			))}
			{results.length > visible.length ? (
				<text fg={theme.colors.mutedForeground}>
					{`${index + 1}/${results.length} · enter opens the realm`}
				</text>
			) : null}
		</box>
	);
}

type ThemeValue = ReturnType<typeof useTheme>;

function ResultRow({
	row,
	selected,
	theme,
}: {
	row: Result;
	selected: boolean;
	theme: ThemeValue;
}) {
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.muted}>
				{selected ? "›" : " "}
			</text>
			<Badge bordered={false} variant="secondary">
				{row.realmLabel}
			</Badge>
			<box flexDirection="column" flexGrow={1}>
				<box flexDirection="row" gap={1}>
					<text fg={selected ? theme.colors.primary : theme.colors.foreground}>
						{selected ? <b>{row.title}</b> : row.title}
					</text>
					{row.badge ? (
						<Badge bordered={false} variant="secondary">
							{row.badge}
						</Badge>
					) : null}
				</box>
				{row.subtitle ? (
					<text fg={theme.colors.mutedForeground}>{row.subtitle}</text>
				) : null}
			</box>
		</box>
	);
}
