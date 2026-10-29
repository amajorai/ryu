// The webhook-ingress decisions the Integrations tab makes, extracted so they can
// be unit-tested. `IntegrationsTab.tsx` is a React component and this repo has no
// component-test harness (the same reason `ingressLabel`/`isOwnRelayKind` live in
// `lib/api/mesh.ts`), so anything that can be *wrong* rather than merely rendered
// belongs here — this file mirrors the `plugin-composer-controls.ts` precedent.
//
// ## Why this module exists at all: a crossed request between two changes
//
// Two independently-correct changes composed into an unreachable state:
//
//   1. the desktop gained a "Public base URL" input — the ONLY in-app writer of
//      the `webhook.ingress.url` pref — rendered only while `own-relay` was the
//      *selected* backend;
//   2. Core's `POST /api/webhook-ingress/backend` (`apps/core/src/server/mod.rs`,
//      handler `webhook_ingress_set_backend`) began rejecting an `own-relay`
//      selection with **400** when neither `RYU_WEBHOOK_INGRESS_URL` nor that
//      pref holds an absolute http(s) URL (`webhook_ingress::own_relay_rejection`).
//
// `request()` throws on non-2xx, so the tab reverted the picker and the input
// disappeared again. On a node without the env var the writer of the pref sat
// behind a state the client could no longer enter: the gate was unsatisfiable
// from the UI, leaving `curl -X PUT /api/preferences/webhook.ingress.url` as the
// only route. Core's 400 is correct and stays — it is what stops the tab from
// toasting success over an ingress that can never receive a webhook. The fix is
// on this side: make the prerequisite settable BEFORE the selection that needs it.
//
// ## The dependency this file has on Core (read, not assumed)
//
// [`offersOwnRelay`] keys the input's visibility off the *offered* backends
// (`available` from `GET /api/webhook-ingress/backend`), never off the selected
// one. Today `webhook_ingress_get_backend` maps `IngressKind::ALL` with no
// filtering, so `own-relay` is always offered and the input always renders. If
// Core ever filters `available` (say, hiding backends whose prerequisites are
// missing) this shape degrades the right way — the input disappears exactly when
// the option it configures does — whereas a hardcoded `true` would strand it.

import { ApiError } from "@/src/lib/api/client.ts";
import { ingressLabel, isOwnRelayKind } from "@/src/lib/api/mesh.ts";

/** A toast the tab should raise, resolved from state rather than built inline. */
export interface IngressToast {
	description?: string;
	/** Maps 1:1 onto the `sileo.<level>` helper the caller invokes. */
	level: "success" | "warning";
	title: string;
}

/**
 * Whether the "Public base URL" input should render — i.e. whether the picker
 * OFFERS the self-hosted relay, not whether it is currently selected.
 *
 * This predicate is the whole fix. Gating on the selected backend made the pref's
 * only writer reachable solely from a state Core now refuses to enter; gating on
 * the offered set makes the prerequisite configurable first, which is the order
 * Core's selection gate requires.
 *
 * `null` (an older Core with no ingress plane, or an unreachable one) is false:
 * the enclosing section is hidden in that case anyway.
 */
export function offersOwnRelay(choices: readonly string[] | null): boolean {
	return choices?.some(isOwnRelayKind) ?? false;
}

/**
 * Whether the typed public URL differs from the one currently persisted, i.e.
 * whether there is anything for Save to write.
 *
 * Core's own-relay gate reads the PERSISTED pref, never the input, so
 * "typed but not saved" is a state a user can be refused for while looking at the
 * URL they just entered. The tab shows this rather than auto-saving on selection:
 * an implicit write on a gesture aimed at the picker could persist a half-typed
 * value AND still fail the POST, leaving two divergent states from one click.
 *
 * Both sides are trimmed, matching what the save handler actually writes — so
 * saving `" https://x "` does not leave the row permanently dirty against the
 * stored `https://x`.
 *
 * The retry path this must not break: a failed `setPreference` leaves the saved
 * value untouched, so this stays true, Save stays enabled, and the user can try
 * again without retyping. Only a successful write clears it.
 */
