// apps/desktop/src/components/settings/NetworkSettings.tsx
//
// The node's network surface (Gateway settings → Network): the opt-in
// Tailscale/Headscale mesh or short-lived Tailcat connection. Owns the enable
// toggle, a live status line, the Tailcat address, and the Headscale URL.
//
// Tailscale/Headscale use the official `tailscale` + `tailscaled` client; Tailcat
// uses the separately installed `tailcat` CLI. Enabling writes the
// `mesh-enabled` pref through `POST /api/mesh/config`; Core then starts the
// selected backend, so this is the writer the rest of the network surface keys
// off.

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchMeshStatus,
	MESH_BACKEND_HEADSCALE,
	MESH_BACKEND_PREF,
	MESH_BACKEND_TAILCAT,
	MESH_BACKEND_TAILSCALE,
	MESH_LOGIN_SERVER_PREF,
	type MeshBackend,
	type MeshStatus,
	parseMeshBackend,
	setMeshEnabled,
} from "@/src/lib/api/mesh.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { watchMeshInstall } from "../shell/mesh-install.ts";
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

export function NetworkSettings() {
	const [meshStatus, setMeshStatus] = useState<MeshStatus | null>(null);
	// True only when `/api/mesh/status` answered at all (a 404 on an older Core
	// without the plane hides the whole section).
	const [meshAvailable, setMeshAvailable] = useState(false);
	const [savingMesh, setSavingMesh] = useState(false);
	// Headscale: self-hosted Tailscale control server URL.
	const [headscaleUrl, setHeadscaleUrlValue] = useState("");
	const [headscaleLoaded, setHeadscaleLoaded] = useState(false);
	const [savingHeadscale, setSavingHeadscale] = useState(false);
	const [meshBackend, setMeshBackend] = useState<MeshBackend>(
		MESH_BACKEND_HEADSCALE
	);
	const [tailcatCopied, setTailcatCopied] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		Promise.all([
			getPreference(target, MESH_LOGIN_SERVER_PREF),
			getPreference(target, MESH_BACKEND_PREF),
		]).then(([loginServer, backend]) => {
			if (!cancelled) {
				setHeadscaleUrlValue(loginServer ?? "");
				setMeshBackend(parseMeshBackend(backend));
				setHeadscaleLoaded(true);
			}
		});
		// `GET /api/mesh/status` answers HTTP 200 with `enabled:false` on a
		// mesh-off node (the normal case — the toggle below is the writer) and
		// 404s on a Core without the plane; only the 404 case hides the section.
		fetchMeshStatus(target)
			.then((status) => {
				if (!cancelled) {
					setMeshStatus(status);
					setMeshAvailable(true);
				}
			})
			.catch(() => {
				// No mesh plane on this node — leave the section hidden.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Enable/disable the mesh plane. Core persists the `mesh-enabled` pref,
	// flips its in-process signal, and starts/stops the Tailscale daemon.
	// A daemon-start failure resolves (not rejects) with `startError`, because the
	// mesh is still enabled — the toggle reflects the persisted state and the
	// warning explains why it isn't connected.
	//
	// A MISSING client is no longer such a failure: Core installs one (`installing`)
	// and starts the daemon itself when it lands, so this shows progress and polls
	// the status instead of a warning the user has to act on.
	const handleToggleMesh = async (enabled: boolean) => {
		setSavingMesh(true);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		try {
			const { startError, status, installing, canInstall } =
				await setMeshEnabled(target, enabled);
			setMeshStatus(status);
			if (enabled && installing) {
				await watchMeshInstall(target, setMeshStatus);
				return;
			}
			if (enabled && startError) {
				sileo.warning({
					title: canInstall
						? "Mesh enabled, but the daemon didn't start"
						: meshBackend === MESH_BACKEND_TAILCAT
							? "Network enabled — install the Tailcat CLI"
							: "Mesh enabled — install the Tailscale client",
					description: startError,
				});
				return;
			}
			sileo.success({
				title: enabled ? "Mesh enabled" : "Mesh disabled",
				description: enabled
					? status.reachable
						? meshBackend === MESH_BACKEND_TAILCAT
							? "Tailcat is listening and its short-lived address is ready to share."
							: "This node is now on the tailnet."
						: meshBackend === MESH_BACKEND_TAILCAT
							? "The Tailcat listener is starting; it will publish an address when ready."
							: "The mesh daemon is starting; it may need to finish connecting."
					: "This node has left the tailnet.",
			});
		} catch (e) {
			// A genuine rejection — Core could not persist the change.
			sileo.error({
				title: enabled
					? "Failed to enable the mesh"
					: "Failed to disable the mesh",
				description:
					e instanceof Error ? e.message : "Failed to update the mesh",
			});
		} finally {
			setSavingMesh(false);
		}
	};

	// Save the Headscale control-server URL. Core reads `mesh-login-server` raw
	// (`prefs.get(key)` → `Option<String>` handed to `tailscale up --login-server`
	// during one-shot enrollment), so the bare string is written — no JSON wrapping.
	const handleSaveHeadscale = async () => {
		setSavingHeadscale(true);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setPreference(
			target,
			MESH_LOGIN_SERVER_PREF,
			headscaleUrl
		);
		setSavingHeadscale(false);
		if (ok) {
			sileo.success({
				title: "Headscale server saved",
				description:
					"Restart the mesh daemon (or this node) for the change to take effect.",
			});
		} else {
			sileo.error({ title: "Failed to save Headscale server URL" });
		}
	};

	const handleCopyTailcatAddress = async () => {
		const address = meshStatus?.tailcatAddress;
		if (!address) {
			return;
		}
		try {
			await navigator.clipboard.writeText(address);
			setTailcatCopied(true);
			sileo.success({ title: "Tailcat address copied" });
			window.setTimeout(() => setTailcatCopied(false), 2000);
		} catch {
			sileo.error({ title: "Could not copy the Tailcat address" });
		}
	};

	// The section is hidden only when the running Core has no mesh plane at all
	// (`meshAvailable` false — an older binary). A mesh-off install still gets the
	// enable toggle; turning it on is the whole point of this tab.
	if (!meshAvailable) {
		return null;
	}

	return (
		<SettingsSection
			caption="Connect this node privately with Tailscale, Headscale, or a short-lived Tailcat address. Tailscale and Headscale use the official tailscale + tailscaled client in userspace networking mode; Tailcat uses the separately installed tailcat CLI. Pick the backend from Tunnel in the node menu."
			title="Network (Tailscale / Headscale / Tailcat)"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={meshStatus?.enabled ?? false}
							disabled={savingMesh}
							id="mesh-enabled"
							onCheckedChange={handleToggleMesh}
						/>
					}
					description={
						meshBackend === MESH_BACKEND_TAILCAT
							? "When on, this node exposes its Core through a short-lived Tailcat address. Turning it off revokes that address."
							: "When on, this node joins the tailnet and other Ryu nodes can reach it. Turning it off leaves the tailnet."
					}
					title="Enable private network"
				/>
				{meshStatus?.enabled ? (
					<SettingsItem
						description={
							meshStatus.reachable
								? meshBackend === MESH_BACKEND_TAILCAT
									? "Tailcat is listening. Share the address below with a client."
									: meshStatus.magicDnsName
										? `Reachable on the tailnet as ${meshStatus.magicDnsName}.`
										: "Reachable on the tailnet."
								: meshBackend === MESH_BACKEND_TAILCAT
									? "Enabled but no Tailcat address is ready yet. The listener may still be starting."
									: "Enabled but not connected yet. The daemon may still be starting, or the official Tailscale client is missing or not logged in."
						}
						title="Status"
					/>
				) : null}
				{meshStatus?.backend === MESH_BACKEND_TAILCAT &&
				meshStatus.tailcatAddress ? (
					<SettingsItem title="Tailcat address">
						<div className="flex items-center gap-2">
							<Input
								aria-label="Tailcat address"
								className="min-w-0 flex-1 font-mono text-xs"
								readOnly
								value={meshStatus.tailcatAddress}
							/>
							<Button
								onClick={handleCopyTailcatAddress}
								size="sm"
								variant="secondary"
							>
								<HugeiconsIcon icon={Copy01Icon} size={14} />
								{tailcatCopied ? "Copied" : "Copy"}
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							Pass this address to a Tailcat client, for example{" "}
							<code>tailcat &lt;address&gt; &lt;port&gt;</code>. Treat it like a
							password. It is replaced when this listener stops or restarts.
						</p>
					</SettingsItem>
				) : null}
				{meshBackend === MESH_BACKEND_HEADSCALE ? (
					<SettingsItem title="Control server URL">
						<div className="flex items-center gap-2">
							<Input
								autoComplete="off"
								className="h-8 flex-1 text-xs"
								disabled={!headscaleLoaded}
								id="headscale-url"
								onChange={(e) => setHeadscaleUrlValue(e.target.value)}
								placeholder="https://headscale.example.com"
								type="url"
								value={headscaleUrl}
							/>
							<Button
								disabled={!headscaleLoaded || savingHeadscale}
								onClick={handleSaveHeadscale}
								size="sm"
							>
								{savingHeadscale ? "Saving…" : "Save"}
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							Point the mesh at a self-hosted Headscale server instead of
							Tailscale SaaS. Leave empty to use Tailscale SaaS. Passed as{" "}
							<code>--login-server</code> to <code>tailscale up</code>. It
							applies the next time this node enrolls.
						</p>
					</SettingsItem>
				) : meshBackend === MESH_BACKEND_TAILSCALE ? (
					<SettingsItem
						description="Tailscale uses its hosted coordination server. No control server URL is needed."
						title="Control server"
					/>
				) : (
					<SettingsItem
						description="Tailcat has no account, control server, or tailnet. It creates a short-lived address for this node."
						title="Control server"
					/>
				)}
			</SettingsGroup>
		</SettingsSection>
	);
}

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
		const target = toTarget(useNodeStore.getState().getActiveNode());
		Promise.all([
			getPreference(target, MANAGED_GATEWAY_URL_PREF),
			getPreference(target, MANAGED_GATEWAY_TOKEN_PREF),
		]).then(([u, t]) => {
			if (!cancelled) {
				setUrl(u ?? "");
				setToken(t ?? "");
				setLoaded(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

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
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = (
			await Promise.all([
				setPreference(target, MANAGED_GATEWAY_URL_PREF, trimmedUrl),
				setPreference(target, MANAGED_GATEWAY_TOKEN_PREF, trimmedToken),
			])
		).every(Boolean);
		setSaving(false);
		sileo[ok ? "success" : "error"]({
			title: ok
				? trimmedUrl
					? "Managed inference connected"
					: "Managed inference disconnected"
				: "Failed to save",
			description: ok
				? trimmedUrl
					? "The Ryu (managed) provider now runs on the hosted fleet and bills the organization tied to this node's token. Your own API keys keep using this node's gateway."
					: "The managed provider falls back to this node's local gateway."
				: "Core did not accept the change.",
		});
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
	if (!(flagEnabled || configured)) {
		return null;
	}

	return (
		<SettingsSection
			caption="Use the Ryu (managed) provider on this self-hosted node. Requests go to the hosted gateway fleet and are billed to the organization tied to the saved token; providers with your own key keep using this node's gateway."
			title="Managed inference"
		>
			<div className="space-y-2 px-3.5">
				<OrgBillingContext
					compact
					description="Managed requests use the shared Ryu credits for this selected organization."
					label="Selected organization"
				/>
				<p className="text-muted-foreground text-xs leading-snug">
					<span className="font-medium text-foreground">
						Node billing owner:
					</span>{" "}
					The organization that issued the saved token.
					<br />
					The saved <code>rgw_</code> token stays bound to the organization that
					issued it. Switching the active organization in Ryu does not retarget
					this node. To move its billing, replace the token with one from the
					other organization&apos;s Gateway keys page.
				</p>
			</div>
			<SettingsGroup>
				<SettingsItem title="Fleet URL">
					<Input
						autoComplete="off"
						className="h-8 text-xs"
						disabled={!loaded}
						id="managed-gateway-url"
						onChange={(e) => setUrl(e.target.value)}
						placeholder="Fleet URL from your Gateway keys page"
						type="url"
						value={url}
					/>
				</SettingsItem>
				<SettingsItem title="Organization token">
					<div className="flex items-center gap-2">
						<Input
							autoComplete="off"
							className="h-8 flex-1 text-xs"
							disabled={!loaded}
							id="managed-gateway-token"
							onChange={(e) => setToken(e.target.value)}
							placeholder="rgw_…"
							type="password"
							value={token}
						/>
						<Button disabled={!loaded || saving} onClick={handleSave} size="sm">
							{saving ? "Saving…" : "Save"}
						</Button>
					</div>
					{/* Names BOTH halves and their single source. The old copy mentioned
					    only the token, and the URL field carried a fake example.com
					    placeholder — so nothing anywhere told a self-hosted operator what
					    to put in it. The Gateway keys page now shows the fleet URL beside
					    the key for exactly this copy-paste. */}
					<p className="text-muted-foreground text-xs">
						Your organization&apos;s Gateway keys page shows the fleet URL and
						issues the token. Copy both from there. The token is shown once, and
						revoking it there immediately stops this node spending credits.
						Leave both fields empty to use only this node&apos;s own gateway.
					</p>
				</SettingsItem>
			</SettingsGroup>
		</SettingsSection>
	);
}
