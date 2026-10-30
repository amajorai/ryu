// apps/desktop/src/components/settings/NetworkSettings-managed-inference.tsx
//
// Managed inference card for a self-hosted node (split out of
// NetworkSettings.tsx, which re-exports `ManagedInferenceSettings`).

import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import {
	useNetworkLifetime,
	useNetworkOwner,
	useNetworkTarget,
	waitForNetworkWrites,
	writeNetworkResource,
} from "./NetworkSettings-network-resource.ts";
import { NetworkReadError } from "./NetworkSettings-read-error.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * Pref keys Core resolves the managed-inference fleet from. Mirrors
 * `MANAGED_FLEET_URL_PREF_KEY` / `MANAGED_FLEET_TOKEN_PREF_KEY` in
 * `apps/core/src/sidecar/gateway.rs` — they must stay in lockstep.
 */
const MANAGED_GATEWAY_URL_PREF = "managed-gateway-url";
const MANAGED_GATEWAY_TOKEN_PREF = "managed-gateway-token";

/**
 * Managed inference on a node the user hosts themselves.
 *
 * The "Ryu (managed)" provider is billed against the org's plan credits, so it
 * must reach the HOSTED gateway fleet — the fleet is what holds the pooled
 * provider keys and enforces the org's budget. A local gateway holds neither.
 *
 * Without these two values the managed provider silently fell back to this
 * node's own keyless gateway, so a self-hosted user could not spend the plan
 * they were paying for. Both are required: a URL with no token is refused
 * rather than sent, because the fleet would 401 it anyway.
 *
 * BYOK providers are unaffected — they keep using the local gateway, so one node
 * runs both planes.
 */
export function ManagedInferenceSettings() {
	const target = useNetworkTarget();
	const lifetime = useNetworkLifetime(target);
	return <ManagedInferenceSettingsForNode key={lifetime} target={target} />;
}

