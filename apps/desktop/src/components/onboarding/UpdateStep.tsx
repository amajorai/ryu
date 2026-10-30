import { Download01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	installUpdate,
	prepareUpdate,
} from "@/src/components/updater/AutoUpdater.tsx";
import {
	APP_UPDATE_DOWNLOAD_ARIA_LABEL,
	APP_UPDATE_DOWNLOAD_DESCRIPTION,
	APP_UPDATE_DOWNLOAD_TITLE,
	APP_UPDATE_INSTALL_ACTION,
} from "@/src/components/updater/app-update-policy.ts";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	checkForUpdate,
	type UpdateCheck,
	updateCheckFailed,
} from "@/src/lib/api/update.ts";
import {
	getAutomaticAppUpdateDownload,
	setAutomaticAppUpdateDownload,
} from "@/src/lib/app-update-preparation.ts";
import { verdictAppliesToApp } from "@/src/lib/app-version.ts";
import { isLocalNode, type Node } from "@/src/store/useNodeStore.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

export type UpdateStepStatus =
	| "available"
	| "checking"
	| "error"
	| "up-to-date";

export interface UpdateStepViewProps {
	automaticDownload: boolean;
	availableVersion?: string | null;
	checking?: boolean;
	downloading?: boolean;
	errorMessage?: string | null;
	onCheck?: () => void;
	onContinue: () => void;
	onInstall?: () => void;
	onToggleAutomaticDownload?: (enabled: boolean) => void;
	prepared?: boolean;
	status: UpdateStepStatus;
}

function statusCopy(
	tl: LiteralMessage,
	status: UpdateStepStatus,
	availableVersion?: string | null,
	errorMessage?: string | null
) {
	if (status === "checking") {
		return {
			description: "Just a moment…",
			title: "Checking for updates",
		};
	}
	if (status === "available") {
		return {
			description: availableVersion
				? tl("Version {availableVersion} is ready", { availableVersion })
				: "A new version of Ryu is ready",
			title: "Update available",
		};
	}
	if (status === "error") {
		return {
			description:
				errorMessage ?? "You can continue and check again later in Settings.",
			title: "Couldn't check for updates",
		};
	}
	return {
		description: "Ryu is fully up to date",
		title: "You're on the latest version",
	};
}

/**
 * Presentational first-run update step. It intentionally keeps Continue
 * available while a check is in flight: a networked update service must never
 * become a gate for choosing local, cloud, or an existing node.
 */
export function UpdateStepView({
	automaticDownload,
	availableVersion,
	checking = false,
	downloading = false,
	errorMessage,
	onCheck,
	onContinue,
	onInstall,
	onToggleAutomaticDownload,
	prepared = false,
	status,
}: UpdateStepViewProps) {
	const tl = useLiteralMessages();
	const copy = statusCopy(tl, status, availableVersion, errorMessage);
	const isAvailable = status === "available";
	const isError = status === "error";

	return (
		<ActivationStepShell
			subtitle="Let's make sure this desktop app is ready to go."
			title="Before we get started"
		>
			<div
				aria-live="polite"
				className="flex items-start gap-3"
				data-testid="desktop-update-status"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"mt-0.5 shrink-0 text-muted-foreground",
						checking && "animate-spin",
						isError && "text-status-destructive"
					)}
					icon={isAvailable ? Download01Icon : Refresh01Icon}
					size={16}
				/>
				<div className="min-w-0">
					<h2 className="font-medium text-sm">{copy.title}</h2>
					<p className="text-pretty text-detail text-muted-foreground">
						{copy.description}
					</p>
				</div>
			</div>

			<div className="flex items-center justify-between gap-6 border-border border-t pt-4">
				<div className="min-w-0">
					<p className="font-medium text-sm">{APP_UPDATE_DOWNLOAD_TITLE}</p>
					<p className="text-detail text-muted-foreground">
						{APP_UPDATE_DOWNLOAD_DESCRIPTION}
					</p>
				</div>
				<Switch
					aria-label={APP_UPDATE_DOWNLOAD_ARIA_LABEL}
					checked={automaticDownload}
					onCheckedChange={onToggleAutomaticDownload}
				/>
			</div>

			<OnboardingActions>
				{isError && onCheck ? (
					<OnboardingCta disabled={checking} onClick={onCheck} tone="secondary">
						{checking ? "Checking…" : "Try again"}
					</OnboardingCta>
				) : null}
				<OnboardingCta
					onClick={onContinue}
					tone={isAvailable && onInstall ? "secondary" : "primary"}
				>
					Continue
				</OnboardingCta>
				{isAvailable && onInstall ? (
					<OnboardingCta disabled={downloading} onClick={onInstall}>
						{downloading
							? "Preparing…"
							: prepared
								? APP_UPDATE_INSTALL_ACTION
								: "Download and install"}
					</OnboardingCta>
				) : null}
			</OnboardingActions>
		</ActivationStepShell>
	);
}

