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
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
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
	isValidHeadscaleUrl,
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

export { ManagedInferenceSettings } from "./NetworkSettings-managed-inference.tsx";

export function NetworkSettings() {
	const target = useNetworkTarget();
	const lifetime = useNetworkLifetime(target);
	return <NetworkSettingsForNode key={lifetime} target={target} />;
}

function NetworkSettingsForNode({ target }: { target: ApiTarget }) {
	const active = useNetworkOwner();
	const tl = useLiteralMessages();
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
											? tl("Reachable on the tailnet as {magicDnsName}.", {
													magicDnsName: meshStatus.magicDnsName,
												})
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