function ManagedInferenceSettingsForNode({ target }: { target: ApiTarget }) {
	const active = useNetworkOwner();
	const [readError, setReadError] = useState<string | null>(null);
	const [readAttempt, setReadAttempt] = useState(0);
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	// Server-driven ROLLOUT gate: lets managed inference on a self-hosted node be
	// switched on centrally once a build carrying this code is out, with no
	// further ship. Default OFF (`failMode: "closed"` in the catalog).
	//
	// BE PRECISE ABOUT WHAT THIS PROTECTS: it is a DISCOVERY gate, not a money
	// control. Hiding the card does not stop spend — the prefs persist and Core
	// keeps resolving the fleet from them — and showing it does not enable spend:
	// minting an `rgw_` key is 402-gated by `managedInferenceAvailableForOrg`, and
	// `/gateway/resolve` recomputes `managedInference` every window. Both real
	// gates are server-side and stay there.
	const flagEnabled = useFeatureFlag("ui.managed_inference_card");

	useEffect(() => {
		let cancelled = false;
		setReadError(null);
		setLoaded(false);
		void (async () => {
			await waitForNetworkWrites(target);
			if (cancelled) {
				return;
			}
			try {
				const [u, t] = await Promise.all([
					getPreference(target, MANAGED_GATEWAY_URL_PREF),
					getPreference(target, MANAGED_GATEWAY_TOKEN_PREF),
				]);
				if (!cancelled) {
					setUrl(u ?? "");
					setToken(t ?? "");
					setLoaded(true);
				}
			} catch (error) {
				if (!cancelled) {
					setReadError(
						error instanceof Error
							? error.message
							: "Could not read this node's managed inference settings."
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [target, readAttempt]);

	// Written as bare strings — Core reads both with `prefs.get(key)` and
	// re-resolves the pair on either write, so this takes effect without a
	// restart. Saved together because half a pair is not a usable state.
	const handleSave = async () => {
		const trimmedUrl = url.trim();
		const trimmedToken = token.trim();
		if (Boolean(trimmedUrl) !== Boolean(trimmedToken)) {
			sileo.error({
				title: "Both fields are required",
				description:
					"Managed inference needs the fleet URL and an organization token. Clear both to go back to the local gateway.",
			});
			return;
		}
		setSaving(true);
		try {
			const results = await writeNetworkResource(target, () =>
				Promise.allSettled([
					setPreference(target, MANAGED_GATEWAY_URL_PREF, trimmedUrl),
					setPreference(target, MANAGED_GATEWAY_TOKEN_PREF, trimmedToken),
				])
			);
			if (!active.current) {
				return;
			}
			const saved = results.every(
				(result) => result.status === "fulfilled" && result.value
			);
			if (!saved) {
				sileo.error({
					title: "Failed to save",
					description:
						"Core did not accept both settings. Your edits remain in the form so you can retry.",
				});
				return;
			}
			sileo.success({
				title: trimmedUrl
					? "Managed inference connected"
					: "Managed inference disconnected",
				description: trimmedUrl
					? "The Ryu Router provider now runs on the hosted fleet and bills the organization tied to this node's token. Your own API keys keep using this node's gateway."
					: "The managed provider falls back to this node's local gateway.",
			});
		} finally {
			if (active.current) {
				setSaving(false);
			}
		}
	};

	// A node that ALREADY has the pref pair set keeps the card whatever the flag
	// says. This clause is load-bearing, not a nicety: those prefs are locally
	// verifiable evidence the capability is IN USE, and hiding the card there
	// would strand an operator with no way to CLEAR a fleet URL and token that
	// are still live and still spending. Fail-closed applies to DISCOVERY, never
	// to escape.
	//
	// Gated on `loaded` so the decision is never made against the empty-string
	// defaults `url`/`token` start at — before the prefs round-trip lands they
	// say nothing, and reading them as "unconfigured" would hide the card from
	// exactly the operator this clause exists for.
	const configured = loaded && Boolean(url || token);
	if (!(flagEnabled || configured || readError)) {
		return null;
	}

	return (
		<SettingsSection
			caption="Use the Ryu Router provider on this self-hosted node. Requests go to the hosted gateway fleet and are billed to the organization tied to the saved token; providers with your own key keep using this node's gateway."
			title="Managed inference"
		>
			<OrgBillingContext
				compact
				description="Managed requests use the shared Ryu credits for this selected organization."
				label="Selected organization"
			/>
			<NetworkReadError
				error={readError}
				onRetry={() => setReadAttempt((attempt) => attempt + 1)}
				title="Could not load managed inference"
			/>
			<SettingsGroup>
				<SettingsItem
					actions={
						<span className="text-muted-foreground text-sm">
							The token’s issuing organization
						</span>
					}
					description={
						<>
							The saved <code>rgw_</code> token stays bound to the organization
							that issued it. Switching the active organization in Ryu does not
							retarget this node. To move its billing, replace the token with
							one from the other organization&apos;s Gateway keys page.
						</>
					}
					title="Node billing owner"
				/>
				<SettingsItem title="Fleet URL">
					<Input
						aria-label="Fleet URL"
						autoComplete="off"
						disabled={!loaded}
						id="managed-gateway-url"
						onChange={(e) => setUrl(e.target.value)}
						placeholder="Fleet URL from your Gateway keys page"
						type="url"
						value={url}
					/>
				</SettingsItem>
				<SettingsItem
					actions={
						<Button disabled={!loaded || saving} onClick={handleSave} size="sm">
							{saving ? "Saving…" : "Save"}
						</Button>
					}
					// Names BOTH halves and their single source. The old copy mentioned only
					// the token, and the URL field carried a fake example.com placeholder — so
					// nothing anywhere told a self-hosted operator what to put in it. The
					// Gateway keys page now shows the fleet URL beside the key for exactly
					// this copy-paste.
					description="Your organization's Gateway keys page shows the fleet URL and issues the token. Copy both from there. The token is shown once, and revoking it there immediately stops this node spending credits. Leave both fields empty to use only this node's own gateway."
					title="Organization token"
				>
					<Input
						aria-label="Organization token"
						autoComplete="off"
						disabled={!loaded}
						id="managed-gateway-token"
						onChange={(e) => setToken(e.target.value)}
						placeholder="rgw_…"
						type="password"
						value={token}
					/>
				</SettingsItem>
			</SettingsGroup>
		</SettingsSection>
	);
}
