import {
	CheckmarkCircle02Icon,
	Delete01Icon,
	Download01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	isBlockedRepoFit,
	pickBestFit,
} from "@ryu/blocks/desktop/model-fit.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { isModelGgufFile } from "../friendly.ts";
import type { ModelCard, ModelDetail, ModelFile } from "../types.ts";
import type { FitStyle, InstallButton } from "./models-helpers.ts";
import {
	FitInstallNotice,
	InstallErrorNote,
	useInstallAttempt,
} from "./models-install.tsx";

/**
 * The "Installed" affordance for a downloaded quant: a button that reads
 * "Installed" at rest and morphs into a destructive "Uninstall" on hover/focus,
 * so the same control that installed a file also removes it (no separate icon).
 */
export function InstalledButton({
	busy,
	onUninstall,
}: {
	busy: boolean;
	onUninstall: () => void;
}) {
	const [armed, setArmed] = useState(false);
	// Resolve the three visual states (busy / armed-to-remove / at-rest) without
	// nested ternaries.
	let label = "Added";
	if (busy) {
		label = "Removing…";
	} else if (armed) {
		label = "Remove";
	}
	return (
		<Button
			className="shrink-0"
			loading={busy}
			onBlur={() => setArmed(false)}
			onClick={onUninstall}
			onFocus={() => setArmed(true)}
			onMouseEnter={() => setArmed(true)}
			onMouseLeave={() => setArmed(false)}
			size="sm"
			variant={armed ? "destructive" : "secondary"}
		>
			{!busy && (
				<HugeiconsIcon
					className={armed ? "size-3.5" : "size-3.5 text-status-success"}
					icon={armed ? Delete01Icon : CheckmarkCircle02Icon}
				/>
			)}
			{label}
		</Button>
	);
}

/** GB string for a snapshot repo's total size. */
export function formatRepoSize(bytes: number | null): string {
	if (!bytes || bytes <= 0) {
		return "Size unknown";
	}
	const gb = bytes / 1_000_000_000;
	if (gb >= 1) {
		return `${gb.toFixed(1)} GB`;
	}
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Snapshot install block for safetensors / MLX models — a single "install the
 * whole repo" action (no per-quant picker). Shows the repo size + a conservative
 * fit label, and gates the button when no engine for this format is runnable on
 * the node or when the repo would not fit its memory or free disk.
 */
export function SnapshotInstall({
	card,
	device,
	installed,
	installing,
	onInstall,
	repoSizeBytes,
	repoFit,
	repoFitLabel,
	InstallButton,
}: {
	card: ModelCard;
	device: ModelDetail["device"];
	installed: boolean;
	installing: boolean;
	onInstall: () => Promise<void>;
	repoSizeBytes: number | null;
	repoFit: string;
	repoFitLabel: string;
	InstallButton: InstallButton;
}) {
	const incompatible = !card.compatible;
	const tl = useLiteralMessages();
	const blockedByFit = isBlockedRepoFit(repoFit, device);
	const blocked = incompatible || blockedByFit;
	const { attempt, error } = useInstallAttempt();
	return (
		<section className="flex flex-col gap-3">
			<h3 className="font-medium text-sm">
				{card.format === "mlx" ? "MLX model" : "Safetensors model"}
			</h3>
			<div className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-4 py-3">
				<div className="min-w-0">
					<p className="font-medium text-sm">{formatRepoSize(repoSizeBytes)}</p>
					{incompatible ? (
						<p className="text-muted-foreground text-xs">
							{card.format === "mlx"
								? "Requires MLX (Apple Silicon) — not available on this computer."
								: card.needsEngine === null
									? tl(
											"Requires another engine — not available on this computer."
										)
									: tl(
											"Requires {engineName} — not available on this computer.",
											{ engineName: card.needsEngine }
										)}
						</p>
					) : (
						<>
							{/* The blocked notice leads with the fit label itself. */}
							{!(blockedByFit && !installed) && (
								<p className="text-muted-foreground text-xs">
									{repoFitLabel || "Adds the full model repository."}
								</p>
							)}
							{!installed && (
								<FitInstallNotice
									blocking={blockedByFit}
									device={device}
									fit={repoFit}
									label={repoFitLabel}
								/>
							)}
						</>
					)}
				</div>
				{installed ? (
					<Badge variant="secondary">
						<HugeiconsIcon className="size-3.5" icon={CheckmarkCircle02Icon} />
						Added
					</Badge>
				) : (
					<InstallButton
						busyLabel="Adding…"
						disabled={blocked || installing}
						idleVariant="ghost"
						installing={installing}
						onClick={() => {
							if (!blocked) {
								attempt(onInstall);
							}
						}}
						// Snapshot downloads label as "<repo_id> (<file>)" — match on the id.
						progress={{ kinds: ["model"], name: card.id }}
					>
						<HugeiconsIcon className="size-4" icon={Download01Icon} />
						Add repository
					</InstallButton>
				)}
			</div>
			<InstallErrorNote message={error} />
		</section>
	);
}

export interface FileSectionsProps {
	/** The serving node's hardware: its OS picks the recommendation badge and its
	 *  RAM / free disk explain a blocked install. */
	device: ModelDetail["device"];
	files: ModelFile[];
	fitStyle: FitStyle;
	friendly: boolean;
	InstallButton: InstallButton;
	install: (file: string) => Promise<void>;
	installing: string | null;
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
}

/** Badge text for the recommended quant, matched to the detected OS. */
export function recommendedBadgeText(os: string): string {
	if (os === "macos") {
		return "Recommended for your Mac";
	}
	if (os === "windows" || os === "linux") {
		return "Recommended for your PC";
	}
	return "Recommended for your device";
}

/**
 * Pick the quantization to preselect in the download dropdown: the best device
 * fit, breaking ties toward the smaller file (more likely to actually run).
 * Blocked quants rank last (shared `FIT_RANK`), so one is picked only when none
 * fits. `null` only when there are no files at all. Mirrors the desktop deep-link
 * recommendation (`pickRecommendedQuant`) minus its installed-file preference —
 * the picker only ever lists not-installed downloads.
 */
export function pickRecommendedFile(files: ModelFile[]): ModelFile | null {
	return pickBestFit(files.filter((file) => isModelGgufFile(file.filename)));
}
