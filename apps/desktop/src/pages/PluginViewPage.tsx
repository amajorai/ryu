// The desktop surface for a plugin-contributed **declarative view** (the Raycast
// tier). A plugin declares `contributes.views[]` in its manifest; Core serves them
// via `GET /api/plugins/contributions` tagged with the owning plugin id, and this
// page resolves one by `pluginId`+`viewId` and renders its `spec` with the host's
// own `@ryu/ui` components through `DeclarativeView`. No plugin code runs — the app
// returned DATA, the shell owns the pixels.
//
// This page also OWNS what an action means:
//   - `action.http` present → the declarative CRUD tier: the templated request runs
//     against Core through the host's authenticated fetch seam (with an optional
//     `action.confirm` prompt first). Works with zero per-app sidecar code.
//   - otherwise → the intent is relayed to the owning app over the plugin host
//     bridge as a `view.action` dispatch (grant-gated Core-side).
// Either way, a successful action re-fetches the view's `source` and invalidates
// the plugin-contributions query so the rendered view reflects the new state.

import type {
	ViewAction,
	ViewActionContext,
	ViewSpec,
} from "@ryu/app-host/views";
import {
	contributionSourceRequest,
	DECLARATIVE_HTTP_GRANT,
	isCoreReadPath,
	isViewSourceHttpMethod,
	renderContributionActionHttp,
} from "@ryu/app-host/views";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { toast } from "@ryu/ui/components/sileo";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
	DeclarativeView,
	type ViewSourceFetcher,
} from "@/src/components/views/DeclarativeView.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";

export default function PluginViewPage({
	pluginId,
	viewId,
}: {
	pluginId: string;
	viewId: string;
}) {
	const { views } = usePluginContributions();
	const { openTab } = useTabsContext();
	const node = useActiveNode();
	const queryClient = useQueryClient();
	const [reloadToken, setReloadToken] = useState(0);
	const contribution = useMemo(
		() => views.find((v) => v.plugin === pluginId && v.id === viewId),
		[views, pluginId, viewId]
	);

	// The host's authenticated Core seam a `source`-carrying view fetches through.
	// Same node/token plumbing as every typed api module; the spec never sees it.
	const fetchJson = useCallback<ViewSourceFetcher>(
		async (method, path) => {
			if (
				!(
					(contribution?.approved_grants ?? []).includes(
						DECLARATIVE_HTTP_GRANT
					) &&
					isViewSourceHttpMethod(method) &&
					isCoreReadPath(path)
				)
			) {
				throw new Error(
					`view source path is not a safe node read path: ${path}`
				);
			}
			const sourceRequest = contributionSourceRequest(
				{
					http_policy: contribution?.http_policy,
					plugin: contribution?.plugin ?? pluginId,
				},
				{ http: { method, path } }
			);
			if (!sourceRequest) {
				throw new Error(
					`view source is outside its owning app authority: ${path}`
				);
			}
			const target = toTarget(node);
			const resp = await fetch(apiUrl(target, sourceRequest.path), {
				method: sourceRequest.method,
				headers: await requestHeaders(target),
			});
			if (!resp.ok) {
				throw new Error(`${path} failed: ${resp.status}`);
			}
			return resp.json();
		},
		[
			node,
			contribution?.http_policy,
			contribution?.plugin,
			contribution,
			pluginId,
		]
	);

	const handleAction = useCallback(
		async (action: ViewAction, ctx: ViewActionContext) => {
			// biome-ignore lint/suspicious/noAlert: the v1 declarative confirm gate — a spec-declared destructive-action prompt.
			if (action.confirm && !window.confirm(action.confirm)) {
				return;
			}
			const target = toTarget(node);
			try {
				if (action.http) {
					if (
						!(contribution?.approved_grants ?? []).includes(
							DECLARATIVE_HTTP_GRANT
						)
					) {
						throw new Error("This view does not have declarative HTTP access.");
					}
					// Declarative CRUD tier: template + execute against Core directly.
					const rendered = renderContributionActionHttp(
						{
							http_policy: contribution?.http_policy,
							plugin: contribution?.plugin ?? pluginId,
						},
						action.http,
						{ ...ctx, viewId }
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
						throw new Error(`${rendered.path} failed: ${resp.status}`);
					}
				} else {
					// App-backed intent: relay over the plugin host bridge so it reaches
					// `POST /api/plugins/:id/host` (grant-gated `view.action` dispatch).
					await pluginHostInvoke(target, pluginId, "view.action", {
						view_id: viewId,
						action_id: action.id,
						intent: action.intent ?? null,
						payload: action.payload ?? null,
						values: ctx.values ?? null,
						item: ctx.item ?? null,
					});
				}
				// Re-render from truth: bump the source re-fetch and invalidate the
				// contributions query (a spec-provider may have re-emitted the view).
				setReloadToken((n) => n + 1);
				await queryClient.invalidateQueries({
					queryKey: ["plugin-contributions"],
				});
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Action failed");
			}
		},
		[contribution, node, pluginId, queryClient, viewId]
	);

	if (!contribution?.spec) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>View unavailable</EmptyTitle>
					<EmptyDescription>
						The app that provides this view is unavailable or disabled.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={() => openTab("/apps", { title: "Apps" })} size="sm">
						Open Apps
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div className="mx-auto max-w-3xl p-6">
			{contribution.title ? (
				<h2 className="mb-4 font-medium text-lg">{contribution.title}</h2>
			) : null}
			<DeclarativeView
				fetchJson={fetchJson}
				onAction={(action, ctx) => {
					void handleAction(action, { ...ctx, viewId });
				}}
				reloadToken={reloadToken}
				spec={contribution.spec as ViewSpec}
			/>
		</div>
	);
}
