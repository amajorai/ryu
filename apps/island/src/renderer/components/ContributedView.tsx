// The island SHELL around a plugin-contributed declarative view: `@ryu/blocks`'s
// `IslandViewPanel` renders the spec (import-type-only on `@ryu/app-host`), and this
// component owns everything that needs a privileged seam —
//   - **source fetch**: a `list-detail` spec with a declarative `source` is fetched
//     at mount (and after every successful action) through the main process's
//     authenticated Core client (`plugins:coreHttp` IPC; the renderer cannot reach
//     Core directly, CORS excludes Electron origins), then mapped to items via the
//     shared vocabulary helpers.
//   - **actions**: `action.http` runs the declarative CRUD tier over the same IPC
//     seam (with the optional `action.confirm` prompt first); anything else is
//     relayed to the owning app as a grant-gated `view.action` intent over the
//     plugin host bridge (`pluginHostInvoke`) — exactly the desktop
//     `PluginViewPage` split, adapted to island transport.
//
// apps/island may import `@ryu/app-host` at runtime (it already bundles the host
// for sandboxed companions); only `@ryu/blocks/island` must stay type-only.

import type {
	SourceItem,
	ViewAction,
	ViewActionContext,
} from "@ryu/app-host/views";
import { renderActionHttp, sourceItemsFromResponse } from "@ryu/app-host/views";
import { IslandViewPanel } from "@ryu/blocks/island/declarative-view";
import { useCallback, useEffect, useState } from "react";
import type { PluginView } from "../../shared/ipc.ts";
import { pluginHostInvoke } from "../host/island-plugin-host-invoke.ts";

export function ContributedView({ view }: { view: PluginView }) {
	// Bumped after a successful action so the source re-fetches and the view
	// re-renders from truth (mirrors the desktop `reloadToken`).
	const [reloadToken, setReloadToken] = useState(0);
	const [sourceItems, setSourceItems] = useState<SourceItem[] | null>(null);
	const source =
		view.spec?.view === "list-detail" ? view.spec.source : undefined;

	useEffect(() => {
		if (!source) {
			setSourceItems(null);
			return;
		}
		let cancelled = false;
		window.island.plugins
			.coreHttp({
				method: source.http.method ?? "GET",
				path: source.http.path,
			})
			.then((res) => {
				if (!cancelled) {
					setSourceItems(
						res.ok ? sourceItemsFromResponse(source, res.data) : []
					);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setSourceItems([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [source, reloadToken]);

	const runAction = useCallback(
		async (action: ViewAction, ctx: ViewActionContext) => {
			// biome-ignore lint/suspicious/noAlert: the v1 declarative confirm gate — a spec-declared destructive-action prompt.
			if (action.confirm && !window.confirm(action.confirm)) {
				return;
			}
			try {
				if (action.http) {
					// Declarative CRUD tier: template + execute via the main process's
					// authenticated Core client (renderActionHttp refuses non-/api/ paths).
					const rendered = renderActionHttp(action.http, ctx);
					const res = await window.island.plugins.coreHttp({
						method: rendered.method,
						path: rendered.path,
						body: rendered.body,
					});
					if (!res.ok) {
						throw new Error(res.message);
					}
				} else if (view.plugin) {
					// App-backed intent: relay over the plugin host bridge so it reaches
					// `POST /api/plugins/:id/host` (grant-gated `view.action` dispatch).
					await pluginHostInvoke(view.plugin, "view.action", {
						view_id: view.id,
						action_id: action.id,
						intent: action.intent ?? null,
						payload: action.payload ?? null,
						values: ctx.values ?? null,
						item: ctx.item ?? null,
					});
				}
				setReloadToken((n) => n + 1);
			} catch {
				// The overlay has no toast chrome; a failed action leaves the view
				// unchanged (the next source fetch re-renders from truth anyway).
			}
		},
		[view]
	);

	return (
		<IslandViewPanel
			onAction={(action, ctx) => {
				void runAction(action, ctx);
			}}
			sourceItems={sourceItems}
			view={view}
		/>
	);
}
