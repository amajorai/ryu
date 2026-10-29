import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { OTPCodeDisplay } from "@ryu/ui/components/motion/otp-input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { SettingsNotice } from "@/src/components/gateway/SettingsNotice.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { isTauriReady } from "@/src/lib/tauri-ready.ts";
import {
	canRevokePairedClient,
	describePairingConstraints,
	formatPairingTimestamp,
	getPairedClientStatus,
	narrowPairingScopes,
	type PairedClient,
	type PairingConstraints,
} from "./NodeAccessSettings.model.ts";

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

interface PairingRequest {
	client_name: string;
	created_at: number;
	requested_constraints?: PairingConstraints;
	requested_expires_at?: number | null;
	requested_scopes?: string[];
	user_code: string;
}

function ScopeList({
	emptyLabel,
	label,
	scopes,
}: {
	emptyLabel: string;
	label: string;
	scopes?: string[];
}) {
	return (
		<div className="mt-2">
			<p className="text-muted-foreground text-xs">{label}</p>
			{scopes && scopes.length > 0 ? (
				<ul aria-label={label} className="mt-1 flex flex-wrap gap-1">
					{scopes.map((scope) => (
						<li
							className="type-caption rounded bg-muted px-1.5 py-0.5 font-mono"
							key={scope}
						>
							{scope}
						</li>
					))}
				</ul>
			) : (
				<p className="mt-1 text-muted-foreground text-xs">{emptyLabel}</p>
			)}
		</div>
	);
}

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
					? `${result.message} Restart Core to finish.`
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
				caption="Your Ryu node only accepts devices you have approved. Start below, then approve the code in the Ryu desktop app under Devices & access."
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
				caption="A phone, browser, or another device asking to use this node. Check the code matches what that device is showing before you approve."
				title="Devices waiting to connect"
			>
				{accessListsReady ? (
					pending.length === 0 ? (
						<SettingsCard className="text-center text-muted-foreground text-sm">
							Nothing waiting.
						</SettingsCard>
					) : (
						<SettingsCard className="px-0 py-0">
							<ul className="mx-3.5 divide-y divide-border/60">
								{pending.map((req) => (
									<li
										className="flex items-start justify-between gap-3 py-2.5"
										key={req.user_code}
									>
										<div className="min-w-0">
											<p className="truncate text-sm" title={req.client_name}>
												{req.client_name}
											</p>
											<div className="mt-1">
												<OTPCodeDisplay
													aria-label={`${req.client_name} pairing code`}
													code={req.user_code}
													size="compact"
												/>
											</div>
											{req.requested_scopes &&
											req.requested_scopes.length > 0 ? (
												<fieldset className="mt-2">
													<legend className="text-muted-foreground text-xs">
														Grant access
													</legend>
													<p className="type-caption text-muted-foreground">
														Clear anything this device should not use.
													</p>
													<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
														{req.requested_scopes.map((scope, scopeIndex) => {
															const checkboxId = `pair-${req.user_code}-scope-${scopeIndex}`;
															const selected =
																selectedScopes[req.user_code] ??
																req.requested_scopes ??
																[];
															return (
																<label
																	className="type-caption flex cursor-pointer items-center gap-1.5 font-mono"
																	htmlFor={checkboxId}
																	key={scope}
																>
																	<Checkbox
																		checked={selected.includes(scope)}
																		disabled={busy}
																		id={checkboxId}
																		onCheckedChange={(checked) =>
																			setSelectedScopes((current) => {
																				const currentSelection =
																					current[req.user_code] ??
																					req.requested_scopes ??
																					[];
																				return {
																					...current,
																					[req.user_code]: narrowPairingScopes({
																						checked: checked === true,
																						requested:
																							req.requested_scopes ?? [],
																						scope,
																						selected: currentSelection,
																					}),
																				};
																			})
																		}
																	/>
																	{scope}
																</label>
															);
														})}
													</div>
												</fieldset>
											) : (
												<ScopeList
													emptyLabel={
														req.requested_scopes
															? "No capabilities requested"
															: "Default read-only access"
													}
													label="Requested access"
													scopes={req.requested_scopes}
												/>
											)}
											<p className="mt-2 text-muted-foreground text-xs">
												Binding:{" "}
												{describePairingConstraints(
													req.requested_constraints
												).join(", ")}
											</p>
											{req.requested_expires_at == null ? null : (
												<p className="text-muted-foreground text-xs">
													Expires{" "}
													{formatPairingTimestamp(req.requested_expires_at) ??
														"at an invalid time"}
												</p>
											)}
										</div>
										<div className="flex shrink-0 gap-2">
											<Button
												aria-label={`Deny ${req.client_name}`}
												disabled={busy}
												onClick={() => void decide(req.user_code, false)}
												size="sm"
												variant="ghost"
											>
												Deny
											</Button>
											<Button
												aria-label={`Approve ${req.client_name} with requested access`}
												disabled={busy}
												onClick={() => void decide(req.user_code, true)}
												size="sm"
											>
												Approve
											</Button>
										</div>
									</li>
								))}
							</ul>
						</SettingsCard>
					)
				) : null}
			</SettingsSection>

			<SettingsSection
				caption="Devices you have already approved. Revoking one signs it out immediately without affecting anything else."
				title="Connected devices"
			>
				{accessListsReady ? (
					clients.length === 0 ? (
						<SettingsCard className="text-center text-muted-foreground text-sm">
							No paired devices.
						</SettingsCard>
					) : (
						<SettingsCard className="px-0 py-0">
							<ul className="mx-3.5 divide-y divide-border/60">
								{clients.map((client) => (
									<li
										className="flex items-start justify-between gap-3 py-2.5"
										key={client.id}
									>
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<p className="truncate text-sm" title={client.name}>
													{client.name}
												</p>
												<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
													{getPairedClientStatus(client)}
												</span>
											</div>
											<ScopeList
												emptyLabel={
													client.granted_scopes === undefined &&
													(client.schema_version ?? 0) < 2
														? "Legacy read-only access"
														: "No capabilities granted"
												}
												label="Granted access"
												scopes={client.granted_scopes}
											/>
											<p className="mt-2 text-muted-foreground text-xs">
												Binding:{" "}
												{describePairingConstraints(client.constraints).join(
													", "
												)}
											</p>
											<p className="text-muted-foreground text-xs">
												{client.expires_at == null
													? "Does not expire"
													: `Expires ${formatPairingTimestamp(client.expires_at) ?? "at an invalid time"}`}
												{client.revoked_at == null
													? ""
													: ` · Revoked ${formatPairingTimestamp(client.revoked_at) ?? "at an invalid time"}`}
											</p>
										</div>
										{canRevokePairedClient(client) ? (
											<Button
												aria-label={`Revoke ${client.name}`}
												disabled={busy}
												onClick={() => void revoke(client)}
												size="sm"
												variant="ghost"
											>
												Revoke
											</Button>
										) : null}
									</li>
								))}
							</ul>
						</SettingsCard>
					)
				) : null}
			</SettingsSection>

			<SettingsSection
				caption="Apps on this device pick this up automatically. You only need to copy it by hand for something that cannot ask to be approved, like a headless server you reach over SSH."
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
									This token comes from the <code>RYU_TOKEN</code> environment
									variable, which takes priority over the stored one. To change
									it, change that variable; rotating here would have no effect.
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

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const pairingConstraintsResponseCodec = z
	.object({
		agent_id: z.string().optional(),
		client_id: z.string().optional(),
		node_id: z.string().optional(),
		org_id: z.string().optional(),
		plugin_id: z.string().optional(),
		resource_id: z.string().optional(),
		subject_id: z.string().optional(),
		team_id: z.string().optional(),
		tool_name: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const pairingRequestResponseCodec = z
	.object({
		client_name: z.string(),
		created_at: z.number(),
		requested_constraints: pairingConstraintsResponseCodec.optional(),
		requested_expires_at: z.union([z.number(), z.null()]).optional(),
		requested_scopes: z.array(z.string()).optional(),
		user_code: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec1 = z
	.object({ requests: z.array(pairingRequestResponseCodec) })
	.catchall(gatewayJsonValueSchema);
const pairedClientResponseCodec = z
	.object({
		active: z.boolean().optional(),
		constraints: pairingConstraintsResponseCodec.optional(),
		created_at: z.number(),
		expires_at: z.union([z.number(), z.null()]).optional(),
		granted_scopes: z.array(z.string()).optional(),
		id: z.string(),
		last_seen: z.number(),
		name: z.string(),
		revoked_at: z.union([z.number(), z.null()]).optional(),
		schema_version: z.number().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec2 = z
	.object({ clients: z.array(pairedClientResponseCodec) })
	.catchall(gatewayJsonValueSchema);
const responseCodec3 = gatewayJsonValueSchema.optional();
const responseCodec4 = gatewayJsonValueSchema.optional();
const responseCodec5 = z
	.object({ message: z.string(), restart_required: z.boolean() })
	.catchall(gatewayJsonValueSchema);
