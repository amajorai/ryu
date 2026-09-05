// packages/marketplace/src/catalog/detail/api-reference-panel.tsx
//
// The API-reference tab: everything installing a plugin adds to the machine,
// read straight off its manifest.
//
// The organising question is "what can this thing do, and what makes it do it?" —
// so the sections run: the callable surface (commands, tools, agents, workflows),
// the servers it registers, the HTTP routes it exposes, what wakes it up, and
// what it serves to other plugins. Each section renders only when the manifest
// declares something for it, so a small plugin gets a short, honest page rather
// than a wall of empty headings.
//
// Everything here arrives pre-stripped by Core's manifest projection: no tool
// backend, no sidecar process spec, no hook code. This component renders text.

import {
	Comment01Icon,
	FlashIcon,
	ServerStack01Icon,
	Settings01Icon,
	ShareKnowledgeIcon,
	SourceCodeIcon,
	Target01Icon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import type { ReactNode } from "react";
import type {
	CatalogApiSurface,
	CatalogContribution,
	CatalogMcpServer,
	CatalogSidecar,
} from "../types.ts";

/** True when the manifest declared anything worth an API-reference tab. Used to
 *  decide whether the tab exists at all — an empty tab is worse than no tab. */
export function hasApiSurface(surface?: CatalogApiSurface | null): boolean {
	if (!surface) {
		return false;
	}
	return Boolean(
		surface.commands?.length ||
			surface.tools?.length ||
			surface.agents?.length ||
			surface.workflows?.length ||
			surface.policies?.length ||
			surface.mcpServers?.length ||
			surface.sidecars?.length ||
			surface.views?.length ||
			surface.settingsTabs?.length ||
			surface.composerControls?.length ||
			surface.provides?.length ||
			surface.triggers?.activationEvents?.length ||
			surface.triggers?.turnHooks?.length
	);
}

function Section({
	children,
	count,
	description,
	icon,
	title,
}: {
	children: ReactNode;
	count?: number;
	description?: string;
	icon: IconSvgElement;
	title: string;
}) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-baseline gap-2">
				<h3 className="flex items-center gap-1.5 font-medium text-sm">
					<HugeiconsIcon className="size-4 text-muted-foreground" icon={icon} />
					{title}
				</h3>
				{typeof count === "number" ? (
					<span className="text-muted-foreground text-xs">
						{formatNumber(count)}
					</span>
				) : null}
			</div>
			{description ? (
				<p className="text-muted-foreground text-xs">{description}</p>
			) : null}
			{children}
		</section>
	);
}

/** A named contribution list (commands / tools / agents / workflows / policies).
 *  The id is always shown alongside the name: it is what a caller actually types,
 *  and for a dangling reference it is the only thing there is. */
function ContributionList({ items }: { items: CatalogContribution[] }) {
	return (
		<ul className="flex flex-col gap-1.5">
			{items.map((item) => (
				<li className="rounded-md bg-muted px-3 py-2" key={item.id}>
					<div className="flex items-baseline justify-between gap-3">
						<span className="min-w-0 truncate font-medium text-sm">
							{item.name ?? item.id}
						</span>
						<code className="shrink-0 truncate font-mono text-muted-foreground text-xs">
							{item.id}
						</code>
					</div>
					{item.description ? (
						<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
							{item.description}
						</p>
					) : null}
					{item.name ? null : (
						<p className="mt-0.5 text-amber-600 text-xs dark:text-amber-500">
							Declared but not shipped by this plugin.
						</p>
					)}
				</li>
			))}
		</ul>
	);
}

function McpServerList({ servers }: { servers: CatalogMcpServer[] }) {
	return (
		<ul className="flex flex-col gap-1.5">
			{servers.map((server) => (
				<li className="rounded-md bg-muted px-3 py-2" key={server.name}>
					<div className="flex items-baseline justify-between gap-3">
						<span className="min-w-0 truncate font-medium text-sm">
							{server.name}
						</span>
						{server.enabled === false ? (
							<Badge className="shrink-0 text-xs" variant="outline">
								Disabled
							</Badge>
						) : null}
					</div>
					{server.description ? (
						<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
							{server.description}
						</p>
					) : null}
					{server.command ? (
						<code className="mt-1 block truncate font-mono text-muted-foreground text-xs">
							{[server.command, ...(server.args ?? [])].join(" ")}
						</code>
					) : null}
					{server.envKeys?.length ? (
						<p className="mt-1 text-muted-foreground text-xs">
							Reads {server.envKeys.join(", ")} from the environment.
						</p>
					) : null}
				</li>
			))}
		</ul>
	);
}

