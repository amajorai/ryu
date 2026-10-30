import { useCallback, useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchComposioConnectionStatus,
	fetchComposioConnections,
	fetchComposioStatus,
	initiateComposioConnection,
} from "@/src/lib/api/composio.ts";
import {
	forgetRedeemedPrivatePackageShareSession,
	installPortablePackage,
	normalizePrivatePackageShareCode,
	type PackageConnectionRequirement,
	type PrivatePackageSharePreview,
	peekRedeemedPrivatePackageShareSession,
	previewPrivatePackageShareCode,
	redeemPrivatePackageShareCode,
} from "@/src/lib/api/marketplace.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	ACTIVE_CONNECTION_STATES,
	type ConnectionStatus,
	type InstallStage,
	isComposioRequirement,
	setupSummary,
	wait,
} from "./private-package-setup.tsx";

/** The private-package install flow: code entry, preview, redemption, install
 *  and per-connection setup, reset whenever the dialog opens. */
export function usePrivatePackageInstall(open: boolean) {
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
			// This account already redeemed the code (an earlier install failed or
			// the dialog was closed): resume with that session. The server preview
			// rejects a code at its redemption ceiling, and redeeming it again would
			// spend another redemption. Install re-reads the session from the cache.
			const redeemed = peekRedeemedPrivatePackageShareSession(code);
			if (redeemed) {
				setPreview(redeemed.preview);
				setStage("preview");
				await refreshSetup(redeemed.preview);
				return;
			}
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
			// Reuse the session this account already redeemed for the code while it
			// is live (the cache drops it near expiry); redeeming again would spend
			// another of the code's redemptions.
			const reusable = peekRedeemedPrivatePackageShareSession(code);
			let session = reusable?.installSession ?? installSession;
			let redeemedPreview = reusable?.preview ?? preview;
			if (!session) {
				const redeemed = await redeemPrivatePackageShareCode(code);
				session = redeemed.installSession;
				redeemedPreview = redeemed.preview;
				// A session with a known expiry lives in the API cache; keep only an
				// expiry-less one in state so this dialog can retry without redeeming.
				setInstallSession(redeemed.installSessionExpiresAt ? null : session);
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
			forgetRedeemedPrivatePackageShareSession(code);
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

	return {
		canInstall,
		canPreview,
		code,
		connectingId,
		error,
		handleConnect,
		handleInstall,
		handlePreview,
		loading,
		permissionRequirement,
		preview,
		ready,
		requestConnection,
		setCode,
		setError,
		setInstallSession,
		setPermissionRequirement,
		setPreview,
		setStage,
		setupStatuses,
		stage,
		summary,
	};
}

export type PrivatePackageInstallState = ReturnType<
	typeof usePrivatePackageInstall
>;
