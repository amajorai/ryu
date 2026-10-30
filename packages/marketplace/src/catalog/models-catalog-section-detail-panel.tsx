import {
	AiBrain01Icon,
	BrainIcon,
	SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { friendlyModelName, isModelGgufFile } from "./friendly.ts";
import { useCatalogHost } from "./host.tsx";
import {
	ModelDetailHeader,
	ModelOverviewGrid,
	ModelSpecsRow,
} from "./models-catalog-section-detail-header.tsx";
import { FileSections } from "./models-catalog-section-file-sections.tsx";
import { fineTuneHrefForModel } from "./models-catalog-section-format.ts";
import {
	FinetunedVariants,
	LlmfitEstimateBlock,
	modelCanChat,
} from "./models-catalog-section-llmfit.tsx";
import { pickRecommendedFile } from "./models-catalog-section-quant-picker.tsx";
import {
	SnapshotInstall,
	StatsBlock,
} from "./models-catalog-section-snapshot.tsx";
import type { ModelDetail } from "./types.ts";

export function ModelDetailPanel({
	selectedId,
	detail,
	loading,
	error,
	install,
	installing,
	installSnapshot,
	installingSnapshot,
	uninstall,
	uninstalling,
	friendly,
	activeTokens,
	onToggleToken,
	onSelectOrg,
}: {
	selectedId: string | null;
	detail: ModelDetail | null;
	loading: boolean;
	error: string | null;
	install: (file: string) => Promise<void>;
	installing: string | null;
	installSnapshot: () => Promise<void>;
	installingSnapshot: boolean;
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
	friendly: boolean;
	activeTokens: Set<string>;
	onToggleToken: (id: string) => void;
	onSelectOrg: (org: string) => void;
}) {
	const host = useCatalogHost();
	const tl = useLiteralMessages();
	const installLayer = host.install;
	const Markdown = host.Markdown;
	const ActiveModelControl = host.ActiveModelControl;

	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={BrainIcon} />
					</EmptyMedia>
					<EmptyTitle>No model selected</EmptyTitle>
					<EmptyDescription>
						Pick a model on the left to read what it does and see whether it
						runs on your device.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	if (loading && !detail) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<div className="p-4 text-sm text-status-destructive">
				{tl("Couldn't load this model: {error}", { error })}
			</div>
		);
	}
	if (!detail) {
		return null;
	}

	const {
		card,
		files,
		vision,
		stats,
		statsApiKeyPresent,
		device,
		readme,
		format,
		repoSizeBytes,
		repoFit,
		repoFitLabel,
	} = detail;
	const modelFiles = files.filter((file) => isModelGgufFile(file.filename));
	const recommendedLlmfitFile =
		pickRecommendedFile(modelFiles.filter((file) => !file.installed)) ??
		pickRecommendedFile(modelFiles);
	const chatCapable = modelCanChat(card);

	return (
		<div className="flex flex-col gap-6 p-4">
			<ModelDetailHeader
				activeTokens={activeTokens}
				card={card}
				friendly={friendly}
				onSelectOrg={onSelectOrg}
				onToggleToken={onToggleToken}
			/>

			{/* Read-only surface (web): the primary action is deep-linking into Ryu,
			    which owns the actual download/install flow. */}
			{!installLayer && host.renderAffordance && (
				<div className="flex">
					{host.renderAffordance({
						id: card.id,
						name: card.name,
						realm: "model",
					})}
				</div>
			)}

			<ModelSpecsRow card={card} />
			<ModelOverviewGrid card={card} device={device} />

			{/* Keep the first useful action beside the device-fit summary. */}
			{installLayer && card.installed && (
				<section className="flex items-center justify-between gap-3 rounded-xl border bg-card/50 px-4 py-3">
					<div className="min-w-0">
						<p className="font-medium text-sm">
							{chatCapable ? "Run in chat" : "Use this model"}
						</p>
						<p className="text-muted-foreground text-xs">
							{chatCapable
								? "Ryu will select a compatible engine, install it if needed, and open a chat with this model."
								: "Select this installed model for its local runtime."}
						</p>
					</div>
					<ActiveModelControl
						chatCapable={chatCapable}
						format={format}
						modelName={
							friendly ? friendlyModelName(card.name, card.tags) : card.name
						}
						repoId={card.id}
					/>
				</section>
			)}

			{/* GGUF: per-quant file picker. Snapshot formats (safetensors/MLX):
			    one repository install. Keep download and quant choice near the fit
			    summary so the first-run path is visible without scrolling past details. */}
			{installLayer &&
				(format === "gguf" ? (
					<FileSections
						device={device}
						files={files}
						fitStyle={host.fitStyle}
						friendly={friendly}
						InstallButton={installLayer.InstallButton}
						install={install}
						installing={installing}
						uninstall={uninstall}
						uninstalling={uninstalling}
					/>
				) : (
					<SnapshotInstall
						card={card}
						device={device}
						InstallButton={installLayer.InstallButton}
						installed={card.installed}
						installing={installingSnapshot}
						onInstall={installSnapshot}
						repoFit={repoFit ?? ""}
						repoFitLabel={repoFitLabel}
						repoSizeBytes={repoSizeBytes}
					/>
				))}

			{installLayer && (
				<LlmfitEstimateBlock
					context={card.contextLength}
					// Keyed by model: a cached detail skips the spinner, so without a
					// remount one model's estimate (or a late in-flight one) showed
					// under the next.
					key={card.id}
					quant={recommendedLlmfitFile?.quant ?? null}
					repo={card.id}
				/>
			)}

			{/* Stats from Artificial Analysis */}
			<StatsBlock present={statsApiKeyPresent} stats={stats} />

			{/* Gated-model notice */}
			{card.gated && (
				<section className="flex gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-muted-foreground text-xs">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-status-warning"
						icon={SquareLock01Icon}
					/>
					<p>
						This is a gated model. Add a Hugging Face access token in{" "}
						<span className="font-medium text-foreground">
							Settings → Integrations
						</span>{" "}
						and accept this model's terms on its{" "}
						<a
							className="underline hover:text-foreground"
							href={`https://huggingface.co/${card.id}`}
							rel="noopener noreferrer"
							target="_blank"
						>
							Hugging Face page
						</a>{" "}
						before downloading.
					</p>
				</section>
			)}

			{/* Adapt this model to your own data with a LoRA fine-tune (Unsloth).
			    Opens the Fine-tune page. Install-capable surfaces with a shell only. */}
			{installLayer && host.navigate && chatCapable && (
				<section className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-4 py-3">
					<div className="min-w-0">
						<p className="font-medium text-sm">Fine-tune this model</p>
						<p className="text-muted-foreground text-xs">
							Train a LoRA on your data, then merge to a servable GGUF.
						</p>
					</div>
					<Button
						onClick={() => host.navigate?.(fineTuneHrefForModel(card.id))}
						size="sm"
						variant="ghost"
					>
						Fine-tune
					</Button>
				</section>
			)}

			{/* Fine-tuned variants of this model: merged GGUFs trained from it. */}
			{installLayer && <FinetunedVariants baseId={card.id} />}

			{/* Vision model: the matching projector installs automatically. */}
			{vision && (
				<section className="flex gap-2 rounded-lg border bg-muted/50 px-4 py-3 text-muted-foreground text-xs">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-status-info"
						icon={AiBrain01Icon}
					/>
					<p>
						This is a{" "}
						<span className="font-medium text-foreground">vision model</span>.
						Its image adapter is downloaded automatically alongside the quant
						you choose, and loaded for you when the model runs.
					</p>
				</section>
			)}

			{/* README */}
			{readme && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">About this model</h3>
					<div className="prose prose-sm dark:prose-invert max-w-none text-sm">
						<Markdown className="[&_ol]:pl-10 [&_ul]:pl-9" content={readme} />
					</div>
				</section>
			)}
		</div>
	);
}