function SidecarList({ sidecars }: { sidecars: CatalogSidecar[] }) {
	return (
		<ul className="flex flex-col gap-2">
			{sidecars.map((sidecar) => (
				<li className="rounded-md bg-muted px-3 py-2" key={sidecar.name}>
					<div className="flex flex-wrap items-baseline gap-2">
						<span className="font-medium text-sm">{sidecar.name}</span>
						{sidecar.lazy ? (
							<Badge className="text-xs" variant="secondary">
								Starts on first use
							</Badge>
						) : null}
						{sidecar.publicMount ? (
							<code className="font-mono text-muted-foreground text-xs">
								{sidecar.publicMount}
							</code>
						) : null}
					</div>
					{sidecar.routes?.length ? (
						<ul className="mt-1.5 flex flex-col gap-1">
							{sidecar.routes.map((route) => (
								<li
									className="flex items-baseline gap-2 text-xs"
									key={`${sidecar.name}:${route.path}`}
								>
									<span className="shrink-0 font-medium font-mono text-muted-foreground">
										{(route.methods ?? ["ANY"]).join("/")}
									</span>
									<code className="min-w-0 flex-1 truncate font-mono">
										{route.path}
									</code>
									{route.auth ? (
										<span
											className={
												route.auth === "none" || route.auth === "public"
													? "shrink-0 text-amber-600 dark:text-amber-500"
													: "shrink-0 text-muted-foreground"
											}
										>
											{route.auth === "none" || route.auth === "public"
												? "no auth"
												: route.auth}
										</span>
									) : null}
								</li>
							))}
						</ul>
					) : (
						<p className="mt-1 text-muted-foreground text-xs">
							No externally reachable routes.
						</p>
					)}
				</li>
			))}
		</ul>
	);
}

