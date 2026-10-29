// apps/desktop/src/components/settings/NetworkSettings.tsx
//
// The node's network surface (Gateway settings → Network): private Tailscale,
// Headscale, and Tailcat connections, plus the public Cloudflare Quick Tunnel.
// It owns the enable toggle, live status, shareable URLs, and Headscale URL.
//
// Tailscale/Headscale use the official client pair; Tailcat and Cloudflared use
// Ryu-managed CLIs. Core owns backend selection and starts the chosen service.

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useRef, useState } from "react";
import { sileo } from "sileo";
import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import { useActiveTarget } from "@/src/hooks/useActiveNode.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchMeshStatus,
	MESH_BACKEND_CLOUDFLARED,
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

function isValidHeadscaleUrl(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}
	try {
		const url = new URL(trimmed);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.hostname.length > 0
		);
	} catch {
		return false;
	}
}

function useNetworkTarget(): ApiTarget {
	return useActiveTarget();
}

function useNetworkOwner() {
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	return active;
}

// Only private queue identities contain credentials. React keys are opaque lifetimes.
function networkResourceKey(target: ApiTarget): string {
	return JSON.stringify([
		target.url.replace(/\/$/, ""),
		target.token,
		target.userJwt ?? null,
	]);
}

function useNetworkLifetime(target: ApiTarget): number {
	const lifetime = useRef({
		identity: networkResourceKey(target),
		generation: 0,
	});
	const identity = networkResourceKey(target);
	if (lifetime.current.identity !== identity) {
		lifetime.current = {
			identity,
			generation: lifetime.current.generation + 1,
		};
	}
	return lifetime.current.generation;
}

// A settings dialog can disappear while Core is still acknowledging its write.
// Keep those acknowledgments across remounts and serialize the two network cards.
const pendingNetworkWrites = new Map<string, Promise<void>>();
function writeNetworkResource<T>(
	target: ApiTarget,
	write: () => Promise<T>
): Promise<T> {
	const key = networkResourceKey(target);
	const result = (pendingNetworkWrites.get(key) ?? Promise.resolve()).then(
		write
	);
	const settled = result.then(
		() => undefined,
		() => undefined
	);
	pendingNetworkWrites.set(key, settled);
	void settled.then(() => {
		if (pendingNetworkWrites.get(key) === settled) {
			pendingNetworkWrites.delete(key);
		}
	});
	return result;
}
async function waitForNetworkWrites(target: ApiTarget): Promise<void> {
	const key = networkResourceKey(target);
	while (pendingNetworkWrites.has(key)) {
		await pendingNetworkWrites.get(key);
	}
}

function NetworkReadError({
	title,
	error,
	onRetry,
}: {
	title: string;
	error: string | null;
	onRetry: () => void;
}) {
	if (!error) {
		return null;
	}
	// A plain sentence with Retry beside it; the raw failure stays one click away
	// under "Details" rather than being the headline.
	return (
		<div role="alert">
			<SettingsItem
				actions={
					<Button onClick={onRetry} size="sm" variant="outline">
						Retry
					</Button>
				}
				title={title}
			>
				<details className="text-muted-foreground text-xs">
					<summary className="cursor-pointer select-none">Details</summary>
					<span className="mt-1 block break-all">{error}</span>
				</details>
			</SettingsItem>
		</div>
	);
}

export function NetworkSettings() {
	const target = useNetworkTarget();
	const lifetime = useNetworkLifetime(target);
	return <NetworkSettingsForNode key={lifetime} target={target} />;
}

