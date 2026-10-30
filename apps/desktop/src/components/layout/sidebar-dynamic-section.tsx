import { Package01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	DECLARATIVE_HTTP_GRANT,
	renderContributionActionHttp,
	renderTemplate,
	type SourceItem,
	sourceItemsFromResponse,
	type ViewActionHttp,
	type ViewSourceRow,
	viewSourceRowSchema,
} from "@ryu/app-host/views";
import { useLiteralMessages } from "@ryu/i18n/react";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { parseContributedTarget } from "@/src/contributions/contributed-target.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import { sidebarSectionQueryOptions } from "@/src/hooks/useSidebarSectionSource.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import { rowStamp } from "@/src/lib/sidebar/date-buckets.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { renderContributedSectionRows } from "./sidebar-dynamic-section-rows.tsx";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import type { SectionKey } from "./sidebar-sections.ts";
import {
	DateGroupedRows,
	dateBucketStorageKeys,
} from "./sidebar-subsection.tsx";
import { useContributedRowsFor } from "./tab-entity-menu.tsx";

/**
 * An app-REGISTERED sidebar section, rendered generically from a `sidebar_sections`
 * contribution (the dynamic counterpart to the hardcoded Canvas/Whiteboard/Meetings
 * sections). Its live rows come from the contribution's declared `spec.source` — a
 * same-origin, safe Core-relative read path the shell fetches through the
 * authenticated node seam, mapped via {@link sourceItemsFromResponse} — so nothing
 * is hardcoded per app. Clicking a row
 * opens `spec.itemTarget` (a `{{item.<key>}}` route template) via `openTab`. Returns
 * null when empty *unless* the spec declares an `emptyState`, mirroring
 * {@link AppsSection}, so a disabled/empty app never leaves a phantom header while a
 * section whose emptiness is meaningful ("nothing is running") can still say so.
 *
 * The fetch is a react-query read keyed by (node, path, method): several sections
 * sourcing the SAME endpoint — the common case once one app slices one feed with
 * `source.filter` — share a single request and a single `source.refreshMs` poll,
 * which a per-section `fetch` loop could not. The poll is suspended while the
 * section is collapsed; a create/delete invalidates the key rather than re-fetching
 * one section's copy of shared data.
 *
 * Exported so the e2e harness can mount it in isolation (see
 * `e2e/harness/contributed-section-story.tsx`) — the two-line row is a visual
 * contract a type-check cannot verify.
 */