/** The API-reference tab. Render only when {@link hasApiSurface} is true. */
export function ApiReferencePanel({ surface }: { surface: CatalogApiSurface }) {
	const activationEvents = surface.triggers?.activationEvents ?? [];
	const turnHooks = surface.triggers?.turnHooks ?? [];

	return (
		<div className="flex flex-col gap-6">
			{surface.commands?.length ? (
				<Section
					count={surface.commands.length}
					description="Runnable from the command palette."
					icon={FlashIcon}
					title="Commands"
				>
					<ContributionList items={surface.commands} />
				</Section>
			) : null}

			{surface.tools?.length ? (
				<Section
					count={surface.tools.length}
					description="Callable by an agent during a turn."
					icon={Wrench01Icon}
					title="Tools"
				>
					<ContributionList items={surface.tools} />
				</Section>
			) : null}

			{surface.agents?.length ? (
				<Section
					count={surface.agents.length}
					icon={Target01Icon}
					title="Agents"
				>
					<ContributionList items={surface.agents} />
				</Section>
			) : null}

			{surface.workflows?.length ? (
				<Section
					count={surface.workflows.length}
					icon={WorkflowCircle06Icon}
					title="Workflows"
				>
					<ContributionList items={surface.workflows} />
				</Section>
			) : null}

			{surface.policies?.length ? (
				<Section
					count={surface.policies.length}
					description="Gateway policies applied to requests."
					icon={SourceCodeIcon}
					title="Policies"
				>
					<ContributionList items={surface.policies} />
				</Section>
			) : null}

			{surface.mcpServers?.length ? (
				<Section
					count={surface.mcpServers.length}
					description="Registered into your MCP registry when this plugin is enabled."
					icon={ServerStack01Icon}
					title="MCP servers"
				>
					<McpServerList servers={surface.mcpServers} />
				</Section>
			) : null}

			{surface.sidecars?.length ? (
				<Section
					count={surface.sidecars.length}
					description="Background processes this plugin runs, and the HTTP routes they expose."
					icon={ServerStack01Icon}
					title="Background services"
				>
					<SidecarList sidecars={surface.sidecars} />
				</Section>
			) : null}

			{activationEvents.length || turnHooks.length ? (
				<Section
					description="What causes this plugin to run."
					icon={FlashIcon}
					title="Triggers"
				>
					<div className="flex flex-col gap-2">
						{activationEvents.length ? (
							<div className="flex flex-wrap gap-1">
								{activationEvents.map((event) => (
									<Badge
										className="font-mono text-xs"
										key={event}
										variant="outline"
									>
										{event}
									</Badge>
								))}
							</div>
						) : (
							<p className="text-muted-foreground text-xs">
								Declares no activation events, so it is activated eagerly when
								enabled.
							</p>
						)}
						{turnHooks.length ? (
							<ul className="flex flex-col gap-1.5">
								{turnHooks.map((hook) => (
									<li
										className="rounded-md bg-muted px-3 py-2"
										key={hook.id ?? hook.event}
									>
										<div className="flex items-baseline justify-between gap-3">
											<span className="min-w-0 truncate text-sm">
												Runs at every {hook.event.replace(/_/g, " ")}
											</span>
											<Badge className="shrink-0 text-xs" variant="secondary">
												Chat hook
											</Badge>
										</div>
										{hook.description ? (
											<p className="mt-0.5 text-muted-foreground text-xs">
												{hook.description}
											</p>
										) : null}
									</li>
								))}
							</ul>
						) : null}
					</div>
				</Section>
			) : null}

			{surface.views?.length || surface.settingsTabs?.length ? (
				<Section
					description="Screens and settings this plugin adds to the app."
					icon={Settings01Icon}
					title="Interface"
				>
					<ul className="flex flex-col gap-1.5">
						{(surface.views ?? []).map((view) => (
							<li
								className="flex items-baseline justify-between gap-3 rounded-md bg-muted px-3 py-2"
								key={`view:${view.id}`}
							>
								<span className="min-w-0 truncate text-sm">
									{view.title ?? view.id}
								</span>
								<Badge className="shrink-0 text-xs" variant="secondary">
									{view.surface ? `${view.surface} view` : "View"}
								</Badge>
							</li>
						))}
						{(surface.settingsTabs ?? []).map((tab) => (
							<li
								className="flex items-baseline justify-between gap-3 rounded-md bg-muted px-3 py-2"
								key={`tab:${tab.id}`}
							>
								<span className="min-w-0 truncate text-sm">
									{tab.title ?? tab.id}
								</span>
								<Badge className="shrink-0 text-xs" variant="secondary">
									Settings tab
								</Badge>
							</li>
						))}
						{(surface.composerControls ?? []).map((control) => (
							<li
								className="flex items-baseline justify-between gap-3 rounded-md bg-muted px-3 py-2"
								key={`control:${control.id}`}
							>
								<span className="min-w-0 truncate text-sm">
									{control.label ?? control.id}
								</span>
								<Badge className="shrink-0 text-xs" variant="secondary">
									Composer {control.type ?? "control"}
								</Badge>
							</li>
						))}
					</ul>
				</Section>
			) : null}

			{surface.provides?.length ? (
				<Section
					count={surface.provides.length}
					description="Capabilities this plugin serves to other plugins."
					icon={ShareKnowledgeIcon}
					title="Provides"
				>
					<ul className="flex flex-col gap-1.5">
						{surface.provides.map((entry) => (
							<li
								className="flex items-baseline justify-between gap-3 rounded-md bg-muted px-3 py-2"
								key={entry.capability}
							>
								<code className="min-w-0 truncate font-mono text-sm">
									{entry.capability}
								</code>
								{entry.route ? (
									<code className="shrink-0 truncate font-mono text-muted-foreground text-xs">
										{entry.route}
									</code>
								) : null}
							</li>
						))}
					</ul>
				</Section>
			) : null}

			{surface.runnables?.length ? (
				<Section
					count={surface.runnables.length}
					description="Everything this plugin bundles, by kind."
					icon={Comment01Icon}
					title="All bundled items"
				>
					<ul className="flex flex-col gap-1.5">
						{surface.runnables.map((runnable) => (
							<li
								className="flex items-baseline justify-between gap-3 rounded-md bg-muted px-3 py-2"
								key={runnable.id}
							>
								<span className="min-w-0 truncate text-sm">
									{runnable.name ?? runnable.id}
								</span>
								{runnable.kind ? (
									<Badge className="shrink-0 text-xs" variant="secondary">
										{runnable.kind}
									</Badge>
								) : null}
							</li>
						))}
					</ul>
				</Section>
			) : null}
		</div>
	);
}
