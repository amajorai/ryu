// Renders a Space DOCUMENT owned by a Ryu App (kind `app:<pluginId>`) by mounting
// that app's Companion UI and handing it the document via the mount context. This is
// what lets a feature (e.g. the whiteboard) be a Ryu App while staying a first-class
// Space document — persisted, search-embedded, backlinked, versioned — instead of a
// hardcoded editor. The app loads/saves the doc from inside its sandbox via
// `window.ryu.spaces.getDoc/updateDoc` using the `{ spaceId, docId }` mount context.
//
// Route: `/spaces/:spaceId/app/:pluginId/:documentId` (the owning plugin id is in the
// path, so this page needs no document fetch to resolve the app — it just finds the
// enabled companion and mounts it).

import { PuzzleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { PluginHostPanel } from "@/src/contributions/host/PluginHostPanel.tsx";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";

export default function SpaceAppDocPage({
	spaceId,
	pluginId,
	documentId,
}: {
	spaceId: string;
	pluginId: string;
	documentId: string;
}) {
	const { companions } = usePluginContributions();
	// The owning app's companion (its UI bundle carries the editor). Resolve by the
	// plugin id baked in the route; the companion id is `app__<runnable>`, so match on
	// the manifest pluginId, not the companion id.
	const companion = companions.find((c) => c.pluginId === pluginId && c.hasUi);

	if (companion) {
		return (
			<PluginHostPanel
				companion={companion}
				mountContext={{ spaceId, docId: documentId }}
			/>
		);
	}

	return (
		<div className="flex h-full items-center justify-center p-6">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={PuzzleIcon} />
					</EmptyMedia>
					<EmptyTitle>App not available</EmptyTitle>
					<EmptyDescription>
						This document is owned by the app <code>{pluginId}</code>, which is
						not installed or enabled. Enable it from the Apps store to open this
						document.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</div>
	);
}
