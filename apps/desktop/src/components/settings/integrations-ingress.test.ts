// apps/desktop/src/components/settings/integrations-ingress.test.ts
//
// The regression these tests exist for: the "Public base URL" input — the only
// in-app writer of the `webhook.ingress.url` pref — was rendered only while
// `own-relay` was the SELECTED backend, at the same time as Core started 400ing
// an `own-relay` selection made without that URL. Neither change was wrong on its
// own; composed, they made the pref unwritable from the app.
//
// Honest scope, stated up front: these cover the extracted DECISIONS, not the JSX
// that consumes them. `offersOwnRelay` takes only the offered-kinds list, so it is
// structurally incapable of reading the selection — asserting that it doesn't
// would be tautological, and no such test is written here. Re-wiring the render
// gate in `IntegrationsTab.tsx` back to the selected backend would still compile
// and still pass this file. That line is held by review and the type-check;
// closing it properly needs a render harness this repo does not have. What IS
// pinned here is everything that can be silently *wrong* rather than merely
// misplaced: which toast is true, whether Core's refusal text survives, and
// whether the Save gate can strand a retry.

import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	ingressErrorDescription,
	ingressSelectedToast,
	ingressUrlDirty,
	ingressUrlSavedToast,
	offersOwnRelay,
} from "./integrations-ingress.ts";

const tl: LiteralMessage = (source, values) => formatMessage(source, values);

const ALL_KINDS = [
	"ryu-relay",
	"tailscale-funnel",
	"cloudflared",
	"own-relay",
] as const;

describe("offersOwnRelay", () => {
	test("Core's real `available` payload shows the field", () => {
		// `webhook_ingress_get_backend` maps `IngressKind::ALL` with no filtering, so
		// this list is what every node sends regardless of which kind is selected —
		// which is why the field is now always reachable.
		expect(offersOwnRelay([...ALL_KINDS])).toBe(true);
	});

	test("hides the field when Core does not offer the self-hosted relay", () => {
		expect(offersOwnRelay(["ryu-relay", "cloudflared"])).toBe(false);
		expect(offersOwnRelay([])).toBe(false);
	});

	test("no ingress plane (null) hides the field", () => {
		expect(offersOwnRelay(null)).toBe(false);
	});

	test("accepts the `ownrelay` alias Core's FromStr also parses", () => {
		expect(offersOwnRelay(["ryu-relay", "ownrelay"])).toBe(true);
	});
});

describe("ingressUrlDirty", () => {
	test("nothing to save when the input matches the persisted value", () => {
		expect(ingressUrlDirty("", "")).toBe(false);
		expect(ingressUrlDirty("https://x.example", "https://x.example")).toBe(
			false
		);
	});

	test("whitespace-only edits are not edits — Save writes the trimmed form", () => {
		// The save handler persists `ingressUrl.trim()`, so comparing untrimmed
		// would leave the row permanently dirty after a save of "  https://x  ".
		expect(ingressUrlDirty("  https://x.example  ", "https://x.example")).toBe(
			false
		);
		expect(ingressUrlDirty("   ", "")).toBe(false);
	});

	test("typing, and clearing a saved value, both count", () => {
		expect(ingressUrlDirty("https://x.example", "")).toBe(true);
		expect(ingressUrlDirty("", "https://x.example")).toBe(true);
		expect(ingressUrlDirty("https://y.example", "https://x.example")).toBe(
			true
		);
	});

	test("a failed save keeps Save enabled so the write can be retried", () => {
		// The tab only advances its saved-value state on a successful
		// `setPreference`; a failure leaves it at the previous value. This is the
		// one way the disabled-Save gate could strand a user, so it is pinned.
		const typed = "https://x.example";
		const savedBeforeAttempt = "";
		expect(ingressUrlDirty(typed, savedBeforeAttempt)).toBe(true);
		// …and only a success clears it.
		expect(ingressUrlDirty(typed, typed)).toBe(false);
	});
});

