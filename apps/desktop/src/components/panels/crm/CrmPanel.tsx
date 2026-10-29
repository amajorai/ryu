// The workspace Harbor panel — an object-first CRM driven entirely by the
// `@ryu/crm` app's sidecar.
//
// This is a `panel: "native"` dock contribution (the `@ryu/browser` /
// `@ryu/simulator` / `@ryu/ugc` precedent), not a sandboxed companion: a companion
// frame runs under CSP `connect-src 'none'` and could only reach the sidecar
// through per-app RPC verbs in Core, which is exactly the per-app coupling an
// apps-store satellite must not require. It would also have been unable to import
// `@ryu/ui`, which for a CRM means hand-rolling the data grid. A native panel just
// fetches the sidecar's public mount and uses the real design system.
//
// Everything below is driven by the SCHEMA the sidecar returns, not by a fixed set
// of screens: the rail lists whatever objects exist (including ones a user
// invented), and the grid, board and detail views read their columns off that same
// schema. There is no `if (object === "company")` anywhere in this panel, and that
// is the product.

import {
	ChartLineData01Icon,
	CopyIcon,
	DatabaseIcon,
	PlusSignIcon,
	RefreshIcon,
	Search01Icon,
	Settings01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardView } from "@/src/components/panels/crm/BoardView.tsx";
import { Duplicates } from "@/src/components/panels/crm/Duplicates.tsx";
import { ImportWizard } from "@/src/components/panels/crm/ImportWizard.tsx";
import { Insights } from "@/src/components/panels/crm/Insights.tsx";
import { RecordDetail } from "@/src/components/panels/crm/RecordDetail.tsx";
import { RecordTable } from "@/src/components/panels/crm/RecordTable.tsx";
import { SchemaEditor } from "@/src/components/panels/crm/SchemaEditor.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	CRM_PLUGIN_ID,
	createCrmClient,
	type ObjectWithFields,
	type SchemaResponse,
	type SearchHit,
	type View,
} from "@/src/lib/api/crm.ts";

/** What the main area is showing. A record detail is a MODE, not a route, because
 *  this panel is a workspace tab with no URL of its own. */
type Mode =
	| { kind: "import" }
	| { kind: "list" }
	| { kind: "record"; recordId: string }
	| { kind: "duplicates" }
	| { kind: "insights" }
	| { kind: "schema" };

