import {
	CheckmarkCircle02Icon,
	Delete01Icon,
	Download01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isBlockedFit } from "@ryu/blocks/desktop/model-fit.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useState } from "react";
import {
	friendlyQuant,
	type GgufRole,
	ggufFileRole,
	isModelGgufFile,
} from "./friendly.ts";
import type {
	FitStyle,
	InstallButton,
} from "./models-catalog-section-format.ts";
import {
	FitInstallNotice,
	InstallErrorNote,
	useInstallAttempt,
} from "./models-catalog-section-install-notice.tsx";
import {
	QualityMeter,
	QuantizationPicker,
} from "./models-catalog-section-quant-picker.tsx";
import type { ModelDetail, ModelFile } from "./types.ts";

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
 * The "Installed" affordance for a downloaded quant: a button that reads
 * "Installed" at rest and morphs into a destructive "Uninstall" on hover/focus,
 * so the same control that installed a file also removes it (no separate icon).
 */
function InstalledButton({
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

function FileRow({
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