describe("ingressSelectedToast", () => {
	test("never warns on success — Core's 400 already blocks the unusable case", () => {
		// The removed branch warned here. Reaching this state at all means Core
		// resolved a valid base, so a warning would fire exactly when nothing is
		// wrong. Levels are asserted across every kind so a reintroduced warning
		// fails loudly.
		for (const kind of ALL_KINDS) {
			expect(ingressSelectedToast(kind, true, "", tl).level).toBe("success");
			expect(
				ingressSelectedToast(kind, true, "https://x.example", tl).level
			).toBe("success");
		}
	});

	test("own-relay with an empty saved URL points at the out-of-app source", () => {
		const toast = ingressSelectedToast("own-relay", true, "   ", tl);
		expect(toast.level).toBe("success");
		expect(toast.title).toBe("Ingress set to Self-hosted relay");
		expect(toast.description).toContain("RYU_WEBHOOK_INGRESS_URL");
		// Hedged, not exclusive: the pref is writable from outside this tab too.
		expect(toast.description).toContain("most likely");
	});

	test("an unresolved pref read falls through to the generic success", () => {
		const toast = ingressSelectedToast("own-relay", false, "", tl);
		expect(toast.description).toBe(
			"Restart this node for the change to take effect."
		);
	});

	test("a saved URL gives the plain success, and other kinds never mention the env var", () => {
		expect(
			ingressSelectedToast("own-relay", true, "https://x.example", tl)
		).toEqual({
			level: "success",
			title: "Ingress set to Self-hosted relay",
			description: "Restart this node for the change to take effect.",
		});
		expect(
			ingressSelectedToast("ryu-relay", true, "", tl).description
		).not.toContain("RYU_WEBHOOK_INGRESS_URL");
	});
});

describe("ingressUrlSavedToast", () => {
	test("saving a URL succeeds quietly regardless of the active backend", () => {
		for (const kind of ALL_KINDS) {
			const toast = ingressUrlSavedToast("https://ryu.example.com", kind, tl);
			expect(toast.level).toBe("success");
			expect(toast.title).toBe("Public URL saved");
		}
	});

	test("clearing under a live own-relay backend still warns — nothing re-validates the pref", () => {
		const toast = ingressUrlSavedToast("", "own-relay", tl);
		expect(toast.level).toBe("warning");
		expect(toast.description).toContain("active backend");
	});

	test("clearing under any other backend must not claim the relay broke", () => {
		for (const kind of ["ryu-relay", "tailscale-funnel", "cloudflared"]) {
			const toast = ingressUrlSavedToast("  ", kind, tl);
			expect(toast.level).toBe("success");
			expect(toast.description).toContain("unaffected");
		}
		expect(ingressUrlSavedToast("", "ryu-relay", tl).description).toContain(
			"Ryu Relay (managed)"
		);
	});
});

describe("ingressErrorDescription", () => {
	test("surfaces Core's actionable 400 body, not the bare status line", () => {
		const body =
			"own-relay ingress needs a public base URL: set the `webhook.ingress.url` preference …";
		const description = ingressErrorDescription(
			new ApiError("/api/webhook-ingress/backend", 400, body)
		);
		expect(description).toBe(body);
		expect(description).not.toContain("failed: 400");
	});

	test("surfaces the 409 env-pin message too", () => {
		const body =
			"the RYU_WEBHOOK_INGRESS_URL environment variable pins this node's webhook ingress to 'own-relay' …";
		expect(
			ingressErrorDescription(
				new ApiError("/api/webhook-ingress/backend", 409, body)
			)
		).toBe(body);
	});

	test("falls back to the generic message when Core sent no error body", () => {
		expect(
			ingressErrorDescription(
				new ApiError("/api/webhook-ingress/backend", 500, undefined)
			)
		).toBe("/api/webhook-ingress/backend failed: 500");
		expect(
			ingressErrorDescription(
				new ApiError("/api/webhook-ingress/backend", 500, "   ")
			)
		).toBe("/api/webhook-ingress/backend failed: 500");
	});

	test("a non-Error rejection yields no description rather than '[object Object]'", () => {
		expect(ingressErrorDescription("boom")).toBeUndefined();
		expect(ingressErrorDescription(undefined)).toBeUndefined();
	});
});