export function DynamicSidebarSection({
	contribution,
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps & { contribution: PluginSidebarSection }) {
	const tl = useLiteralMessages();
	const openTab = useTabSelector((state) => state.openTab);
	const node = useActiveNode();
	const queryClient = useQueryClient();
	const spec = pluginSidebarSpec(contribution);
	const canUseDeclarativeHttp = (contribution.approved_grants ?? []).includes(
		DECLARATIVE_HTTP_GRANT
	);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [pendingCreate, setPendingCreate] = useState(false);
	const entityRowsFor = useContributedRowsFor(
		spec?.entity?.anchor ?? "",
		spec?.entity?.idKey ?? "id"
	);
	const source = spec?.source;
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);
	const sourceOptions = useMemo(
		() => sidebarSectionQueryOptions(contribution, target),
		[contribution, target]
	);
	const queryKey = sourceOptions.queryKey;
	const queryOptions = useMemo(
		() => ({
			...sourceOptions,
			refetchInterval: collapsed ? false : sourceOptions.refetchInterval,
		}),
		[collapsed, sourceOptions]
	);
	const { data: payload } = useQuery(queryOptions);

	const rows = useMemo(
		() => (source && payload ? sourceItemsFromResponse(source, payload) : []),
		[source, payload]
	);

	const reload = useCallback(
		() => queryClient.invalidateQueries({ queryKey }),
		[queryClient, queryKey]
	);

	// An app-registered section honours "Group lists by date" like the shell's own
	// lists do — the whole point of the preference being a sidebar primitive rather
	// than a property of the Chats section. The stamp comes from the spec's declared
	// `dateKey` when it has one, else from probing the stamp names Core already
	// serves, so a section authored before this existed groups without a manifest
	// edit. A row that resolves nothing lands in "Undated", never back-dated.
	const [groupByDate] = useChatDateGrouping();
	const contributedStamp = useCallback(
		(row: SourceItem) => rowStamp(row.raw, spec?.dateKey),
		[spec?.dateKey]
	);
	const contributedBucketKeys = dateBucketStorageKeys(
		`contributed:${contribution.plugin}:${contribution.id}`
	);

	const openTarget = (item: ViewSourceRow, title: string, forceNew = false) => {
		if (spec?.itemTarget) {
			// A contributed target may carry allowlisted query parameters that belong
			// in openTab's OPTIONS (a conversation id has no route of its own).
			const { path, options } = parseContributedTarget(
				renderTemplate(spec.itemTarget, { item }, { uriEncode: true })
			);
			const mountContext = spec.context
				? Object.fromEntries(
						Object.entries(spec.context).flatMap(([contextKey, rowKey]) => {
							const value = item[rowKey];
							return value === undefined || value === null
								? []
								: [[contextKey, value]];
						})
					)
				: undefined;
			const tabOptions: Parameters<typeof openTab>[1] = {
				...options,
				title,
				forceNew,
				icon: asGlyphValue(item.icon),
			};
			if (spec.context) {
				tabOptions.mountContext = mountContext ?? null;
			}
			openTab(path, tabOptions);
		}
	};

	const openTargetInNewWindow = (item: ViewSourceRow, title: string) => {
		if (!spec?.itemTarget) {
			return;
		}
		const { path, options } = parseContributedTarget(
			renderTemplate(spec.itemTarget, { item }, { uriEncode: true })
		);
		void openEntityInNewWindow({
			conversationId: options.conversationId,
			path,
			title,
		});
	};

	// Run a per-row `http` action (delete/…) templated with the row, then re-fetch.
	const runAction = async (http: ViewActionHttp, item: ViewSourceRow) => {
		if (!canUseDeclarativeHttp) {
			return;
		}
		const actionKey = `${http.method}:${http.path}:${String(item.id ?? "")}`;
		if (pendingAction === actionKey) {
			return;
		}
		setPendingAction(actionKey);
		try {
			const target = toTarget(node);
			const rendered = renderContributionActionHttp(contribution, http, {
				item,
			});
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: rendered.method,
				headers: await requestHeaders(target),
				body:
					rendered.body === undefined
						? undefined
						: JSON.stringify(rendered.body),
			});
			if (resp.ok) {
				await reload();
			}
		} catch {
			// best-effort
		} finally {
			setPendingAction((current) => (current === actionKey ? null : current));
		}
	};

	// The "+" create-and-open: POST the create request, read the new id from the
	// response (`targetFrom`) and open it via `itemTarget`; else just re-fetch.
	const runCreate = async () => {
		if (!spec?.create) {
			return;
		}
		if ("target" in spec.create && spec.create.target !== undefined) {
			const { path, options } = parseContributedTarget(spec.create.target);
			openTab(path, {
				...options,
				title:
					spec.create.label ?? tl("New {title}", { title: contribution.title }),
			});
			return;
		}
		if (!canUseDeclarativeHttp) {
			return;
		}
		if (pendingCreate) {
			return;
		}
		setPendingCreate(true);
		try {
			const target = toTarget(node);
			const rendered = renderContributionActionHttp(
				contribution,
				spec.create.http,
				{}
			);
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: rendered.method,
				headers: await requestHeaders(target),
				body:
					rendered.body === undefined
						? undefined
						: JSON.stringify(rendered.body),
			});
			if (!resp.ok) {
				return;
			}
			const created = viewSourceRowSchema.parse(await resp.json());
			const newId = spec.create.targetFrom
				? created[spec.create.targetFrom]
				: undefined;
			if (spec.itemTarget && newId !== undefined) {
				openTarget(
					created,
					String(created.title ?? created.name ?? "Untitled")
				);
			} else {
				await reload();
			}
		} catch {
			// best-effort
		} finally {
			setPendingCreate(false);
		}
	};

	// A section with nothing to list, no way to create AND nothing to say when empty
	// renders nothing (mirrors AppsSection) — no phantom header for a disabled/empty
	// app. An `emptyState` is the opt-in that keeps the header, for a section whose
	// emptiness is itself the answer.
	const canCreate = Boolean(
		spec?.create && ("target" in spec.create || canUseDeclarativeHttp)
	);
	if (rows.length === 0 && !(canCreate || spec?.emptyState)) {
		return null;
	}

	const sectionKey: SectionKey = `plugin:${contribution.plugin}:${contribution.id}`;
	const itemActions = canUseDeclarativeHttp ? (spec?.itemActions ?? []) : [];

	// "messaging" draws the avatar-led row the shell's own Agents section draws
	// (see MessagingAgentRowBody): a 20px round avatar, the title and a stamp on
	// one 32px line, the preview in the hover card. A section that declares it
	// keeps that shape for every row, including rows whose feed resolved no
	// picture.
	const messagingRows = spec?.rowStyle === "messaging";

	// One row of the contributed feed, extracted so the flat list and each date
	// bucket render the IDENTICAL row rather than a copy that drifts.
	const renderContributedRows = (list: SourceItem[]) =>
		renderContributedSectionRows(list, {
			contribution,
			entityRowsFor,
			itemActions,
			messagingRows,
			openTarget,
			openTargetInNewWindow,
			runAction,
			spec,
		});

	return (
		<SidebarSection
			action={
				canCreate && spec?.create ? (
					<SectionAddButton
						onClick={runCreate}
						title={
							spec.create.label ??
							tl("New {title}", { title: contribution.title })
						}
					/>
				) : undefined
			}
			collapsed={collapsed}
			dnd={dnd}
			iconNode={
				contribution.icon ? (
					<Icon
						className="size-3.5 shrink-0"
						icon={contribution.icon}
						size={14}
						tone="muted"
					/>
				) : (
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={Package01Icon}
					/>
				)
			}
			label={contribution.title}
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey={sectionKey}
			sort={sort}
		>
			{rows.length === 0 && spec?.emptyState ? (
				<div className="px-2 py-2">
					<p className="text-muted-foreground text-xs">
						{/* `null` is the queryFn's marker for a non-2xx answer (a route
						    gated behind a disabled app, a node that is down) — reporting
						    that as "nothing here" states something the shell never
						    learned. `undefined` is merely the in-flight first load. */}
						{payload === null && spec.emptyState.unavailable
							? spec.emptyState.unavailable
							: spec.emptyState.title}
					</p>
					{spec.emptyState.description && payload !== null ? (
						<p className="mt-0.5 text-muted-foreground/70 text-xs">
							{spec.emptyState.description}
						</p>
					) : null}
				</div>
			) : null}
			{groupByDate ? (
				<DateGroupedRows
					className="ml-2 space-y-0.5"
					collapsedKey={contributedBucketKeys.collapsedKey}
					items={rows}
					orderKey={contributedBucketKeys.orderKey}
					renderRows={renderContributedRows}
					stampOf={contributedStamp}
				/>
			) : (
				renderContributedRows(rows)
			)}
		</SidebarSection>
	);
}