function NetworkSettingsForNode({ target }: { target: ApiTarget }) {
	const active = useNetworkOwner();
	const [readError, setReadError] = useState<string | null>(null);
	const [readAttempt, setReadAttempt] = useState(0);
	const [meshStatus, setMeshStatus] = useState<MeshStatus | null>(null);
	// True only when `/api/mesh/status` answered at all (a 404 on an older Core
	// without the plane hides the whole section).
	const [meshAvailable, setMeshAvailable] = useState(false);
	const [savingMesh, setSavingMesh] = useState(false);
	// Headscale: self-hosted Tailscale control server URL.
	const [headscaleUrl, setHeadscaleUrlValue] = useState("");
	const [headscaleLoaded, setHeadscaleLoaded] = useState(false);
	const [savingHeadscale, setSavingHeadscale] = useState(false);
	const [meshBackend, setMeshBackend] =
		useState<MeshBackend>(MESH_BACKEND_TAILCAT);
	const [tailcatCopied, setTailcatCopied] = useState(false);
	const headscaleUrlIsValid = isValidHeadscaleUrl(headscaleUrl);
	const headscaleUrlError = headscaleUrlIsValid
		? null
		: headscaleUrl.trim()
			? "Enter a valid HTTP or HTTPS URL."
			: "Enter the Headscale control server URL.";
	const [cloudflaredCopied, setCloudflaredCopied] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setReadError(null);
		setHeadscaleLoaded(false);
		void (async () => {
			await waitForNetworkWrites(target);
			if (cancelled) {
				return;
			}
			try {
				const [loginServer, backend, status] = await Promise.all([
					getPreference(target, MESH_LOGIN_SERVER_PREF),
					getPreference(target, MESH_BACKEND_PREF),
					fetchMeshStatus(target).catch((error) => {
						if (error instanceof ApiError && error.status === 404) {
							return null;
						}
						throw error;
					}),
				]);
				if (cancelled) {
					return;
				}
				setHeadscaleUrlValue(loginServer ?? "");
				setMeshBackend(parseMeshBackend(backend, loginServer));
				setMeshStatus(status);
				setMeshAvailable(status !== null);
				setHeadscaleLoaded(true);
			} catch (error) {
				if (!cancelled) {
					setReadError(
						error instanceof Error
							? error.message
							: "Could not read this node's network settings."
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [target, readAttempt]);

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
		try {
			const { startError, status, installing, canInstall } =
				await writeNetworkResource(target, () =>
					setMeshEnabled(target, enabled)
				);
			if (!active.current) {
				return;
			}
			setMeshStatus(status);
			if (enabled && installing) {
				await watchMeshInstall(
					target,
					meshBackend,
					(next) => {
						if (active.current) {
							setMeshStatus(next);
						}
					},
					() => active.current
				);
				return;
			}
			if (enabled && startError) {
				sileo.warning({
					title: canInstall
						? "Tunnel enabled, but it did not start"
						: meshBackend === MESH_BACKEND_TAILCAT
							? "Tailcat could not be installed automatically"
							: meshBackend === MESH_BACKEND_CLOUDFLARED
								? "Cloudflare Quick Tunnel could not start"
								: "Mesh client could not be installed automatically",
					description: startError,
				});
				return;
			}
			sileo.success({
				title: enabled ? "Tunnel enabled" : "Tunnel disabled",
				description: enabled
					? status.reachable
						? meshBackend === MESH_BACKEND_TAILCAT
							? "Tailcat is listening and its short-lived address is ready to share."
							: meshBackend === MESH_BACKEND_CLOUDFLARED
								? "A temporary public URL is ready below. Protected Core routes still require RYU_TOKEN."
								: "This node is now on the tailnet."
						: meshBackend === MESH_BACKEND_TAILCAT
							? "The Tailcat listener is starting; it will publish an address when ready."
							: meshBackend === MESH_BACKEND_CLOUDFLARED
								? "The Cloudflare tunnel is starting or Cloudflared is installing."
								: "The tunnel is starting; it may need to finish connecting."
					: "This node has left its tunnel.",
			});
		} catch (e) {
			if (!active.current) {
				return;
			}
			// A genuine rejection — Core could not persist the change.
			sileo.error({
				title: enabled
					? "Failed to enable the tunnel"
					: "Failed to disable the tunnel",
				description:
					e instanceof Error ? e.message : "Failed to update the tunnel",
			});
		} finally {
			if (active.current) {
				setSavingMesh(false);
			}
		}
	};

	// Save the Headscale control-server URL. Core reads `mesh-login-server` raw
	// (`prefs.get(key)` → `Option<String>` handed to `tailscale up --login-server`
	// during one-shot enrollment), so the bare string is written — no JSON wrapping.
	const handleSaveHeadscale = async () => {
		if (!headscaleUrlIsValid) {
			return;
		}
		setSavingHeadscale(true);
		const normalizedUrl = headscaleUrl.trim();
		try {
			const ok = await writeNetworkResource(target, () =>
				setPreference(target, MESH_LOGIN_SERVER_PREF, normalizedUrl)
			);
			if (!active.current) {
				return;
			}
			if (ok) {
				setHeadscaleUrlValue(normalizedUrl);
				sileo.success({
					title: "Headscale server saved",
					description:
						"Restart the mesh daemon (or this node) for the change to take effect.",
				});
			} else {
				sileo.error({ title: "Failed to save Headscale server URL" });
			}
		} catch (error) {
			if (!active.current) {
				return;
			}
			sileo.error({
				title: "Failed to save Headscale server URL",
				description:
					error instanceof Error ? error.message : "Failed to save the setting",
			});
		} finally {
			if (active.current) {
				setSavingHeadscale(false);
			}
		}
	};

	const handleCopyTailcatAddress = async () => {
		const address = meshStatus?.tailcatAddress;
		if (!address) {
			return;
		}
		try {
			await navigator.clipboard.writeText(address);
			if (!active.current) {
				return;
			}
			setTailcatCopied(true);
			sileo.success({ title: "Tailcat address copied" });
			window.setTimeout(() => setTailcatCopied(false), 2000);
		} catch {
			if (!active.current) {
				return;
			}
			sileo.error({ title: "Could not copy the Tailcat address" });
		}
	};

	const handleCopyCloudflaredUrl = async () => {
		const url = meshStatus?.cloudflaredUrl;
		if (!url) {
			return;
		}
		try {
			await navigator.clipboard.writeText(url);
			if (!active.current) {
				return;
			}
			setCloudflaredCopied(true);
			sileo.success({ title: "Cloudflare URL copied" });
			window.setTimeout(() => setCloudflaredCopied(false), 2000);
		} catch {
			if (!active.current) {
				return;
			}
			sileo.error({ title: "Could not copy the Cloudflare URL" });
		}
	};

	// The section is hidden only when the running Core has no mesh plane at all
	// (`meshAvailable` false — an older binary). A mesh-off install still gets the
	// enable toggle; turning it on is the whole point of this tab.
	if (!(meshAvailable || readError)) {
		return null;
	}

	return (
		<SettingsSection
			caption="Connect privately with Tailscale, Headscale, or Tailcat, or create a temporary public Cloudflare Quick Tunnel. Choose a backend under Toolkits → VPN in the Computer dialog (expand the computer selector)."
			title="Network and Tunnel"
		>
			<NetworkReadError
				error={readError}
				onRetry={() => setReadAttempt((attempt) => attempt + 1)}
				title="Could not load network settings"
			/>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={meshStatus?.enabled ?? false}
							disabled={
								savingMesh ||
								!headscaleLoaded ||
								!meshStatus ||
								Boolean(readError)
							}
							id="mesh-enabled"
							onCheckedChange={handleToggleMesh}
						/>
					}
					description={
						meshBackend === MESH_BACKEND_TAILCAT
							? "When on, this node exposes its Core through a short-lived Tailcat address. Turning it off revokes that address."
							: meshBackend === MESH_BACKEND_CLOUDFLARED
								? "When on, this node gets a temporary public URL. Anyone with it can reach Core's public routes; protected routes require RYU_TOKEN."
								: "When on, this node joins the tailnet and other Ryu nodes can reach it. Turning it off leaves the tailnet."
					}
					title="Enable tunnel"
				/>
				{meshStatus?.enabled ? (
					<SettingsItem
						description={
							meshStatus.reachable
								? meshBackend === MESH_BACKEND_TAILCAT
									? "Tailcat is listening. Share the address below with a client."
									: meshBackend === MESH_BACKEND_CLOUDFLARED
										? "Cloudflare Quick Tunnel is live. The URL below is public and temporary."
										: meshStatus.magicDnsName
											? `Reachable on the tailnet as ${meshStatus.magicDnsName}.`
											: "Reachable on the tailnet."
								: meshBackend === MESH_BACKEND_TAILCAT
									? "Enabled but no Tailcat address is ready yet. The listener may still be starting."
									: meshBackend === MESH_BACKEND_CLOUDFLARED
										? "Enabled but the public URL is not ready yet. Cloudflared may still be starting or installing."
										: "Enabled but not connected yet. The daemon may still be starting, or the official Tailscale client is missing or not logged in."
						}
						title="Status"
					/>
				) : null}
				{meshStatus?.backend === MESH_BACKEND_TAILCAT &&
				meshStatus.tailcatAddress ? (
					<SettingsItem
						actions={
							<Button
								onClick={handleCopyTailcatAddress}
								size="sm"
								variant="secondary"
							>
								<HugeiconsIcon icon={Copy01Icon} size={14} />
								{tailcatCopied ? "Copied" : "Copy"}
							</Button>
						}
						description={
							<>
								Pass this address to a Tailcat client, for example{" "}
								<code>tailcat &lt;address&gt; &lt;port&gt;</code>. Treat it like
								a password. It is replaced when this listener stops or restarts.
							</>
						}
						title="Tailcat address"
					>
						<Input
							aria-label="Tailcat address"
							readOnly
							value={meshStatus.tailcatAddress}
							variant="code-caption"
						/>
					</SettingsItem>
				) : null}
				{meshStatus?.backend === MESH_BACKEND_CLOUDFLARED &&
				meshStatus.cloudflaredUrl ? (
					<SettingsItem
						actions={
							<Button
								onClick={handleCopyCloudflaredUrl}
								size="sm"
								variant="secondary"
							>
								<HugeiconsIcon icon={Copy01Icon} size={14} />
								{cloudflaredCopied ? "Copied" : "Copy URL"}
							</Button>
						}
						description="This public URL changes when the tunnel restarts. Anyone with it can reach Core's public routes; protected routes require RYU_TOKEN."
						title="Cloudflare Quick Tunnel URL"
					>
						<Input
							aria-label="Cloudflare Quick Tunnel URL"
							readOnly
							value={meshStatus.cloudflaredUrl}
							variant="code-caption"
						/>
					</SettingsItem>
				) : null}
				{meshBackend === MESH_BACKEND_HEADSCALE ? (
					<SettingsItem
						actions={
							<Button
								disabled={
									!headscaleLoaded || savingHeadscale || !headscaleUrlIsValid
								}
								onClick={handleSaveHeadscale}
								size="sm"
							>
								{savingHeadscale ? "Saving…" : "Save"}
							</Button>
						}
						description={
							<span className="flex flex-col gap-1">
								{headscaleUrlError ? (
									<span
										className="text-status-destructive"
										id="headscale-url-error"
										role="alert"
									>
										{headscaleUrlError}
									</span>
								) : null}
								<span>
									Ryu installs the Tailscale client automatically. This URL is
									the Headscale control server that coordinates the private
									network; it is still required for Headscale and applies the
									next time this node enrolls.
								</span>
							</span>
						}
						title="Control server URL"
					>
						<Input
							aria-describedby={
								headscaleUrlError ? "headscale-url-error" : undefined
							}
							aria-invalid={Boolean(headscaleUrlError)}
							aria-label="Headscale control server URL"
							autoComplete="off"
							disabled={!headscaleLoaded}
							id="headscale-url"
							onChange={(e) => setHeadscaleUrlValue(e.target.value)}
							placeholder="https://headscale.example.com"
							type="url"
							value={headscaleUrl}
						/>
					</SettingsItem>
				) : meshBackend === MESH_BACKEND_TAILSCALE ? (
					<SettingsItem
						description="Ryu installs the Tailscale client automatically and uses Tailscale's hosted coordination server."
						title="Control server"
					/>
				) : meshBackend === MESH_BACKEND_CLOUDFLARED ? (
					<SettingsItem
						description="Ryu installs Cloudflared automatically when a verified release is available for this platform. Quick Tunnels are public, temporary, and intended for brief sharing or development."
						title="Cloudflare Quick Tunnel"
					/>
				) : (
					<SettingsItem
						description="Ryu installs Tailcat automatically. Tailcat has no account, control server, or tailnet; it creates a short-lived address for this node."
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
