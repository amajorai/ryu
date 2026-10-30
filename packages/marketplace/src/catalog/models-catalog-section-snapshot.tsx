import {
	AiBrain01Icon,
	CheckmarkCircle02Icon,
	DollarCircleIcon,
	Download01Icon,
	FlashIcon,
	HardDriveIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isBlockedRepoFit } from "@ryu/blocks/desktop/model-fit.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { formatCurrency } from "@ryu/ui/lib/number-format.ts";
import type { ReactNode } from "react";
import type { InstallButton } from "./models-catalog-section-format.ts";
import {
	FitInstallNotice,
	InstallErrorNote,
	useInstallAttempt,
} from "./models-catalog-section-install-notice.tsx";
import type { ModelCard, ModelDetail } from "./types.ts";

export function StatsBlock({
	stats,
	present,
}: {
	stats: ModelDetail["stats"];
	present: boolean;
}) {
	const tl = useLiteralMessages();
	if (!stats) {
		if (!present) {
			return (
				<section className="rounded-lg bg-muted px-4 py-3 text-muted-foreground text-xs">
					Add an Artificial Analysis API key (
					<code>ARTIFICIAL_ANALYSIS_API_KEY</code>) to see independent speed,
					quality, and price benchmarks here.
				</section>
			);
		}
		return null;
	}

	const items: {
		icon: typeof AiBrain01Icon;
		label: string;
		money?: boolean;
		value: ReactNode;
	}[] = [
		{
			icon: AiBrain01Icon,
			label: "Intelligence",
			value:
				stats.intelligenceIndex === null
					? null
					: stats.intelligenceIndex.toFixed(0),
		},
		{
			icon: FlashIcon,
			label: "Speed (tok/s)",
			value:
				stats.outputTokensPerSecond === null
					? null
					: stats.outputTokensPerSecond.toFixed(0),
		},
		{
			icon: HardDriveIcon,
			label: "First token",
			value:
				stats.timeToFirstTokenS === null
					? null
					: `${stats.timeToFirstTokenS.toFixed(2)}s`,
		},
		{
			icon: DollarCircleIcon,
			label: "Price /1M",
			value:
				stats.priceUsdPer1m === null
					? null
					: formatCurrency(stats.priceUsdPer1m, "USD", {
							maximumFractionDigits: 2,
							minimumFractionDigits: 2,
						}),
			money: true,
		},
	];

	return (
		<section className="flex flex-col gap-2 rounded-lg border px-4 py-3">
			<div className="flex items-center gap-2 text-sm">
				<span className="font-medium">Benchmarks</span>
				<span className="text-muted-foreground text-xs">
					{tl("via Artificial Analysis ({matchedName})", {
						matchedName: stats.matchedName,
					})}
				</span>
			</div>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{items.map((it) => (
					<div className="flex flex-col gap-0.5" key={it.label}>
						<span className="flex items-center gap-1 text-muted-foreground text-xs">
							<HugeiconsIcon className="size-3.5" icon={it.icon} />
							{it.label}
						</span>
						<span
							className={`font-medium text-sm ${
								it.money ? "tabular-nums" : ""
							}`}
						>
							{it.value ?? "—"}
						</span>
					</div>
				))}
			</div>
		</section>
	);
}

/** GB string for a snapshot repo's total size. */
function formatRepoSize(bytes: number | null): string {
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
	const tl = useLiteralMessages();
	const incompatible = !card.compatible;
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
								: tl("Requires {engine} — not available on this computer.", {
										engine: card.needsEngine ?? tl("another engine"),
									})}
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
