import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { SettingsNotice } from "@/src/components/gateway/SettingsNotice.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import { isTauriReady } from "@/src/lib/tauri-ready.ts";
import type { PairedClient } from "./NodeAccessSettings.model.ts";
import {
	responseCodec1,
	responseCodec2,
	responseCodec3,
	responseCodec4,
	responseCodec5,
} from "./NodeAccessSettings-codecs.ts";
import { PairedClientItem } from "./NodeAccessSettings-paired-client.tsx";
import {
	type PairingRequest,
	PendingRequestItem,
} from "./NodeAccessSettings-pending-request.tsx";

/**
 * Who is allowed to talk to this node.
 *
 * Core mints a node-admittance token on first boot, so the local API is
 * authenticated by default rather than open to every process on the machine.
 * Surfaces that run as their own process read that token off disk. Two classes
 * cannot — a browser page (the hosted webapp, the extension) and a desktop on
 * ANOTHER machine — so they pair with a device code that a human approves here.
 *
 * This panel is that approval surface, plus the token itself for the cases where
 * copying it by hand is the right answer (a headless node reached over SSH).
 */

type TokenSource = "env" | "file" | "none";

/** Poll interval for pending requests, in ms. Short: a human is waiting. */
const PENDING_POLL_MS = 3000;

/**
 * Whether this build is running inside Tauri (the desktop shell) rather than a
 * plain browser tab. The webapp ships the SAME UI through Tauri API shims, so the
 * distinction cannot come from the bundle — only from the host.
 *
 * It decides which half of this panel is useful: a desktop reads the node token
 * off local disk and APPROVES other devices; a browser tab can do neither, so it
 * pairs and gets approved instead.
 */
function isTauri(): boolean {
	return isTauriReady();
}

