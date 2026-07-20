// The desktop-rendered surface for a plugin-contributed **companion**
// (`RunnableKind::Companion`). Companions are declared in a plugin's manifest and
// surfaced by Core via `GET /api/plugins/contributions`; this page is where an
// enabled plugin's companion becomes a navigable, visible panel in the shell.
//
// Third-party code-execution gate: with the experimental flag OFF (the default),
// this renders a benign, data-driven summary of the declared companion and runs
// NO plugin code (exactly WF2's behavior). With the flag ON AND the plugin
// carrying a UI bundle, it mounts the plugin's own sandboxed UI through
// `PluginHostPanel` → `ExtensionHost` (a null-origin iframe, capability-gated
// against the plugin's Gateway-approved grants). The flag gate is
// `shouldLoadThirdPartyUi`, kept pure so the `flag_off_no_code` test asserts it.

import { PuzzleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { useMemo } from "react";
import { PluginHostPanel } from "@/src/contributions/host/PluginHostPanel.tsx";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import {
	PLUGIN_RUNTIME_FLAG,
	shouldLoadThirdPartyUi,
	useExperimentalFlag,
} from "@/src/lib/experimental.ts";

export default function PluginCompanionPage({
	companionId,
	mountContext,
}: {
	companionId: string;
	/** Optional host-supplied context baked into the sandboxed frame as
	 *  `window.ryu.context` (e.g. `{ workflowId }` when a deep-link opens the
	 *  Workflows canvas on a specific workflow). Forwarded to PluginHostPanel. */
	mountContext?: unknown;
}) {
	const { companions } = usePluginContributions();
	const { enabled: runtimeFlagOn } = useExperimentalFlag(PLUGIN_RUNTIME_FLAG);
	const companion = companions.find((c) => c.id === companionId);

	// Stabilise the context by serialized content so an inline `{ workflowId }`
	// object from a route render-fn doesn't churn a new reference each render (the
	// frame's srcdoc is memoized on `mountContext` identity — an unstable ref would
	// reload the iframe on every parent re-render).
	const contextKey = JSON.stringify(mountContext ?? null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: contextKey is the content hash of mountContext.
	const stableContext = useMemo(() => mountContext, [contextKey]);

	// The single decision gate for running third-party code. OFF (default) or a
	// plugin with no bundle → the benign summary below; never a fetch, never code.
	if (companion && shouldLoadThirdPartyUi(runtimeFlagOn, companion.hasUi)) {
		return <PluginHostPanel companion={companion} mountContext={stableContext} />;
	}

	if (!companion) {
		return (
			<div className="flex h-full items-center justify-center p-6">
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={PuzzleIcon} />
						</EmptyMedia>
						<EmptyTitle>Companion unavailable</EmptyTitle>
						<EmptyDescription>
							This plugin companion is no longer enabled, or the plugin that
							provided it has been disabled.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		);
	}

	// `app__<runnable id>` — strip the `app__` prefix for a cleaner owning-plugin
	// hint without hardcoding any specific plugin.
	const ownerHint = companion.id.startsWith("app__")
		? companion.id.slice("app__".length)
		: companion.id;

	return (
		<div className="flex h-full flex-col overflow-y-auto p-6">
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
				<div className="flex items-center gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<HugeiconsIcon className="size-5" icon={PuzzleIcon} />
					</div>
					<div className="min-w-0">
						<h1 className="truncate font-semibold text-lg">
							{companion.label || companion.name}
						</h1>
						<p className="truncate text-muted-foreground text-sm">
							Companion surface · {ownerHint}
						</p>
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="secondary">Plugin companion</Badge>
					{companion.shortcut ? (
						<Badge variant="outline">{companion.shortcut}</Badge>
					) : null}
				</div>

				<div className="rounded-lg border bg-card p-4 text-card-foreground text-sm leading-relaxed">
					<p>
						<span className="font-medium">{companion.name}</span> is provided by
						an enabled plugin and is available here. Its interactive panel loads
						once the plugin runtime host is connected.
					</p>
				</div>
			</div>
		</div>
	);
}
