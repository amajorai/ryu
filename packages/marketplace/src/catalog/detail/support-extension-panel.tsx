import { ComputerIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { surfaceLabel } from "../surface-labels.ts";
import {
	extensionSummaries,
	implementationSummaries,
	inheritedSurfaceLabel,
	surfaceSupportLabel,
	surfaceSupportRows,
} from "../surface-summary.ts";
import type { CatalogEntry, PluginCatalogDetail } from "../types.ts";
import { ListingSection } from "./listing-detail-shell.tsx";

/** The catalog's three-axis explanation of a package.
 *
 * Support answers "where can I use it?" Extensions answer "what existing Ryu
 * capability or shell slot does it add to?" Implementation answers "which Ryu
 * boundary owns the work?" Keeping these separate prevents a `full` surface
 * badge from implying that a package edits Core or owns the Desktop shell. */
export function SupportExtensionPanel({
	detail,
	entry,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
}) {
	const support = surfaceSupportRows(detail, entry);
	const extensions = extensionSummaries(detail, entry);
	const implementation = implementationSummaries(detail, entry);
	if (
		support.length === 0 &&
		extensions.length === 0 &&
		implementation.length === 0
	) {
		return null;
	}

	return (
		<ListingSection icon={ComputerIcon} title="Support & extensions">
			<p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
				Support shows where this listing appears. Extensions show what it adds
				to Ryu. Implementation shows which boundary owns the work.
			</p>

			{support.length > 0 ? (
				<div
					className="grid gap-1.5 sm:grid-cols-2"
					data-testid="surface-support"
				>
					{support.map((row) => (
						<div
							className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-muted px-3 py-2"
							key={row.surface}
						>
							<div className="min-w-0">
								<p className="truncate font-medium text-sm">
									{surfaceLabel(row.surface)}
								</p>
								{inheritedSurfaceLabel(row.inheritedFrom) ? (
									<p className="truncate text-muted-foreground text-xs">
										{inheritedSurfaceLabel(row.inheritedFrom)}
									</p>
								) : null}
							</div>
							<Badge className="shrink-0" variant="outline">
								{surfaceSupportLabel(row.support)}
							</Badge>
						</div>
					))}
				</div>
			) : null}

			{extensions.length > 0 ? (
				<div className="flex flex-col gap-2" data-testid="surface-extensions">
					<h4 className="flex items-center gap-1.5 font-medium text-sm">
						<HugeiconsIcon
							aria-hidden
							className="size-4 text-muted-foreground"
							icon={GitBranchIcon}
						/>
						Extends
					</h4>
					<ul className="grid gap-1.5 sm:grid-cols-2">
						{extensions.map((extension) => (
							<li
								className="min-w-0 rounded-md bg-muted px-3 py-2"
								key={extension.target}
							>
								<p className="font-medium text-sm">{extension.label}</p>
								<p className="mt-0.5 break-words text-muted-foreground text-xs">
									{extension.features.join(" · ")}
								</p>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{implementation.length > 0 ? (
				<div
					className="flex flex-col gap-2"
					data-testid="surface-implementation"
				>
					<h4 className="font-medium text-sm">Where it lives</h4>
					<ul className="grid gap-1.5 sm:grid-cols-2">
						{implementation.map((location) => (
							<li
								className="min-w-0 rounded-md bg-muted px-3 py-2"
								key={location.layer}
							>
								<p className="font-medium text-sm">{location.label}</p>
								<p className="mt-0.5 break-words text-muted-foreground text-xs">
									{location.features.join(" · ")}
								</p>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</ListingSection>
	);
}
