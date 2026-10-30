import { ArrowUpRight01Icon, FileCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { safeNavigationUrl } from "@ryu/ui/lib/safe-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { ComponentProps } from "react";
import { AgentUI } from "./agent-ui/agent-ui.tsx";
import {
	AgentUiSurfaceChip,
	useAgentUiSurfaceHost,
} from "./agent-ui/surface-context.tsx";
import { useArtifactHost } from "./artifact-host-context.tsx";
import { artifactIdForPart } from "./tools/artifact-tool.ts";
import type {
	ArtifactTurnEndCard,
	FileEditUndoPlan,
	JsonRenderTurnEndCard,
	TurnEndCard,
} from "./turn-end-cards.ts";
import { FileEditsCard } from "./turn-end-cards-file-edits.tsx";
import { nativeArtifactReactChild } from "./utils/native-artifact-render-abi.ts";
import type { NativeSdkValue } from "./utils/native-sdk-observation.ts";

function JsonRenderCard({
	card,
	onSubmit,
}: {
	card: JsonRenderTurnEndCard;
	onSubmit?: ComponentProps<typeof AgentUI>["onSubmit"];
}) {
	const surfaceHost = useAgentUiSurfaceHost();
	if (surfaceHost) {
		return (
			<AgentUiSurfaceChip
				host={surfaceHost}
				surface={{
					format: card.format,
					// The render's tool call id when known, so the chip names the same
					// render the host tracks (`deriveLiveAgentUiSurface`).
					id: card.toolCallId ?? card.id,
					spec: card.spec,
					title: card.title,
				}}
			/>
		);
	}
	return (
		<section
			className="overflow-hidden rounded-xl border border-border"
			data-slot="turn-json-render-card"
		>
			<header className="flex h-10 items-center gap-2 border-border border-b px-4">
				<span className="shrink-0 text-muted-foreground text-xs">
					{card.format === "a2ui" ? "A2UI" : "JSON UI"}
				</span>
				{card.title ? (
					<h3 className="min-w-0 truncate font-medium text-sm">{card.title}</h3>
				) : null}
			</header>
			<div className="p-3">
				<AgentUI
					format={card.format}
					onSubmit={onSubmit}
					persistKey={card.toolCallId}
					persistTitle={card.title}
					spec={card.spec}
				/>
			</div>
		</section>
	);
}

function safeArtifactUrl(value: NativeSdkValue): string | undefined {
	return safeNavigationUrl(value) ?? undefined;
}

function ArtifactCard({ card }: { card: ArtifactTurnEndCard }) {
	const host = useArtifactHost();
	if (host) {
		const Renderer = host.Renderer;
		// The inline tool row's id, so the page keeps the state saved while the
		// turn was streaming and opens the same panel/tab.
		const artifactId = card.toolCallId
			? artifactIdForPart(card.toolCallId)
			: card.id;
		return (
			<div className="w-full" data-slot="turn-artifact-card">
				<Renderer artifact={card.artifact} id={artifactId} />
			</div>
		);
	}
	const url = safeArtifactUrl(card.artifact.url);
	return (
		<section
			className="flex items-center gap-3 rounded-xl border border-border px-4 py-3"
			data-slot="turn-artifact-card"
		>
			<HugeiconsIcon
				aria-hidden
				className="size-5 shrink-0 text-muted-foreground"
				icon={FileCodeIcon}
			/>
			<span className="min-w-0 flex-1 truncate font-medium text-sm">
				{nativeArtifactReactChild(card.artifact.title ?? "Artifact")}
			</span>
			{url ? (
				<a
					className={cn(
						"inline-flex shrink-0 items-center gap-1 text-primary text-sm hover:underline"
					)}
					href={url}
					rel="noopener noreferrer"
					target="_blank"
				>
					Open
					<HugeiconsIcon
						aria-hidden
						className="size-3.5"
						icon={ArrowUpRight01Icon}
					/>
				</a>
			) : null}
		</section>
	);
}

export function TurnEndCards({
	cards,
	onAgentUiSubmit,
	onOpenFile,
	onReviewFileEdits,
	onUndoFileEdits,
}: {
	cards: TurnEndCard[];
	onAgentUiSubmit?: ComponentProps<typeof AgentUI>["onSubmit"];
	onOpenFile?: (path: string) => void;
	onReviewFileEdits?: (paths: string[]) => void;
	onUndoFileEdits?: (plan: FileEditUndoPlan) => Promise<void>;
}) {
	if (cards.length === 0) {
		return null;
	}
	return (
		<div
			className="flex w-full max-w-full flex-col gap-3"
			data-slot="turn-end-cards"
		>
			{cards.map((card) => {
				if (card.kind === "file-edits") {
					return (
						<FileEditsCard
							card={card}
							key={card.id}
							onOpenFile={onOpenFile}
							onReview={onReviewFileEdits}
							onUndo={onUndoFileEdits}
						/>
					);
				}
				if (card.kind === "json-render") {
					return (
						<JsonRenderCard
							card={card}
							key={card.id}
							onSubmit={onAgentUiSubmit}
						/>
					);
				}
				return <ArtifactCard card={card} key={card.id} />;
			})}
		</div>
	);
}