export function CrmPanel() {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const { apps } = useApps();

	// Re-bind when the node changes; a stale client would query the node the user
	// just switched away from.
	const client = useMemo(() => createCrmClient(toTarget(node)), [node]);

	const [schema, setSchema] = useState<SchemaResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [objectSlug, setObjectSlug] = useState<string | null>(null);
	const [viewId, setViewId] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>({ kind: "list" });
	const [search, setSearch] = useState("");
	const creatingRef = useRef(false);
	const [creating, setCreating] = useState(false);
	const [hits, setHits] = useState<SearchHit[] | null>(null);

	// Feature detection, exactly like the sibling dock panels: a disabled app gets
	// an enable hint instead of a panel hammering a sidecar that is not running.
	const enabled = useMemo(
		() => apps?.some((app) => app.id === CRM_PLUGIN_ID && app.enabled) ?? false,
		[apps]
	);

	const loadSchema = useCallback(
		(signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			return client
				.getSchema(signal)
				.then((next) => {
					if (signal?.aborted) {
						return;
					}
					setSchema(next);
					setObjectSlug((current) =>
						next.objects.some((entry) => entry.object.slug === current)
							? current
							: (next.objects[0]?.object.slug ?? null)
					);
				})
				.catch((cause) => {
					if (signal?.aborted) {
						return;
					}
					setError(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => {
					if (!signal?.aborted) {
						setLoading(false);
					}
				});
		},
		[client]
	);

	useEffect(() => {
		if (!enabled) {
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		void loadSchema(controller.signal);
		return () => controller.abort();
	}, [enabled, loadSchema]);

	const subject = useMemo<ObjectWithFields | undefined>(
		() => schema?.objects.find((entry) => entry.object.slug === objectSlug),
		[objectSlug, schema?.objects]
	);

	const objectsBySlug = useMemo(() => {
		const map = new Map<string, ObjectWithFields>();
		for (const entry of schema?.objects ?? []) {
			map.set(entry.object.slug, entry);
		}
		return map;
	}, [schema?.objects]);

	const view = useMemo<View | undefined>(() => {
		if (!subject) {
			return undefined;
		}
		return (
			subject.views.find((candidate) => candidate.id === viewId) ??
			subject.views.find((candidate) => candidate.is_default) ??
			subject.views[0]
		);
	}, [subject, viewId]);

	// Global search runs against the FTS5 index across every object, so it is a
	// distinct thing from the per-view text narrowing the grid applies. Debounced
	// so typing does not issue a query per keystroke.
	useEffect(() => {
		const needle = search.trim();
		setHits(null);
		if (needle.length < 2) {
			setHits(null);
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			client
				.search(needle, undefined, controller.signal)
				.then((response) => {
					if (!controller.signal.aborted) {
						setHits(response.hits);
					}
				})
				.catch(() => {
					// A failed search leaves the grid's own filtering in place rather
					// than surfacing an error over the whole panel.
				});
		}, 250);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [client, search]);

	const createRecord = async () => {
		if (!subject || creatingRef.current) {
			return;
		}
		creatingRef.current = true;
		setCreating(true);
		setError(null);
		try {
			const created = await client.createRecord(subject.object.slug, {});
			setMode({ kind: "record", recordId: created.id });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			creatingRef.current = false;
			setCreating(false);
		}
	};

	if (!enabled) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
				<HugeiconsIcon
					className="text-muted-foreground"
					icon={UserGroupIcon}
					size={28}
				/>
				<p className="font-medium text-sm">Harbor is not enabled</p>
				<p className="max-w-sm text-muted-foreground text-xs">
					Enable the Harbor app to run a CRM on this node. It stores everything
					in one local SQLite database the node owns.
				</p>
			</div>
		);
	}

	if (loading && !schema) {
		return (
			<div className="space-y-3 p-4">
				<Skeleton className="h-7 w-48" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (error && !schema) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
				<p className="text-muted-foreground text-sm">{error}</p>
				<Button onClick={() => void loadSchema()} size="sm" variant="ghost">
					<HugeiconsIcon icon={RefreshIcon} size={14} />
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0">
			{/* Object + view rail */}
			<nav
				aria-label="CRM objects and views"
				className="flex w-52 shrink-0 flex-col border-r bg-muted/20"
			>
				<div className="border-b p-2">
					<div className="relative">
						<HugeiconsIcon
							className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
							size={14}
						/>
						<Input
							aria-label="Search all records"
							leadingAdornment="search-icon"
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search everything…"
							value={search}
						/>
					</div>
				</div>

				<div className="scroll-fade min-h-0 flex-1 overflow-y-auto p-2">
					{hits ? (
						<div>
							<h2 className="mb-1 px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
								{tl("{resultCount, plural, one {# result} other {# results}}", {
									resultCount: hits.length,
								})}
							</h2>
							<ul className="space-y-0.5">
								{hits.map((hit) => (
									<li key={hit.record_id}>
										<button
											className="w-full rounded px-2 py-1 text-left hover:bg-muted"
											onClick={() => {
												setObjectSlug(hit.object_slug);
												setMode({
													kind: "record",
													recordId: hit.record_id,
												});
											}}
											type="button"
										>
											<div className="truncate text-sm" title={hit.title}>
												{hit.title}
											</div>
											<div className="truncate text-muted-foreground text-xs">
												{hit.object_slug} · {hit.snippet}
											</div>
										</button>
									</li>
								))}
								{hits.length === 0 && (
									<li className="px-2 py-3 text-muted-foreground text-xs">
										Nothing matched.
									</li>
								)}
							</ul>
						</div>
					) : (
						<ul className="space-y-2">
							{(schema?.objects ?? []).map((entry) => {
								const active = entry.object.slug === objectSlug;
								return (
									<li key={entry.object.id}>
										<button
											className={cn(
												"flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted",
												active && "bg-muted font-medium"
											)}
											onClick={() => {
												setObjectSlug(entry.object.slug);
												setViewId(null);
												setMode({ kind: "list" });
											}}
											type="button"
										>
											<span
												className="truncate capitalize"
												title={entry.object.plural}
											>
												{entry.object.plural}
											</span>
											<Badge typography="normal" variant="secondary">
												{entry.record_count}
											</Badge>
										</button>
										{active && entry.views.length > 0 && (
											<ul className="mt-0.5 ml-2 space-y-0.5 border-l pl-2">
												{entry.views.map((candidate) => (
													<li key={candidate.id}>
														<button
															className={cn(
																"w-full truncate rounded px-2 py-0.5 text-left text-xs hover:bg-muted",
																candidate.id === view?.id &&
																	"bg-muted font-medium"
															)}
															onClick={() => {
																setViewId(candidate.id);
																setMode({ kind: "list" });
															}}
															type="button"
														>
															{candidate.name}
															<span className="ml-1 text-muted-foreground">
																{candidate.kind === "board" ? "▤" : "▦"}
															</span>
														</button>
													</li>
												))}
											</ul>
										)}
									</li>
								);
							})}
						</ul>
					)}
				</div>

				<div className="border-t p-2">
					<Button
						className="w-full justify-start"
						onClick={() => setMode({ kind: "insights" })}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon icon={ChartLineData01Icon} size={14} />
						Follow-ups & pipeline
					</Button>
					<Button
						className="w-full justify-start"
						onClick={() => setMode({ kind: "duplicates" })}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon icon={CopyIcon} size={14} />
						Find duplicates
					</Button>
					<Button
						className="w-full justify-start"
						onClick={() => setMode({ kind: "schema" })}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon icon={Settings01Icon} size={14} />
						Edit schema
					</Button>
					<Button
						className="w-full justify-start"
						onClick={() => setMode({ kind: "import" })}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon icon={DatabaseIcon} size={14} />
						Import CSV
					</Button>
					<Button
						className="w-full justify-start"
						disabled={creating}
						onClick={() => void createRecord()}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon icon={PlusSignIcon} size={14} />
						New record
					</Button>
				</div>
			</nav>

			{/* Main area */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{error && schema && (
					<div
						className="border-b bg-destructive/10 px-3 py-2 text-status-destructive text-xs"
						role="alert"
					>
						{error}
					</div>
				)}
				{subject ? (
					mode.kind === "insights" ? (
						<Insights
							client={client}
							onOpenRecord={(recordId) => setMode({ kind: "record", recordId })}
						/>
					) : mode.kind === "duplicates" ? (
						<Duplicates
							client={client}
							onOpenRecord={(recordId) => setMode({ kind: "record", recordId })}
							subject={subject}
						/>
					) : mode.kind === "schema" ? (
						<SchemaEditor
							client={client}
							objects={schema?.objects ?? []}
							onChanged={() => void loadSchema()}
							subject={subject}
						/>
					) : mode.kind === "import" ? (
						<ImportWizard
							client={client}
							onDone={() => void loadSchema()}
							subject={subject}
						/>
					) : mode.kind === "record" ? (
						<RecordDetail
							client={client}
							objectsBySlug={objectsBySlug}
							onBack={() => setMode({ kind: "list" })}
							onOpenRecord={(recordId, relatedObjectSlug) => {
								if (relatedObjectSlug) {
									setObjectSlug(relatedObjectSlug);
								}
								setMode({ kind: "record", recordId });
							}}
							recordId={mode.recordId}
							subject={subject}
						/>
					) : view?.kind === "board" ? (
						<BoardView
							client={client}
							onOpenRecord={(recordId) => setMode({ kind: "record", recordId })}
							search={hits ? "" : search}
							subject={subject}
							view={view}
						/>
					) : (
						<RecordTable
							client={client}
							onOpenRecord={(recordId) => setMode({ kind: "record", recordId })}
							onRequestCreate={() => void createRecord()}
							search={hits ? "" : search}
							subject={subject}
							view={view}
						/>
					)
				) : (
					<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
						This node has no CRM objects yet.
					</div>
				)}
			</div>
		</div>
	);
}
