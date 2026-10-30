// packages/marketplace/src/catalog/detail/detail-panels.tsx
//
// The remaining detail tabs — README, Versions, Dependencies — plus the metadata
// strip that sits under the listing's name.
//
// These are deliberately small and data-shaped. Each renders exactly what the
// catalog reported and says so plainly when a source reported nothing, rather
// than fabricating a plausible-looking blank ("0 downloads" for a source that
// does not count downloads is a lie, "not reported" is not).

import { Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentType } from "react";
import { safeHttpUrl } from "../safe-url.ts";

export { DependenciesPanel, hasDependencies } from "./dependencies-panel.tsx";
export { formatCount, formatDate } from "./detail-format.ts";
export { DetailMetaStrip } from "./detail-meta-strip.tsx";
export { VersionsPanel } from "./versions-panel.tsx";

/** The README tab. Markdown rendering crosses the host seam (desktop renders
 *  with Streamdown, web with react-markdown), so the component is passed in. */
export function ReadmePanel({
	Markdown,
	readme,
	readmeUrl,
}: {
	Markdown: ComponentType<{ className?: string; content: string }>;
	readme: string;
	readmeUrl?: string | null;
}) {
	const href = safeHttpUrl(readmeUrl);
	return (
		<div className="flex flex-col gap-3">
			<Markdown
				className="prose prose-sm dark:prose-invert max-w-none"
				content={readme}
			/>
			{href ? (
				<a
					className="inline-flex items-center gap-1.5 text-muted-foreground text-xs hover:underline"
					href={href}
					rel="noopener noreferrer"
					target="_blank"
				>
					<HugeiconsIcon className="size-3.5" icon={Link01Icon} />
					Read the original
				</a>
			) : null}
		</div>
	);
}
