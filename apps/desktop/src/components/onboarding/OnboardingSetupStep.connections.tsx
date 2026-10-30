import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SvglIcon, type SvglSpec } from "@ryu/blocks/web/svgl-icon.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useMemo, useState } from "react";
import { ConnectionPermissionDialog } from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import type { OnboardingConnectedApp } from "@/src/components/onboarding/AgentSuggestionsStep.tsx";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";
import { ContinueRow } from "./OnboardingSetupStep.parts.tsx";

export const INTEGRATION_SVGL: readonly [string, SvglSpec][] = [
	// SVGL's bundled Google mark is the closest local mark for Gmail and the
	// Google Workspace family when Composio does not return a toolkit logo.
	["gmail", "google"],
	["googlemail", "google"],
	["google-drive", "google"],
	["googledrive", "google"],
	["google-docs", "google"],
	["googledocs", "google"],
	["google-sheets", "google"],
	["googlesheets", "google"],
	["google-calendar", "google"],
	["googlecalendar", "google"],
	["notion", "notion"],
	["slack", "slack"],
	["github", { light: "github_light", dark: "github_dark" }],
	["linear", "linear"],
	["discord", "discord"],
	["figma", "figma"],
	["stripe", "stripe"],
	["dropbox", "dropbox"],
	["zoom", "zoom"],
	["asana", "asana-logo"],
	["cloudflare", "cloudflare"],
	["vercel", "vercel"],
];

export function svglForIntegration(haystack: string): SvglSpec | null {
	const normalized = haystack.toLowerCase();
	for (const [needle, spec] of INTEGRATION_SVGL) {
		if (normalized.includes(needle)) {
			return spec;
		}
	}
	return null;
}

