import { Download01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { RyuOnboardingAvatar } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
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
		<div className="scroll-fade h-full w-full overflow-y-auto">
			<div
				className="flex min-h-full w-full flex-col items-center justify-center gap-8 p-8"
				data-tauri-drag-region="true"
			>
				<StaggerReveal>
					<div className="shrink-0">
						<RyuOnboardingAvatar />
					</div>
					<PageHeader
						stagger={false}
						subtitle="Let's make sure this desktop app is ready to go."
						title="Before we get started"
					/>
				</StaggerReveal>

				<div className="flex w-full max-w-md flex-col gap-5">
					<div
						aria-live="polite"
						className="flex flex-col items-center gap-3 text-center"
						data-testid="desktop-update-status"
					>
						<div
							className={cn(
								"flex size-16 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground",
								isAvailable && "bg-primary/10 text-primary",
								isError && "bg-destructive/10 text-status-destructive"
							)}
						>
							<HugeiconsIcon
								aria-hidden="true"
								className={cn("size-7", checking && "animate-spin")}
								icon={isAvailable ? Download01Icon : Refresh01Icon}
							/>
						</div>
						<div className="space-y-1">
							<h1 className="font-medium text-lg tracking-tight">
								{copy.title}
							</h1>
							<p className="text-muted-foreground text-sm">
								{copy.description}
							</p>
						</div>
					</div>

					<div className="flex items-center justify-between gap-4 rounded-xl bg-muted/50 px-4 py-3">
						<div className="min-w-0">
							<p className="font-medium text-sm">{APP_UPDATE_DOWNLOAD_TITLE}</p>
							<p className="text-muted-foreground text-xs">
								{APP_UPDATE_DOWNLOAD_DESCRIPTION}
							</p>
						</div>
						<Switch
							aria-label={APP_UPDATE_DOWNLOAD_ARIA_LABEL}
							checked={automaticDownload}
							onCheckedChange={onToggleAutomaticDownload}
						/>
					</div>

					<div className="flex flex-wrap items-center justify-center gap-2">
						{isAvailable && onInstall ? (
							<Button
								disabled={downloading}
								onClick={onInstall}
								variant="default"
							>
								{downloading
									? "Preparing…"
									: prepared
										? APP_UPDATE_INSTALL_ACTION
										: "Download and install"}
							</Button>
						) : null}
						{isError && onCheck ? (
							<Button disabled={checking} onClick={onCheck} variant="outline">
								{checking ? "Checking…" : "Try again"}
							</Button>
						) : null}
						<Button
							onClick={onContinue}
							variant={isAvailable ? "outline" : "default"}
						>
							Continue
						</Button>
					</div>
				</div>
			</div>
		</div>
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
