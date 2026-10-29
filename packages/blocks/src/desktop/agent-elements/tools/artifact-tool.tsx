import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { useArtifactHost } from "../artifact-host-context.tsx";
import type { NativeArtifactObservation } from "../native-artifact-observation.ts";
import {
	NativeArtifactGenericTool,
	nativeArtifactReactChild,
} from "../utils/native-artifact-render-abi.ts";
import type { NativeSdkValue } from "../utils/native-sdk-observation.ts";
import {
	artifactFromCreateResult,
	artifactFromInput,
} from "./artifact-tool.ts";
import { GenericTool } from "./generic-tool.tsx";

export type { HostArtifact } from "../artifact-host-context.tsx";
export {
	artifactFromCreateResult,
	artifactFromInput,
	artifactIdForPart,
	isArtifactPart,
} from "./artifact-tool.ts";

/**
 * Inline artifact surface for the built-in `artifact.render` tool (and the
 * created-file result of `artifact.create`).
 *
 * The agent's payload is normalized into a loose {@link HostArtifact} and handed
 * to the desktop's injected Renderer, which draws the real artifact card (preview
 * + Open / Open in tab). With no host mounted the part degrades to a plain tool
 * row, mirroring the widget host.
 */

export interface ArtifactToolProps {
	/** Stable id for the artifact, derived from the tool call id upstream. */
	id: string;
	part: {
		input?: NativeSdkValue;
		output?: NativeSdkValue;
		state?: string;
		type?: string;
	};
}

export function ArtifactTool({ id, part }: ArtifactToolProps) {
	const host = useArtifactHost();
	const isCreate = part.type === "tool-artifact.create";
	const artifact = useMemo(() => {
		// `artifact.create` delivers the payload in its RESULT (the tool wrote the
		// file); `artifact.render` delivers it in its INPUT. Read both, preferring
		// the created-file shape when it has arrived.
		const input = part.input;
		const output = part.output;
		if (isCreate) {
			const created = artifactFromCreateResult(input, output);
			if (created) {
				return created;
			}
			// Still in flight: no result yet. Show nothing rather than a half card.
			return null;
		}
		const fromInput = artifactFromInput(input);
		if (fromInput) {
			return fromInput;
		}
		return artifactFromInput(output);
	}, [isCreate, part.input, part.output]);

	if (!artifact) {
		return <GenericTool isPending title="Rendering artifact" />;
	}

	if (!host) {
		// No desktop host (island / storyboard / extension): a plain, inert row —
		// the payload is still visible through the default tool output.
		return (
			<NativeArtifactGenericTool
				isPending={false}
				title={artifact.title ?? "Artifact"}
			/>
		);
	}

	return <host.Renderer artifact={artifact} id={id} />;
}

/** A compact fallback card used by tests / non-host surfaces that still want a
 *  hint that an artifact was produced. */
export function ArtifactRowHint({
	artifact,
}: {
	artifact: NativeArtifactObservation | null;
}) {
	return (
		<div className="flex items-center gap-2 px-3 py-2 text-xs">
			<HugeiconsIcon
				aria-hidden
				className="size-3.5 shrink-0 text-muted-foreground"
				icon={File01Icon}
			/>
			<span className="min-w-0 flex-1 truncate text-foreground">
				{nativeArtifactReactChild(artifact?.title ?? "Artifact")}
			</span>
		</div>
	);
}