interface UpdateStepProps {
	onContinue: () => void;
}

/** Desktop-only container for the first-run update check. */
export function UpdateStep({ onContinue }: UpdateStepProps) {
	const getNode = useActiveNodeGetter();
	const [automaticDownload, setAutomaticDownload] = useState(true);
	const [checking, setChecking] = useState(true);
	const [downloading, setDownloading] = useState(false);
	const [prepared, setPrepared] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [status, setStatus] = useState<UpdateStepStatus>("checking");
	const [available, setAvailable] = useState<UpdateCheck | null>(null);
	const [node, setNode] = useState<Node | null>(null);

	const check = useCallback(
		async (downloadAutomatically: boolean) => {
			setChecking(true);
			setStatus("checking");
			setErrorMessage(null);
			setAvailable(null);
			setPrepared(false);

			const activeNode = getNode();
			setNode(activeNode);
			const verdict = await checkForUpdate(toTarget(activeNode), {
				clamp: isLocalNode(activeNode),
			});
			if (updateCheckFailed(verdict)) {
				setStatus("error");
				setErrorMessage(
					verdict.error ?? "Check your connection and try again."
				);
				return;
			}

			const appliesToApp = await verdictAppliesToApp(verdict);
			if (verdict.update_available && appliesToApp) {
				setAvailable(verdict);
				setStatus("available");
				if (downloadAutomatically) {
					setDownloading(true);
					try {
						const ready = await prepareUpdate(verdict, { node: activeNode });
						setPrepared(ready !== null);
					} finally {
						setDownloading(false);
					}
				}
			} else {
				setStatus("up-to-date");
			}
		},
		[getNode]
	);

	useEffect(() => {
		let active = true;
		getAutomaticAppUpdateDownload()
			.then(async (enabled) => {
				if (active) {
					setAutomaticDownload(enabled);
				}
				await check(enabled);
			})
			.catch((error) => {
				if (!active) {
					return;
				}
				setStatus("error");
				setErrorMessage(
					error instanceof Error
						? error.message
						: "Check your connection and try again."
				);
			})
			.finally(() => {
				if (active) {
					setChecking(false);
				}
			});
		return () => {
			active = false;
		};
	}, [check]);

	const handleCheck = useCallback(() => {
		check(automaticDownload)
			.catch((error) => {
				setStatus("error");
				setErrorMessage(
					error instanceof Error
						? error.message
						: "Check your connection and try again."
				);
			})
			.finally(() => setChecking(false));
	}, [automaticDownload, check]);

	const handleToggle = useCallback(
		(next: boolean) => {
			const previous = automaticDownload;
			setAutomaticDownload(next);
			setAutomaticAppUpdateDownload(next)
				.then(async (saved) => {
					if (!saved) {
						setAutomaticDownload(previous);
						sileo.error({
							title: "Could not save the automatic-download setting",
						});
						return;
					}
					if (next && available && node) {
						setDownloading(true);
						try {
							const ready = await prepareUpdate(available, { node });
							setPrepared(ready !== null);
						} finally {
							setDownloading(false);
						}
					}
				})
				.catch(() => {
					setAutomaticDownload(previous);
					sileo.error({
						title: "Could not save the automatic-download setting",
					});
				});
		},
		[automaticDownload, available, node]
	);

	const handleInstall = useCallback(() => {
		if (!(available && node) || downloading) {
			return;
		}
		setDownloading(true);
		installUpdate(available, { node })
			.catch(() => undefined)
			.finally(() => setDownloading(false));
	}, [available, downloading, node]);

	return (
		<UpdateStepView
			automaticDownload={automaticDownload}
			availableVersion={available?.latest}
			checking={checking}
			downloading={downloading}
			errorMessage={errorMessage}
			onCheck={handleCheck}
			onContinue={onContinue}
			onInstall={handleInstall}
			onToggleAutomaticDownload={handleToggle}
			prepared={prepared}
			status={status}
		/>
	);
}