export function NodeAccessSettings() {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	const [token, setToken] = useState<string | null>(null);
	const [source, setSource] = useState<TokenSource>("none");
	const [revealed, setRevealed] = useState(false);
	const [pending, setPending] = useState<PairingRequest[]>([]);
	const [clients, setClients] = useState<PairedClient[]>([]);
	const [selectedScopes, setSelectedScopes] = useState<
		Record<string, string[]>
	>({});
	const [busy, setBusy] = useState(false);
	const [hasLoadedAccess, setHasLoadedAccess] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const [loadingAccess, setLoadingAccess] = useState(false);
	const [pairingCode, setPairingCode] = useState<string | null>(null);
	const inBrowser = !isTauri();

	const loadToken = useCallback(async () => {
		try {
			const result = await invoke<{
				source: TokenSource;
				token: string | null;
			}>("local_node_token");
			setToken(result.token);
			setSource(result.source);
		} catch {
			// A non-Tauri host (the harness, the web build) has no such command.
			setSource("none");
		}
	}, []);

	const loadPending = useCallback(async () => {
		setLoadingAccess(true);
		try {
			const [requests, paired] = await Promise.all([
				request<{ requests: PairingRequest[] }>(
					target,
					"/api/pair/requests",
					undefined,
					responseCodec1
				),
				request<{ clients: PairedClient[] }>(
					target,
					"/api/pair/clients",
					undefined,
					responseCodec2
				),
			]);
			const nextRequests = requests.requests ?? [];
			setPending(nextRequests);
			setSelectedScopes((current) => {
				const next: Record<string, string[]> = {};
				for (const pairingRequest of nextRequests) {
					if (!pairingRequest.requested_scopes) {
						continue;
					}
					const previous = current[pairingRequest.user_code];
					next[pairingRequest.user_code] = previous
						? previous.filter((scope) =>
								pairingRequest.requested_scopes?.includes(scope)
							)
						: [...pairingRequest.requested_scopes];
				}
				return next;
			});
			setClients(paired.clients ?? []);
			setLoadError(false);
			setHasLoadedAccess(true);
		} catch {
			// Do not represent an unavailable read as an empty security list.
			setLoadError(true);
			setHasLoadedAccess(true);
		} finally {
			setLoadingAccess(false);
		}
		// `target` is rebuilt each render; depend on its fields, not the object.
	}, [node.url, node.token]);

	useEffect(() => {
		void loadToken();
	}, [loadToken]);

	useEffect(() => {
		void loadPending();
		const timer = setInterval(() => void loadPending(), PENDING_POLL_MS);
		return () => clearInterval(timer);
	}, [loadPending]);

	const decide = async (userCode: string, approve: boolean) => {
		const requestToDecide = pending.find(
			(requestItem) => requestItem.user_code === userCode
		);
		setBusy(true);
		try {
			const grantedScopes = requestToDecide?.requested_scopes
				? (selectedScopes[userCode] ?? requestToDecide.requested_scopes)
				: undefined;
			await request(
				target,
				`/api/pair/${approve ? "approve" : "deny"}`,
				{
					method: "POST",
					body:
						approve && grantedScopes
							? {
									granted_scopes: grantedScopes,
									user_code: userCode,
								}
							: { user_code: userCode },
				},
				responseCodec3
			);
			toast.success(approve ? "Device approved" : "Device denied", {
				id: `pair-${userCode}`,
			});
			await loadPending();
		} catch (error) {
			toast.error("Could not record that decision", {
				id: `pair-${userCode}`,
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const revoke = async (client: PairedClient) => {
		setBusy(true);
		try {
			await request(
				target,
				`/api/pair/clients/${client.id}`,
				{
					method: "DELETE",
				},
				responseCodec4
			);
			toast.success(`Revoked ${client.name}`, { id: `revoke-${client.id}` });
			await loadPending();
		} catch (error) {
			toast.error("Could not revoke that device", {
				id: `revoke-${client.id}`,
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const rotate = async () => {
		setBusy(true);
		try {
			const result = await request<{
				message: string;
				restart_required: boolean;
			}>(target, "/api/node/token/rotate", { method: "POST" }, responseCodec5);
			toast.success("Owner token rotated", {
				id: "rotate-node-token",
				description: result.restart_required
					? tl("{message} Restart Core to finish.", {
							message: result.message,
						})
					: result.message,
			});
			await loadToken();
		} catch (error) {
			toast.error("Could not rotate the token", {
				id: "rotate-node-token",
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const pairThisBrowser = async () => {
		setBusy(true);
		try {
			// Routed through `invoke` like every other node command. In the webapp
			// this hits the browser shim; in the desktop shell the command does not
			// exist, but that branch is unreachable there (`inBrowser` is false).
			// `onCode` is a live callback rather than JSON because the shim runs
			// in-process — there is no IPC boundary to serialize across.
			const paired = await invoke<boolean>("pair_local_node", {
				name: node.name,
				onCode: (code: string) => setPairingCode(code),
			});
			if (paired) {
				toast.success("This browser is now connected", { id: "pair-self" });
				// The bearer lives on the persisted node record; a reload is the
				// simplest way to get every open query to pick it up.
				window.location.reload();
			} else {
				toast.error("Pairing was denied or timed out", { id: "pair-self" });
			}
		} catch (error) {
			toast.error("Could not pair this browser", {
				id: "pair-self",
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setPairingCode(null);
			setBusy(false);
		}
	};

	const copyToken = async () => {
		if (!token) {
			return;
		}
		await navigator.clipboard.writeText(token);
		toast.success("Token copied", { id: "copy-node-token" });
	};

	if (inBrowser) {
		return (
			<SettingsSection
				caption="Approve the code in the Ryu desktop app under Devices & access."
				title="Connect this browser"
			>
				{pairingCode ? (
					<SettingsCard className="py-6 text-center">
						<div aria-live="polite" role="status">
							<p className="font-mono text-2xl tracking-widest">
								{pairingCode}
							</p>
							<p className="mt-2 text-muted-foreground text-xs">
								Waiting for approval in the desktop app&hellip;
							</p>
						</div>
					</SettingsCard>
				) : (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button
									disabled={busy}
									onClick={() => void pairThisBrowser()}
									size="sm"
								>
									Connect this browser
								</Button>
							}
							title="This browser"
						/>
					</SettingsGroup>
				)}
			</SettingsSection>
		);
	}

	const accessListsReady = hasLoadedAccess && !loadError;

	return (
		<div className="flex flex-col gap-6">
			{hasLoadedAccess ? null : (
				<SettingsNotice role="status">Loading device access…</SettingsNotice>
			)}
			{loadError ? (
				<SettingsNotice
					action={
						<Button
							disabled={loadingAccess}
							onClick={() => void loadPending()}
							size="sm"
							variant="outline"
						>
							Retry
						</Button>
					}
					role="alert"
				>
					Could not load device access. Check this node's connection, then
					retry.
				</SettingsNotice>
			) : null}
			<SettingsSection
				caption="Approve only when the code matches the one the device shows."
				title="Devices waiting to connect"
			>
				{accessListsReady ? (
					pending.length === 0 ? (
						<SettingsCard className="text-center text-muted-foreground text-sm">
							Nothing waiting.
						</SettingsCard>
					) : (
						<SettingsCard className="px-0 py-0">
							<ul className="divide-y divide-border">
								{pending.map((req) => (
									<PendingRequestItem
										busy={busy}
										decide={decide}
										key={req.user_code}
										req={req}
										selectedScopes={selectedScopes}
										setSelectedScopes={setSelectedScopes}
									/>
								))}
							</ul>
						</SettingsCard>
					)
				) : null}
			</SettingsSection>

			<SettingsSection
				caption="Revoking a device signs it out at once."
				title="Connected devices"
			>
				{accessListsReady ? (
					clients.length === 0 ? (
						<SettingsCard className="text-center text-muted-foreground text-sm">
							No paired devices.
						</SettingsCard>
					) : (
						<SettingsCard className="px-0 py-0">
							<ul className="divide-y divide-border">
								{clients.map((client) => (
									<PairedClientItem
										busy={busy}
										client={client}
										key={client.id}
										revoke={revoke}
									/>
								))}
							</ul>
						</SettingsCard>
					)
				) : null}
			</SettingsSection>

			<SettingsSection
				caption="Apps on this device use it automatically. Copy it only for a headless node."
				title="This node's access token"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<div className="flex gap-1">
								<Button
									disabled={!token}
									onClick={() => setRevealed((v) => !v)}
									size="sm"
									variant="ghost"
								>
									{revealed ? "Hide" : "Show"}
								</Button>
								<Button
									disabled={!token}
									onClick={() => void copyToken()}
									size="sm"
									variant="ghost"
								>
									Copy
								</Button>
							</div>
						}
						description={
							source === "env" ? (
								<>
									Set by <code>RYU_TOKEN</code>, so rotating here has no effect.
								</>
							) : undefined
						}
						title={
							<Label className="font-normal" htmlFor="node-token">
								Token
							</Label>
						}
					>
						<Input
							id="node-token"
							readOnly
							type={revealed ? "text" : "password"}
							value={token ?? ""}
							variant="code-caption"
						/>
					</SettingsItem>
					{source === "env" ? null : (
						<SettingsItem
							actions={
								<Button
									disabled={busy || source === "none"}
									onClick={() => void rotate()}
									size="sm"
									variant="outline"
								>
									Rotate token
								</Button>
							}
							description="Takes effect immediately. Paired devices keep working."
							title="Rotate"
						/>
					)}
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
