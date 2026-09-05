import {
	Alert02Icon,
	ArrowRight01Icon,
	CheckmarkCircle02Icon,
	InformationCircleIcon,
	LinkSquare02Icon,
	Package01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { ConnectionPermissionDialog } from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchComposioConnectionStatus,
	fetchComposioConnections,
	fetchComposioStatus,
	initiateComposioConnection,
} from "@/src/lib/api/composio.ts";
import {
	formatPrivatePackageShareCode,
	installPortablePackage,
	normalizePrivatePackageShareCode,
	type PackageConnectionRequirement,
	type PrivatePackageSharePreview,
	previewPrivatePackageShareCode,
	redeemPrivatePackageShareCode,
} from "@/src/lib/api/marketplace.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

type InstallStage = "entry" | "preview" | "installing" | "complete";
type SetupState =
	| "checking"
	| "connected"
	| "needs_connection"
	| "optional"
	| "unavailable"
	| "error";

interface ConnectionStatus {
	message: string;
	state: SetupState;
}

const ACTIVE_CONNECTION_STATES = new Set(["active", "connected", "ready"]);

function isComposioRequirement(
	requirement: PackageConnectionRequirement
): boolean {
	return (
		requirement.provider.toLowerCase() === "composio" ||
		Boolean(requirement.toolkit)
	);
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setupSummary(
	requirements: PackageConnectionRequirement[],
	statuses: Map<string, ConnectionStatus>
): { connected: number; missing: number; required: number } {
	const required = requirements.filter((requirement) => requirement.required);
	const connected = required.filter(
		(requirement) => statuses.get(requirement.id)?.state === "connected"
	).length;
	return {
		connected,
		missing: required.length - connected,
		required: required.length,
	};
}

function statusLabel(state: SetupState): string {
	if (state === "connected") {
		return "Connected";
	}
	if (state === "optional") {
		return "Optional";
	}
	if (state === "checking") {
		return "Checking";
	}
	if (state === "unavailable") {
		return "Unavailable";
	}
	if (state === "error") {
		return "Could not check";
	}
	return "Needs connection";
}

function statusIcon(state: SetupState) {
	return state === "connected" ? CheckmarkCircle02Icon : Alert02Icon;
}

export default function PrivatePackageInstallDialog({
	onClose,
	open,
}: {
	onClose: () => void;
	open: boolean;
}) {
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [preview, setPreview] = useState<PrivatePackageSharePreview | null>(
		null
	);
	const [installSession, setInstallSession] = useState<string | null>(null);
	const [setupStatuses, setSetupStatuses] = useState<
		Map<string, ConnectionStatus>
	>(() => new Map());
	const [stage, setStage] = useState<InstallStage>("entry");
	const [connectingId, setConnectingId] = useState<string | null>(null);
	const [permissionRequirement, setPermissionRequirement] =
		useState<PackageConnectionRequirement | null>(null);
	const openGateway = useGatewayDialog((state) => state.openGateway);

	const reset = useCallback(() => {
		setCode("");
		setError(null);
		setLoading(false);
		setPreview(null);
		setInstallSession(null);
		setSetupStatuses(new Map());
		setStage("entry");
		setConnectingId(null);
		setPermissionRequirement(null);
	}, []);

	useEffect(() => {
		if (open) {
			reset();
		}
	}, [open, reset]);

	const refreshSetup = useCallback(
		async (nextPreview: PrivatePackageSharePreview) => {
			const requirements = nextPreview.connections;
			if (requirements.length === 0) {
				setSetupStatuses(new Map());
				return;
			}

			const initial = new Map(
				requirements.map((requirement) => [
					requirement.id,
					{
						message: "Checking this node…",
						state: "checking" as const,
					},
				])
			);
			setSetupStatuses(initial);
			const target = toTarget(useNodeStore.getState().getActiveNode());
			let composioConfigured = false;
			try {
				composioConfigured = (await fetchComposioStatus(target)).configured;
			} catch {
				// The per-row error below gives the user a useful recovery CTA.
			}

			const next = new Map<string, ConnectionStatus>();
			await Promise.all(
				requirements.map(async (requirement) => {
					if (!(isComposioRequirement(requirement) && requirement.toolkit)) {
						next.set(requirement.id, {
							message: requirement.required
								? "This provider is not available on the selected node."
								: "This optional provider is not available on the selected node.",
							state: requirement.required ? "unavailable" : "optional",
						});
						return;
					}
					if (!composioConfigured) {
						next.set(requirement.id, {
							message: requirement.required
								? "Composio is not configured on this node yet."
								: "Composio is not configured for this optional connection.",
							state: requirement.required ? "unavailable" : "optional",
						});
						return;
					}
					try {
						const connections = await fetchComposioConnections(
							target,
							requirement.toolkit
						);
						const connected = connections.some(
							(connection) =>
								connection.active ||
								ACTIVE_CONNECTION_STATES.has(connection.status.toLowerCase())
						);
						next.set(requirement.id, {
							message: connected
								? "Ready for this package."
								: requirement.required
									? "Authorize an account to use this package."
									: "Connect it later if you need this optional capability.",
							state: connected
								? "connected"
								: requirement.required
									? "needs_connection"
									: "optional",
						});
					} catch {
						next.set(requirement.id, {
							message: requirement.required
								? "The connection status could not be checked."
								: "The optional connection status could not be checked.",
							state: "error",
						});
					}
				})
			);
			setSetupStatuses(next);
		},
		[]
	);

	const handlePreview = async () => {
		setError(null);
		setLoading(true);
		try {
			const nextPreview = await previewPrivatePackageShareCode(code);
			setPreview(nextPreview);
			setStage("preview");
			await refreshSetup(nextPreview);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "That package code is not available."
			);
		} finally {
			setLoading(false);
		}
	};

	const handleInstall = async () => {
		if (!preview) {
			return;
		}
		setError(null);
		setLoading(true);
		setStage("installing");
		try {
			let session = installSession;
			let redeemedPreview = preview;
			if (!session) {
				const redeemed = await redeemPrivatePackageShareCode(code);
				session = redeemed.installSession;
				redeemedPreview = redeemed.preview;
				setInstallSession(session);
				setPreview(redeemedPreview);
			}
			if (!(session && redeemedPreview)) {
				throw new Error("The package install session could not be prepared.");
			}
			await installPortablePackage(
				toTarget(useNodeStore.getState().getActiveNode()),
				{
					id: redeemedPreview.id,
					kind: redeemedPreview.kind,
				},
				{ installSession: session }
			);
			setStage("complete");
			await refreshSetup(redeemedPreview);
		} catch (cause) {
			setStage("preview");
			setError(
				cause instanceof Error
					? cause.message
					: "The package could not be installed."
			);
		} finally {
			setLoading(false);
		}
	};

	const requestConnection = (requirement: PackageConnectionRequirement) => {
		if (setupStatuses.get(requirement.id)?.state === "unavailable") {
			openGateway("integrations");
			return;
		}
		if (!requirement.toolkit) {
			openGateway("integrations");
			return;
		}
		setPermissionRequirement(requirement);
	};

	const handleConnect = async (
		requirement: PackageConnectionRequirement,
		accessLevel: ConnectionAccessLevel
	) => {
		const toolkit = requirement.toolkit;
		if (!toolkit) {
			openGateway("integrations");
			return;
		}
		setConnectingId(requirement.id);
		setError(null);
		try {
			const target = toTarget(useNodeStore.getState().getActiveNode());
			const connection = await initiateComposioConnection(
				target,
				toolkit,
				accessLevel
			);
			if (!(connection.redirectUrl && connection.connectionId)) {
				throw new Error("Composio did not return an authorization link.");
			}
			await openExternal(connection.redirectUrl);
			for (let attempt = 0; attempt < 20; attempt += 1) {
				await wait(1500);
				const status = await fetchComposioConnectionStatus(
					target,
					connection.connectionId
				);
				if (
					status.active ||
					ACTIVE_CONNECTION_STATES.has(status.status.toLowerCase())
				) {
					if (preview) {
						await refreshSetup(preview);
					}
					sileo.success({
						title: `${requirement.displayName} connected`,
						description: "This package can use the account now.",
					});
					return;
				}
			}
			sileo.info({
				title: "Finish authorization in your browser",
				description:
					"We’ll keep the package here so you can check again when you’re done.",
			});
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not start the connection."
			);
			throw cause;
		} finally {
			setConnectingId(null);
		}
	};

	const summary = useMemo(
		() => setupSummary(preview?.connections ?? [], setupStatuses),
		[preview?.connections, setupStatuses]
	);
	const ready = summary.missing === 0;
	const canInstall = preview?.verification === "verified";
	const normalizedCode = normalizePrivatePackageShareCode(code);
	const canPreview = normalizedCode.length === 12 && !loading;

	return (
		<>
			<Dialog
				onOpenChange={(nextOpen) => {
					if (!nextOpen) {
						onClose();
					}
				}}
				open={open}
			>
				<DialogContent className="max-h-[88vh] overflow-hidden p-0 sm:max-w-xl">
					<DialogHeader className="border-border/60 border-b px-6 py-5 text-left">
						<div className="flex items-start gap-3">
							<div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
								<HugeiconsIcon className="size-5" icon={Package01Icon} />
							</div>
							<div className="min-w-0">
								<DialogTitle>Install a private package</DialogTitle>
								<DialogDescription className="mt-1">
									Enter the code from your publisher. You’ll see exactly what it
									needs before anything is installed.
								</DialogDescription>
							</div>
						</div>
					</DialogHeader>

					<div className="scroll-fade max-h-[calc(88vh-10rem)] overflow-y-auto px-6 py-5">
						{stage === "entry" ? (
							<form
								className="space-y-5"
								onSubmit={(event) => {
									event.preventDefault();
									if (canPreview) {
										void handlePreview();
									}
								}}
							>
								<div className="rounded-xl border border-border/70 bg-muted/20 p-4">
									<div className="mb-3 flex items-center gap-2 font-medium text-sm">
										<HugeiconsIcon
											className="size-4 text-muted-foreground"
											icon={Shield01Icon}
										/>
										Private by default
									</div>
									<p className="text-muted-foreground text-sm leading-6">
										The code grants access to one package release. It does not
										contain credentials, and it can be revoked by the publisher.
									</p>
								</div>
								<label
									className="block space-y-2"
									htmlFor="private-package-code"
								>
									<span className="font-medium text-sm">Package code</span>
									<Input
										id="private-package-code"
										inputMode="text"
										maxLength={14}
										onBlur={() => setCode(formatPrivatePackageShareCode(code))}
										onChange={(event) =>
											setCode(event.target.value.toUpperCase())
										}
										placeholder="7K4M-X2QP-9F6D"
										spellCheck={false}
										value={code}
									/>
									<span className="text-muted-foreground text-xs">
										12 characters · letters and numbers · hyphens are optional
									</span>
								</label>
								{error ? <ErrorNotice message={error} /> : null}
								<DialogFooter className="px-0 pt-1">
									<Button disabled={!canPreview} type="submit">
										{loading ? <Spinner className="size-4" /> : null}
										Preview package
										{loading ? null : (
											<HugeiconsIcon
												className="size-4"
												icon={ArrowRight01Icon}
											/>
										)}
									</Button>
								</DialogFooter>
							</form>
						) : preview ? (
							<div className="space-y-5">
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="mb-1 flex flex-wrap items-center gap-2">
											<h3 className="font-medium text-lg">{preview.name}</h3>
											<Badge variant="secondary">
												{preview.kind.replaceAll("_", " ")}
											</Badge>
										</div>
										<p className="text-muted-foreground text-sm">
											{preview.description ?? "Private package shared with you"}
										</p>
									</div>
									<Badge
										className="shrink-0 gap-1.5"
										variant={
											preview.verification === "invalid"
												? "destructive"
												: "outline"
										}
									>
										<HugeiconsIcon className="size-3.5" icon={Shield01Icon} />
										{preview.verification === "verified"
											? "Verified"
											: preview.verification === "unsigned"
												? "Unsigned release"
												: preview.verification === "invalid"
													? "Signature invalid"
													: "Verification unavailable"}
									</Badge>
								</div>
								<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
									<Badge variant="secondary">
										{preview.audience === "organization"
											? "Organization-bound"
											: "Shareable code"}
									</Badge>
									{preview.version ? (
										<span>Version {preview.version}</span>
									) : null}
									{preview.expiresAt ? (
										<span>
											Expires {new Date(preview.expiresAt).toLocaleDateString()}
										</span>
									) : null}
								</div>
								{preview.capabilities.length > 0 ? (
									<div className="rounded-xl border border-border/70 p-4">
										<p className="mb-2 font-medium text-sm">
											Included capabilities
										</p>
										<div className="flex flex-wrap gap-1.5">
											{preview.capabilities.map((capability) => (
												<Badge key={capability} variant="outline">
													{capability}
												</Badge>
											))}
										</div>
									</div>
								) : null}

								<div className="rounded-xl border border-border/70 bg-muted/20 p-4">
									<div className="mb-3 flex items-center justify-between gap-3">
										<div>
											<p className="font-medium text-sm">Connection setup</p>
											<p className="mt-1 text-muted-foreground text-xs">
												{summary.required === 0
													? "No external accounts are required."
													: ready
														? "Everything required is connected."
														: `${summary.missing} required connection${summary.missing === 1 ? "" : "s"} still needed`}
											</p>
										</div>
										{stage === "complete" ? (
											<Badge variant={ready ? "default" : "secondary"}>
												{ready ? "Ready to run" : "Finish setup"}
											</Badge>
										) : null}
									</div>
									{preview.connections.length > 0 ? (
										<div className="space-y-2">
											{preview.connections.map((requirement) => (
												<ConnectionRow
													connecting={connectingId === requirement.id}
													key={requirement.id}
													onConnect={() => requestConnection(requirement)}
													requirement={requirement}
													status={setupStatuses.get(requirement.id)}
												/>
											))}
										</div>
									) : null}
								</div>

								<div className="flex items-start gap-2 text-muted-foreground text-xs leading-5">
									<HugeiconsIcon
										className="mt-0.5 size-4 shrink-0"
										icon={InformationCircleIcon}
									/>
									<span>
										Installing adds the package definition to this node. Account
										authorization stays with you and is never included in the
										shared package.
									</span>
								</div>
								{canInstall ? null : (
									<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-destructive text-sm">
										{preview.verification === "unsigned"
											? "This release is not signed. Ask the publisher for a signed release before installing."
											: "Ryu could not verify this release, so installation is unavailable."}
									</div>
								)}

								{error ? <ErrorNotice message={error} /> : null}
								<DialogFooter className="gap-2 px-0">
									{stage === "complete" ? (
										<Button onClick={onClose} type="button">
											Done
										</Button>
									) : (
										<>
											<Button
												disabled={loading}
												onClick={() => {
													setStage("entry");
													setPreview(null);
													setInstallSession(null);
													setError(null);
												}}
												type="button"
												variant="ghost"
											>
												Use another code
											</Button>
											<Button
												disabled={loading || !canInstall}
												onClick={() => void handleInstall()}
												type="button"
											>
												{loading ? <Spinner className="size-4" /> : null}
												{loading ? "Installing…" : "Install package"}
												{loading ? null : (
													<HugeiconsIcon
														className="size-4"
														icon={ArrowRight01Icon}
													/>
												)}
											</Button>
										</>
									)}
								</DialogFooter>
							</div>
						) : null}
					</div>
				</DialogContent>
			</Dialog>
			<ConnectionPermissionDialog
				connectionName={
					permissionRequirement?.displayName ?? "this integration"
				}
				connectionType="Composio"
				onConfirm={async (accessLevel) => {
					if (!permissionRequirement) {
						return;
					}
					await handleConnect(permissionRequirement, accessLevel);
					setPermissionRequirement(null);
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPermissionRequirement(null);
					}
				}}
				open={permissionRequirement !== null}
			/>
		</>
	);
}

