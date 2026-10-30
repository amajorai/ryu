import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { grantDescription, grantLabel } from "../grant-labels.ts";
import type { CatalogEntry, PluginCatalogDetail } from "../types.ts";
import { catalogLayerLabel } from "../types.ts";
import { RequiredPluginsSection } from "./dependency-graph.tsx";

/** True when there is anything to put on a Dependencies tab. */
export function hasDependencies(
	detail: PluginCatalogDetail | null,
	entry: CatalogEntry
): boolean {
	const requires = detail?.requires ?? entry.requires ?? null;
	const layers = detail?.layers?.length ? detail.layers : (entry.layers ?? []);
	return Boolean(
		requires?.apps?.length ||
			requires?.grants?.length ||
			detail?.permissionGrants?.length ||
			detail?.engines?.ryu ||
			detail?.apiSurface?.provides?.length ||
			layers.length
	);
}

/**
 * The Dependencies tab: what must be present for this plugin to work.
 *
 * Three different kinds of dependency live here on purpose — other plugins, the
 * permissions it needs granted, and the Core version it needs — because from the
 * reader's side they are the same question: what else does installing this drag
 * in?
 */
export function DependenciesPanel({
	detail,
	entry,
	showTechnical = true,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
	/** Show the machine-readable half: the raw grant id beside its label, the
	 *  engine semver range, the capability strings this plugin publishes.
	 *
	 *  The plain-English grant LABEL and DESCRIPTION are never gated by this.
	 *  `grant-labels.ts` exists so a non-technical user understands what they are
	 *  approving, and hiding that from the least-technical audience would be a
	 *  security regression dressed as simplification — only the identifier goes. */
	showTechnical?: boolean;
}) {
	const tl = useLiteralMessages();
	const requires = detail?.requires ?? entry.requires ?? null;
	const apps = requires?.apps ?? [];
	const grants = detail?.permissionGrants?.length
		? detail.permissionGrants
		: (requires?.grants ?? []);
	const engineReq = detail?.engines?.ryu ?? null;
	const layers = detail?.layers?.length ? detail.layers : (entry.layers ?? []);

	return (
		<div className="flex flex-col gap-6">
			{/* Resolves the declared ids into the tree Core walks, with each entry's
			    live install/enable state when the host can supply it — see
			    dependency-graph.tsx. Renders nothing when nothing is declared. */}
			<RequiredPluginsSection
				apps={apps}
				showTechnical={showTechnical}
				subjectId={entry.id}
				subjectName={entry.name}
			/>

			{grants.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 className="flex items-center gap-1.5 font-medium text-sm">
						<HugeiconsIcon
							className="size-4 text-muted-foreground"
							icon={SquareLock01Icon}
						/>
						Requires these permissions
					</h3>
					<ul className="flex flex-col gap-1.5">
						{grants.map((grant) => (
							<li className="rounded-lg bg-muted px-3 py-2" key={grant}>
								<div className="flex items-baseline justify-between gap-3">
									<span className="min-w-0 truncate text-sm">
										{grantLabel(grant)}
									</span>
									{showTechnical ? (
										<code className="shrink-0 truncate font-mono text-muted-foreground text-xs">
											{grant}
										</code>
									) : null}
								</div>
								<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
									{grantDescription(grant)}
								</p>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{engineReq && showTechnical ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Requires Ryu</h3>
					<p className="text-muted-foreground text-sm">
						This plugin declares it needs Ryu{" "}
						<code className="font-mono">{engineReq}</code>. An incompatible node
						refuses to load it rather than failing at runtime.
					</p>
				</section>
			) : null}

			{layers.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Swappable layer</h3>
					<ul className="flex flex-col gap-1.5">
						{layers.map((layer) => (
							<li
								className="rounded-lg bg-muted px-3 py-2"
								key={layer.capability}
							>
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="outline">{catalogLayerLabel(layer)}</Badge>
									{layer.target ? (
										<span className="text-muted-foreground text-xs">
											{layer.target === "remote-desktop"
												? "Hosted provider"
												: "Local provider"}
										</span>
									) : null}
								</div>
								{showTechnical && layer.verbs?.length ? (
									<p className="mt-1 text-muted-foreground text-xs">
										{tl("Verbs: {verbs}", { verbs: layer.verbs.join(", ") })}
									</p>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{detail?.apiSurface?.provides?.length && showTechnical ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Provides to other plugins</h3>
					<ul className="flex flex-col gap-1.5">
						{detail.apiSurface.provides.map((entryProvides) => (
							<li
								className="rounded-lg bg-muted px-3 py-2 text-sm"
								key={entryProvides.capability}
							>
								<code className="font-mono">{entryProvides.capability}</code>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}
