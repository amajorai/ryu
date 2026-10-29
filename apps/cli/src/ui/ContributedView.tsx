/* @jsxImportSource @opentui/react */
// The terminal SHELL around a plugin-contributed declarative view: src/ui/
// DeclarativeView.tsx draws the spec, and this component owns everything that
// needs the node's credentials —
//   - **source fetch**: a `list-detail` spec with a declarative `source` is fetched
//     at mount (and after every successful action) through the active Core node,
//     then mapped to items with the shared vocabulary helper. The spec never sees a
//     token, and `isCoreApiPath` refuses anything that is not a Core-relative
//     `/api/` path, so a manifest can never point these credentials elsewhere.
//   - **actions**: `action.http` runs the declarative CRUD tier (templated path +
//     body); anything else is relayed to the owning app as a grant-gated
//     `view.action` dispatch on `POST /api/plugins/:id/host` — exactly the split the
//     desktop `PluginViewPage` and the island `ContributedView` make, over the
//     terminal's own fetch seam.
//
// Failures go to the shared toast surface (the TUI's error convention) and leave the
// view on its last good data; the next reload re-renders from truth.

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "@ryuhq/core-client/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import type { ContributedView as ContributedViewModel } from "../core/contributions.ts";
import { useShellKeyboardCaptured } from "../core/InputFocusContext.tsx";
import type {
	SourceItem,
	ViewAction,
	ViewActionContext,
	ViewSource,
} from "../core/views.ts";
import {
	isCoreApiPath,
	renderActionHttp,
	sourceItemsFromResponse,
	viewSpecSchema,
} from "../core/views.ts";
import { tf } from "../i18n/translate.ts";
import { useOverlay } from "../overlays/OverlayHost.tsx";
import { DeclarativeView } from "./DeclarativeView.tsx";
import { useToast } from "./toast.tsx";

const coreViewPayloadSchema = z.json();
type CoreViewPayload = z.infer<typeof coreViewPayloadSchema>;

/** GET/POST a Core-relative path with the active node's credentials, returning the
 *  parsed JSON body. Refuses a path outside `/api/` before a request is made. */
async function coreJson(
	target: ApiTarget,
	method: string,
	path: string,
	body?: Parameters<typeof JSON.stringify>[0]
): Promise<CoreViewPayload> {
	if (!isCoreApiPath(path)) {
		throw new Error(`declarative view path must start with /api/: ${path}`);
	}
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method,
		headers: makeHeaders(target.token, target.userJwt),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!resp.ok) {
		throw new Error(`${path} failed: ${resp.status}`);
	}
	// A 204 / empty body is a perfectly good action result; don't fail on it.
	const text = await resp.text();
	return text.length > 0 ? coreViewPayloadSchema.parse(JSON.parse(text)) : null;
}

export interface ContributedViewProps {
	/** True while this view owns the keyboard (active tab of the focused pane). */
	focused: boolean;
	view: ContributedViewModel;
}

/** Render one contributed view against the active node. */
export function ContributedViewPanel({ focused, view }: ContributedViewProps) {
	const { target, url, token } = useCore();
	const { notify } = useToast();
	const theme = useTheme();
	// Every mounted useKeyboard sees every key, so the view yields while the
	// palette, node picker, sidebar focus mode or a shell overlay owns them
	// (otherwise Enter in the sidebar would also fire the view's primary action).
	const shellKeyboardCaptured = useShellKeyboardCaptured();
	const { openId: overlayOpenId } = useOverlay();
	const keysActive =
		focused && !shellKeyboardCaptured && overlayOpenId === null;
	// Bumped after a successful action so the source re-fetches and the view
	// re-renders from truth (mirrors the desktop/island `reloadToken`).
	const [reloadToken, setReloadToken] = useState(0);
	const [sourceItems, setSourceItems] = useState<SourceItem[] | null>(null);

	const parsedSpec = useMemo(
		() => viewSpecSchema.safeParse(view.spec),
		[view.spec]
	);
	const source: ViewSource | undefined =
		parsedSpec.success && parsedSpec.data.view === "list-detail"
			? parsedSpec.data.source
			: undefined;

	useEffect(() => {
		if (!source) {
			setSourceItems(null);
			return;
		}
		let cancelled = false;
		coreJson(target, source.http.method ?? "GET", source.http.path)
			.then((payload) => {
				if (!cancelled) {
					setSourceItems(sourceItemsFromResponse(source, payload));
				}
			})
			.catch(() => {
				// A failed source read degrades to the spec's empty state rather than
				// an error screen — the view itself is still valid.
				if (!cancelled) {
					setSourceItems([]);
				}
			});
		return () => {
			cancelled = true;
		};
		// url/token are primitives; including them refetches on a node switch.
	}, [source, target, url, token, reloadToken]);

	const runAction = useCallback(
		async (action: ViewAction, ctx: ViewActionContext) => {
			try {
				if (action.http) {
					const rendered = renderActionHttp(action.http, ctx);
					await coreJson(target, rendered.method, rendered.path, rendered.body);
				} else if (view.plugin.length > 0) {
					// App-backed intent: the grant-gated `view.action` dispatch on the
					// plugin host bridge. Core-client exposes no host-invoke helper, so
					// it is POSTed with the shared primitives (the `{method, args}`
					// envelope the bridge expects).
					await coreJson(
						target,
						"POST",
						`/api/plugins/${encodeURIComponent(view.plugin)}/host`,
						{
							method: "view.action",
							args: {
								view_id: view.id,
								action_id: action.id,
								intent: action.intent ?? null,
								payload: action.payload ?? null,
								values: ctx.values ?? null,
								item: ctx.item ?? null,
							},
						}
					);
				}
				setReloadToken((n) => n + 1);
			} catch (err) {
				notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
		[target, view, notify]
	);

	if (!view.spec) {
		// A title-only manifest entry (or a spec in a shape this shell cannot read).
		return (
			<text fg={theme.colors.mutedForeground}>
				{tf("{viewTitle}: view unavailable", {
					viewTitle: view.title ?? view.id,
				})}
			</text>
		);
	}

	return (
		<DeclarativeView
			focused={keysActive}
			onAction={(action, ctx) => {
				void runAction(action, { ...ctx, viewId: view.id });
			}}
			onReload={() => setReloadToken((n) => n + 1)}
			sourceItems={sourceItems}
			spec={view.spec}
		/>
	);
}