export function ingressUrlDirty(typed: string, saved: string): boolean {
	return typed.trim() !== saved.trim();
}

/**
 * The toast for a *successful* `POST /api/webhook-ingress/backend`.
 *
 * The branch that used to live here warned "Ingress set to … — no public URL
 * saved" whenever own-relay was selected with an empty URL field. Core's 400 gate
 * made that branch unreachable in its primary case: the POST cannot succeed for
 * own-relay unless `resolve_own_relay_base(env, pref)` yields an absolute URL. So
 * the one surviving path — success with an empty local field — is the *opposite*
 * of what it claimed: a URL exists, it just did not come from this tab. Warning
 * there would fire precisely when nothing is wrong.
 *
 * The replacement states what is knowable and no more. An empty `urlValue` is
 * evidence the pref was empty when this tab mounted, not proof of exclusivity —
 * the pref is also writable by `PUT /api/preferences/…` from outside the app — so
 * the copy names `RYU_WEBHOOK_INGRESS_URL` as the likely source without asserting
 * it is the only one. When the pref read has not resolved (`urlLoaded` false) we
 * know nothing about the field, so we fall through to the generic success, which
 * is true either way.
 */
export function ingressSelectedToast(
	kind: string,
	urlLoaded: boolean,
	urlValue: string
): IngressToast {
	const title = `Ingress set to ${ingressLabel(kind)}`;
	const restart = "Restart this node for the change to take effect.";
	if (isOwnRelayKind(kind) && urlLoaded && urlValue.trim().length === 0) {
		return {
			level: "success",
			title,
			description: `This node accepted the selection, so its public URL is configured outside this tab — most likely RYU_WEBHOOK_INGRESS_URL in its environment. ${restart}`,
		};
	}
	return { level: "success", title, description: restart };
}

/**
 * The toast for a successful write of the `webhook.ingress.url` pref.
 *
 * Split by the active backend because the input is now always visible: with the
 * old always-selected gate, clearing it could only happen while own-relay was
 * live, so a single "the self-hosted relay has no address" warning was accurate.
 * It no longer is — most clears will now happen while Ryu Relay is the active
 * backend, where nothing at all breaks and that sentence is simply wrong.
 *
 * Nothing re-validates this pref on write: `own_relay_rejection` runs only on the
 * backend POST (its doc says so explicitly, and no read path calls it). So
 * clearing the URL under a live own-relay backend really does leave the ingress
 * to fail at the next `start()` — that warning stays, and stays reachable.
 */
export function ingressUrlSavedToast(
	urlValue: string,
	activeBackend: string
): IngressToast {
	if (urlValue.trim().length > 0) {
		return {
			level: "success",
			title: "Public URL saved",
			description: "Restart this node for the change to take effect.",
		};
	}
	if (isOwnRelayKind(activeBackend)) {
		return {
			level: "warning",
			title: "Public URL cleared",
			description:
				"Self-hosted relay is the active backend and now has no address of its own. Unless RYU_WEBHOOK_INGRESS_URL is set in this node's environment, inbound webhooks stop arriving after the next restart.",
		};
	}
	return {
		level: "success",
		title: "Public URL cleared",
		description: `${ingressLabel(activeBackend)} is unaffected — Self-hosted relay simply cannot be selected until a URL is saved here.`,
	};
}

/**
 * The description for a failed ingress request: Core's own `{"error": "…"}` text
 * when there is one, falling back to the generic message.
 *
 * `ApiError.message` is only `"/api/webhook-ingress/backend failed: 400"`, which
 * tells an operator nothing they can act on. The actionable text is carried
 * separately in `serverMessage`, and `setIngressBackend`'s doc in `lib/api/mesh.ts`
 * already instructs callers to surface it verbatim — this honours that contract
 * rather than inventing one. It is what turns both refusals into instructions:
 * the 400 names the pref and the env var to set, and the 409 (env pins the node to
 * own-relay) names the variable to unset.
 */
export function ingressErrorDescription<TError>(
	error: TError
): string | undefined {
	if (error instanceof ApiError) {
		const server = error.serverMessage?.trim();
		if (server) {
			return server;
		}
	}
	return error instanceof Error ? error.message : undefined;
}
