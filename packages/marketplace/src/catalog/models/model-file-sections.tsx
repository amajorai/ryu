import {
	CheckmarkCircle02Icon,
	Download01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isBlockedFit } from "@ryu/blocks/desktop/model-fit.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import {
	friendlyQuant,
	type GgufRole,
	ggufFileRole,
	isModelGgufFile,
	QUANT_QUALITY_MAX,
} from "../friendly.ts";
import type { ModelDetail, ModelFile } from "../types.ts";
import {
	type FileSectionsProps,
	InstalledButton,
} from "./model-install-actions.tsx";
import { QuantizationPicker } from "./model-quant-picker.tsx";
import type { FitStyle, InstallButton } from "./models-helpers.ts";
import {
	FitInstallNotice,
	InstallErrorNote,
	useInstallAttempt,
} from "./models-install.tsx";

/**
 * The detail panel's file list, split into three reads: an "Installed" section,
 * "Download options" (the model's own quantizations), and "Add-ons" — auxiliary
 * files like vision adapters and draft/MTP heads that pair with a base model.
 *
 * The download options are collapsed into a single select that preselects the
 * best-fitting quantization for this device; installed quants and add-ons keep
 * their flat per-file rows.
 */
export function FileSections({
	files,
	friendly,
	device,
	install,
	installing,
	uninstall,
	uninstalling,
	InstallButton,
	fitStyle,
}: FileSectionsProps) {
	const visibleFiles = files.filter(
		(file) =>
			isModelGgufFile(file.filename) || ggufFileRole(file.filename) !== null
	);

	if (visibleFiles.length === 0) {
		return (
			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-sm">Download options</h3>
				<p className="text-muted-foreground text-sm">
					No GGUF files found in this repo. It may not be runnable with the
					local engine.
				</p>
			</section>
		);
	}

	const renderRow = (f: ModelFile) => {
		const role = ggufFileRole(f.filename);
		return (
			<FileRow
				device={device}
				file={f}
				fitStyle={fitStyle}
				friendly={friendly}
				InstallButton={InstallButton}
				install={install}
				installing={installing}
				key={f.filename}
				role={role}
				uninstall={uninstall}
				uninstalling={uninstalling}
			/>
		);
	};

	const installed = visibleFiles.filter((f) => f.installed);
	const notInstalled = visibleFiles.filter((f) => !f.installed);
	const downloads = notInstalled.filter((f) => isModelGgufFile(f.filename));
	const addons = notInstalled.filter((f) => ggufFileRole(f.filename) !== null);

	return (
		<div className="flex flex-col gap-5">
			{installed.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="flex items-center gap-1.5 font-medium text-sm">
						<HugeiconsIcon
							className="size-4 text-status-success"
							icon={CheckmarkCircle02Icon}
						/>
						Added
					</h3>
					<ul className="flex flex-col gap-2">{installed.map(renderRow)}</ul>
				</section>
			)}
			{downloads.length > 0 && (
				<QuantizationPicker
					device={device}
					files={downloads}
					fitStyle={fitStyle}
					friendly={friendly}
					InstallButton={InstallButton}
					install={install}
					installing={installing}
				/>
			)}
			{addons.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Add-ons</h3>
					<p className="text-muted-foreground text-xs">
						Optional companion files (vision adapters, draft heads) that pair
						with a model quant above — not standalone models.
					</p>
					<ul className="flex flex-col gap-2">{addons.map(renderRow)}</ul>
				</section>
			)}
		</div>
	);
}

/**
 * A segmented "more bars = better" quality meter for a friendly-mode quant.
 * Rendered only when the quality is known.
 */
// Stable pip levels (1..max) so each meter segment has a fixed key identity.
export const QUALITY_PIPS = Array.from(
	{ length: QUANT_QUALITY_MAX },
	(_, i) => i + 1
);

export function QualityMeter({
	quality,
	label,
}: {
	quality: number;
	label: string;
}) {
	const tl = useLiteralMessages();
	return (
		<span
			aria-label={tl("Quality: {quality} of {maxQuality} ({qualityLabel})", {
				quality,
				maxQuality: QUANT_QUALITY_MAX,
				qualityLabel: label,
			})}
			className="flex items-center gap-0.5"
			role="img"
		>
			{QUALITY_PIPS.map((level) => (
				<span
					className={`h-2.5 w-1 rounded-full ${level <= quality ? "bg-success" : "bg-muted-foreground/25"}`}
					key={level}
				/>
			))}
		</span>
	);
}

export function FileRow({
	device,
	file,
	install,
	installing,
	uninstall,
	uninstalling,
	friendly,
	role,
	InstallButton,
	fitStyle,
}: {
	device: ModelDetail["device"];
	file: ModelFile;
	install: (file: string) => Promise<void>;
	installing: string | null;
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
	friendly: boolean;
	role?: GgufRole | null;
	InstallButton: InstallButton;
	fitStyle: FitStyle;
}) {
	const fit = fitStyle(file.fit);
	const isInstalling = installing === file.filename;
	const isUninstalling = uninstalling === file.filename;
	const blocked = isBlockedFit(file.fit);
	const compression = friendlyQuant(file.quant);
	const { attempt, error: installError } = useInstallAttempt();
	const handleInstall = () => {
		if (!blocked) {
			attempt(() => install(file.filename));
		}
	};
	const handleUninstall = () => {
		uninstall(file.filename).catch(() => undefined);
	};

	// Auxiliary files (vision adapter / draft head) aren't model quants, so they
	// get their role label and an explanatory tooltip — never a quality meter.
	const renderLabel = () => {
		if (role) {
			return (
				<Tooltip>
					<TooltipTrigger
						render={<span className="font-medium text-sm">{role.label}</span>}
					/>
					<TooltipContent>{role.tooltip}</TooltipContent>
				</Tooltip>
			);
		}
		if (friendly) {
			return (
				<Tooltip>
					<TooltipTrigger
						render={
							<span className="flex items-center gap-2">
								{compression.quality !== null && (
									<QualityMeter
										label={compression.label}
										quality={compression.quality}
									/>
								)}
								<span className="font-medium text-sm">{compression.label}</span>
							</span>
						}
					/>
					<TooltipContent>{compression.tooltip}</TooltipContent>
				</Tooltip>
			);
		}
		return <span className="font-medium text-sm">{file.quant ?? "GGUF"}</span>;
	};

	const installButton = (
		<InstallButton
			disabled={blocked}
			idleVariant={blocked ? "outline" : "ghost"}
			installing={isInstalling}
			onClick={handleInstall}
			progress={{ kinds: ["model"], name: file.filename }}
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
			Add
		</InstallButton>
	);

	return (
		<li className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					{renderLabel()}
					{file.sizeHuman && (
						<span className="text-muted-foreground text-xs">
							{file.sizeHuman}
						</span>
					)}
				</div>
				{/* A blocked file's notice below already leads with its fit label. */}
				{!(blocked && !file.installed) && (
					<div
						className={`mt-0.5 flex items-center gap-1.5 text-xs ${fit.className}`}
					>
						<span className={`size-1.5 rounded-full ${fit.dot}`} />
						{file.fitLabel}
					</div>
				)}
				{!file.installed && (
					<div className="mt-0.5">
						<FitInstallNotice
							device={device}
							fit={file.fit}
							label={file.fitLabel}
						/>
						<InstallErrorNote message={installError} />
					</div>
				)}
			</div>
			{file.installed ? (
				<InstalledButton busy={isUninstalling} onUninstall={handleUninstall} />
			) : (
				installButton
			)}
		</li>
	);
}