function ConnectionRow({
	connecting,
	onConnect,
	requirement,
	status,
}: {
	connecting: boolean;
	onConnect: () => void;
	requirement: PackageConnectionRequirement;
	status?: ConnectionStatus;
}) {
	const state = status?.state ?? "checking";
	const canConnect =
		requirement.required &&
		(state === "needs_connection" ||
			state === "unavailable" ||
			state === "error");
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-3">
			<HugeiconsIcon
				className={
					state === "connected"
						? "size-4 shrink-0 text-emerald-500"
						: "size-4 shrink-0 text-muted-foreground"
				}
				icon={statusIcon(state)}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium text-sm">{requirement.displayName}</span>
					{requirement.required ? (
						<Badge className="text-[10px]" variant="outline">
							Required
						</Badge>
					) : (
						<Badge className="text-[10px]" variant="secondary">
							Optional
						</Badge>
					)}
				</div>
				<p className="mt-0.5 text-muted-foreground text-xs">
					{status?.message ?? "Checking this node…"}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<span className="hidden text-muted-foreground text-xs sm:inline">
					{statusLabel(state)}
				</span>
				{canConnect ? (
					<Button
						disabled={connecting}
						onClick={onConnect}
						size="sm"
						variant="outline"
					>
						{connecting ? (
							<Spinner className="size-3.5" />
						) : (
							<HugeiconsIcon className="size-3.5" icon={LinkSquare02Icon} />
						)}
						{state === "unavailable" ? "Configure" : "Connect"}
					</Button>
				) : null}
			</div>
		</div>
	);
}

function ErrorNotice({ message }: { message: string }) {
	return (
		<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-destructive text-sm">
			<HugeiconsIcon className="mt-0.5 size-4 shrink-0" icon={Alert02Icon} />
			<span>{message}</span>
		</div>
	);
}
