import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isBlockedFit, pickBestFit } from "@ryu/blocks/desktop/model-fit.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useEffect, useMemo, useState } from "react";
import {
	friendlyQuant,
	isModelGgufFile,
	QUANT_QUALITY_MAX,
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
import type { ModelDetail, ModelFile } from "./types.ts";

/** Badge text for the recommended quant, matched to the detected OS. */
function recommendedBadgeText(os: string): string {
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

/**
 * The "Download options" read, collapsed into one dropdown: every available
 * quantization is an option, defaulting to the best device fit for this machine
 * (badged "Recommended"). The selected quant's fit line renders under the select
 * and the Add button installs whatever is currently selected — no more scanning
 * a full list of quants to find the one that runs.
 */
export function QuantizationPicker({
	files,
	friendly,
	device,
	install,
	installing,
	InstallButton,
	fitStyle,
}: {
	files: ModelFile[];
	friendly: boolean;
	device: ModelDetail["device"];
	install: (file: string) => Promise<void>;
	installing: string | null;
	InstallButton: InstallButton;
	fitStyle: FitStyle;
}) {
	const tl = useLiteralMessages();
	const recommended = useMemo(() => pickRecommendedFile(files), [files]);
	const recommendedFilename = recommended?.filename ?? null;
	const [selected, setSelected] = useState<string | null>(recommendedFilename);

	// Preserve an explicitly selected quant while it is present or its download is
	// pending. A successful install removes it from `files`, at which point the
	// picker falls back to the best remaining recommendation; a failed install
	// restores it without changing the user's retry target.
	useEffect(() => {
		if (
			selected !== null &&
			(files.some((file) => file.filename === selected) ||
				installing === selected)
		) {
			return;
		}
		setSelected(recommendedFilename);
	}, [files, installing, recommendedFilename, selected]);

	const selectedFile =
		files.find((f) => f.filename === selected) ?? recommended ?? null;
	// A blocked quant is never "recommended", even when it is the only option.
	const isRecommended =
		selectedFile?.filename === recommendedFilename &&
		!isBlockedFit(selectedFile.fit);
	const fit = selectedFile ? fitStyle(selectedFile.fit) : null;
	const compression = selectedFile ? friendlyQuant(selectedFile.quant) : null;
	const blocked = selectedFile ? isBlockedFit(selectedFile.fit) : false;
	const isInstalling =
		selectedFile !== null && installing === selectedFile.filename;

	const { attempt, error: installError } = useInstallAttempt();
	const installSelected = () => {
		if (selectedFile && !blocked) {
			attempt(() => install(selectedFile.filename));
		}
	};

	const triggerLabel = () => {
		if (!selectedFile) {
			return "Pick a compression level";
		}
		return (
			<span className="flex min-w-0 items-center gap-2">
				<span className="truncate">
					{friendly && compression?.label
						? compression.label
						: (selectedFile.quant ?? "GGUF")}
				</span>
				{friendly && selectedFile.quant && (
					<span className="shrink-0 text-muted-foreground text-xs">
						{selectedFile.quant}
					</span>
				)}
				{selectedFile.sizeHuman && (
					<span className="shrink-0 text-muted-foreground text-xs">
						{selectedFile.sizeHuman}
					</span>
				)}
			</span>
		);
	};

	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-medium text-sm">Download options</h3>
				{isRecommended && (
					<Badge variant="secondary">{recommendedBadgeText(device.os)}</Badge>
				)}
			</div>
			<div className="flex items-center gap-2">
				<Select
					onValueChange={(v) => setSelected(v)}
					value={selectedFile?.filename ?? null}
				>
					<SelectTrigger className="min-w-0 flex-1" size="default">
						<SelectValue placeholder="Pick a compression level">
							{() => triggerLabel()}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{files.map((f) => {
							const fFit = fitStyle(f.fit);
							const fComp = friendlyQuant(f.quant);
							const fLabel =
								friendly && fComp.quality !== null
									? fComp.label
									: (f.quant ?? "GGUF");
							return (
								<SelectItem
									key={f.filename}
									textValue={`${f.quant ?? ""} ${f.sizeHuman ?? ""} ${f.fitLabel}`}
									value={f.filename}
								>
									<span className="flex w-full items-center gap-2">
										<span
											className={`size-1.5 shrink-0 rounded-full ${fFit.dot}`}
										/>
										{friendly && fComp.quality !== null && (
											<QualityMeter
												label={fComp.label}
												quality={fComp.quality}
											/>
										)}
										<span className="truncate" title={fLabel}>
											{fLabel}
										</span>
										{friendly && f.quant && (
											<span className="shrink-0 text-muted-foreground text-xs">
												{f.quant}
											</span>
										)}
										<span className="ml-auto shrink-0 text-muted-foreground text-xs">
											{isBlockedFit(f.fit)
												? tl("{sizeHuman} · won't fit", {
														sizeHuman: f.sizeHuman,
													})
												: f.sizeHuman}
										</span>
									</span>
								</SelectItem>
							);
						})}
					</SelectContent>
				</Select>
				{selectedFile && (
					// Blocked quants keep the button visible but disabled; the reason
					// renders as text right below so it reaches keyboard and screen
					// reader users too (a tooltip on a disabled button would not).
					<InstallButton
						disabled={blocked}
						idleVariant="outline"
						installing={isInstalling}
						onClick={installSelected}
						progress={{ kinds: ["model"], name: selectedFile.filename }}
					>
						<HugeiconsIcon className="size-4" icon={Download01Icon} />
						Add
					</InstallButton>
				)}
			</div>
			{selectedFile && fit && !blocked && (
				<div className={`flex items-center gap-1.5 text-xs ${fit.className}`}>
					<span className={`size-1.5 rounded-full ${fit.dot}`} />
					{selectedFile.fitLabel}
				</div>
			)}
			{selectedFile && (
				<FitInstallNotice
					device={device}
					fit={selectedFile.fit}
					label={selectedFile.fitLabel}
				/>
			)}
			<InstallErrorNote message={installError} />
		</section>
	);
}

/**
 * A segmented "more bars = better" quality meter for a friendly-mode quant.
 * Rendered only when the quality is known.
 */
// Stable pip levels (1..max) so each meter segment has a fixed key identity.
const QUALITY_PIPS = Array.from({ length: QUANT_QUALITY_MAX }, (_, i) => i + 1);

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
			aria-label={tl("Quality: {quality} of {max} ({label})", {
				quality,
				max: QUANT_QUALITY_MAX,
				label,
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