export function ConnectedAppLogo({
	name,
	slug,
	toolkit,
}: {
	name: string;
	slug: string;
	toolkit?: ComposioToolkit;
}) {
	const spec = svglForIntegration(`${slug} ${name}`);
	if (spec) {
		return <SvglIcon size={16} spec={spec} />;
	}
	if (toolkit?.logo) {
		return (
			// Composio supplies toolkit logos
			<img
				alt=""
				className="size-4 object-contain"
				src={safeMediaUrl(toolkit.logo) ?? undefined}
			/>
		);
	}
	return (
		<span className="flex size-4 items-center justify-center rounded-full bg-muted font-medium text-xs">
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

export function connectedAppDetails(
	connections: readonly ComposioConnection[],
	toolkits: readonly ComposioToolkit[]
): OnboardingConnectedApp[] {
	const apps = new Map<string, OnboardingConnectedApp>();
	for (const connection of connections) {
		if (!connection.active) {
			continue;
		}
		const slug = connection.toolkit.trim().toLowerCase();
		if (!slug || apps.has(slug)) {
			continue;
		}
		const toolkit = toolkits.find((item) => item.slug === connection.toolkit);
		const fallback = connection.toolkit
			.split(/[-_]+/)
			.filter(Boolean)
			.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
			.join(" ");
		const name = toolkit?.name.trim() || fallback;
		if (name) {
			apps.set(slug, {
				logo: <ConnectedAppLogo name={name} slug={slug} toolkit={toolkit} />,
				name,
				slug,
			});
		}
	}
	return [...apps.values()];
}

export function ToolkitLogo({ toolkit }: { toolkit: ComposioToolkit }) {
	const hasBrand = Boolean(svglForProvider(`${toolkit.slug} ${toolkit.name}`));
	if (hasBrand) {
		return (
			<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
				<ProviderBrandLogo
					providerKey={`${toolkit.slug} ${toolkit.name}`}
					size={20}
				/>
			</div>
		);
	}
	if (toolkit.logo) {
		return (
			<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted p-2">
				{/* Composio supplies toolkit logos */}
				<img
					alt=""
					className="size-5 object-contain"
					src={safeMediaUrl(toolkit.logo) ?? undefined}
				/>
			</div>
		);
	}
	return (
		<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted font-medium text-sm">
			{toolkit.name.slice(0, 1).toUpperCase()}
		</div>
	);
}

export function ConnectionSetup({
	connectionsCheckFailed,
	connections,
	toolkits,
	query,
	connectingToolkit,
	onConnect,
	onContinue,
	onQuery,
}: {
	connectionsCheckFailed: boolean;
	connections: ComposioConnection[];
	connectingToolkit: string | null;
	onConnect: (
		toolkit: ComposioToolkit,
		accessLevel: ConnectionAccessLevel
	) => Promise<void>;
	onContinue: () => void;
	onQuery: (query: string) => void;
	query: string;
	toolkits: ComposioToolkit[];
}) {
	const tl = useLiteralMessages();
	const [pendingToolkit, setPendingToolkit] = useState<ComposioToolkit | null>(
		null
	);
	const curated = useMemo(() => {
		const preferred = ["gmail", "notion", "slack", "github"];
		return preferred
			.map((slug) =>
				toolkits.find((toolkit) => {
					const toolkitSlug = toolkit.slug.toLowerCase();
					return (
						toolkitSlug === slug ||
						toolkitSlug.startsWith(`${slug}_`) ||
						toolkitSlug.startsWith(`${slug}-`)
					);
				})
			)
			.filter((toolkit): toolkit is ComposioToolkit => Boolean(toolkit));
	}, [toolkits]);
	const [showMore, setShowMore] = useState(false);
	const visible = showMore
		? toolkits
		: curated.length > 0
			? curated
			: toolkits.slice(0, 4);
	const connectionMap = new Map<string, ComposioConnection>();
	for (const connection of connections) {
		if (!connectionMap.has(connection.toolkit) || connection.active) {
			connectionMap.set(connection.toolkit, connection);
		}
	}
	return (
		<div className="flex flex-col gap-4">
			{connectionsCheckFailed ? (
				<div className="flex flex-col gap-4">
					<p className="text-muted-foreground text-sm">
						Ryu could not verify your existing connections, so onboarding will
						not start another one.
					</p>
					<ContinueRow onContinue={onContinue} />
				</div>
			) : null}
			{connectionsCheckFailed ? null : (
				<>
					{connections.some((connection) => connection.active) ? (
						<div data-testid="onboarding-connections-check">
							<p className="font-medium text-sm">Connections already set up</p>
							<p className="mt-1 text-detail text-muted-foreground">
								{tl(
									"Ryu found {count, plural, one {# connected source} other {# connected sources}}. Existing connections will be left unchanged.",
									{
										count: connections.filter((connection) => connection.active)
											.length,
									}
								)}
							</p>
						</div>
					) : null}
					<div className="relative">
						<HugeiconsIcon
							className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							aria-label="Search integrations"
							leadingAdornment="default"
							onChange={(event) => onQuery(event.target.value)}
							placeholder="Search Gmail, Notion, Slack, GitHub, or more"
							value={query}
						/>
					</div>
					{toolkits.length === 0 ? (
						<div>
							<p className="font-medium text-sm">Connections are optional</p>
							<p className="mt-1 text-muted-foreground text-sm">
								Composio is not configured on this node yet. You can continue
								now and add connections later in Settings → Connections.
							</p>
						</div>
					) : (
						<div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
							{visible
								.filter((toolkit) => {
									const term = query.trim().toLowerCase();
									return (
										!term ||
										toolkit.name.toLowerCase().includes(term) ||
										toolkit.slug.toLowerCase().includes(term)
									);
								})
								.map((toolkit) => {
									const connection = connectionMap.get(toolkit.slug);
									return (
										<div className="flex items-center gap-3" key={toolkit.slug}>
											<ToolkitLogo toolkit={toolkit} />
											<div className="min-w-0 flex-1">
												<p
													className="truncate font-medium text-sm"
													title={toolkit.name}
												>
													{toolkit.name}
												</p>
												{connection?.active ? (
													<p className="text-detail text-muted-foreground">
														Connected
													</p>
												) : null}
											</div>
											<Button
												disabled={connection?.active}
												loading={connectingToolkit === toolkit.slug}
												onClick={() => setPendingToolkit(toolkit)}
												size="sm"
												variant="outline"
											>
												{connection?.active ? "Connected" : "Connect"}
											</Button>
										</div>
									);
								})}
						</div>
					)}
					{!showMore && toolkits.length > curated.length ? (
						<Button
							className="self-start"
							onClick={() => setShowMore(true)}
							variant="ghost"
						>
							More integrations
						</Button>
					) : null}
					<ContinueRow onContinue={onContinue} />
				</>
			)}
			<ConnectionPermissionDialog
				connectionName={pendingToolkit?.name ?? "this integration"}
				connectionType="Composio"
				currentLevel={
					pendingToolkit
						? connectionMap.get(pendingToolkit.slug)?.accessLevel
						: undefined
				}
				onConfirm={async (accessLevel) => {
					if (!pendingToolkit) {
						return;
					}
					await onConnect(pendingToolkit, accessLevel);
					setPendingToolkit(null);
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPendingToolkit(null);
					}
				}}
				open={pendingToolkit !== null}
			/>
		</div>
	);
}
