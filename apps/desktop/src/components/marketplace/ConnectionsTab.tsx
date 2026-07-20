// apps/desktop/src/components/marketplace/ConnectionsTab.tsx
//
// Marketplace → Connections: the global Composio surface. Browse the full
// toolkit catalog, see which accounts are connected, connect new ones (OAuth via
// Composio-managed auth), and drill into a toolkit's actions/triggers. Per the
// connect-on-execute history, connecting here is the *proactive* path — the
// agent editor then attaches already-connected toolkits per agent.
//
// All data lives in Core (`/api/composio/*`); this component is a thin GUI over
// the catalog + connection hooks. The Composio key itself is set in Gateway →
// Keys; when it's missing we surface an actionable prompt instead of empty grids.

import {
	ArrowRight01Icon,
	Idea01Icon,
	Link01Icon,
	PlugSocketIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { type ChangeEvent, useMemo, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	useComposioActions,
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
	useComposioTriggers,
	useInitiateComposioConnection,
} from "@/src/hooks/useComposioCatalog.ts";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";

export default function ConnectionsTab() {
	const status = useComposioStatus();
	const keyConfigured = status.data?.configured ?? false;

	const toolkits = useComposioToolkits(keyConfigured);
	const connections = useComposioConnections("", keyConfigured);
	const [query, setQuery] = useState("");

	// Map toolkit slug → its connection, preferring an active one.
	const connectionByToolkit = useMemo(() => {
		const map = new Map<string, ComposioConnection>();
		for (const conn of connections.data ?? []) {
			const existing = map.get(conn.toolkit);
			if (!existing || (conn.active && !existing.active)) {
				map.set(conn.toolkit, conn);
			}
		}
		return map;
	}, [connections.data]);

	const filtered = useMemo(() => {
		const term = query.trim().toLowerCase();
		const all = toolkits.data ?? [];
		if (!term) {
			return all;
		}
		return all.filter(
			(t) =>
				t.name.toLowerCase().includes(term) ||
				t.slug.toLowerCase().includes(term) ||
				(t.description?.toLowerCase().includes(term) ?? false)
		);
	}, [toolkits.data, query]);

	if (status.isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	if (!keyConfigured) {
		return <KeyMissingState />;
	}

	return (
		<div className="mx-auto max-w-5xl px-6 py-6">
			<div className="mb-5">
				<h2 className="font-semibold text-lg">Connections</h2>
				<p className="text-muted-foreground text-sm">
					Connect your accounts once here, then attach them to any agent.
					Powered by Composio.
				</p>
			</div>

			<div className="relative mb-5">
				<HugeiconsIcon
					className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					icon={Search01Icon}
				/>
				<Input
					className="pl-9"
					onChange={(e: ChangeEvent<HTMLInputElement>) =>
						setQuery(e.target.value)
					}
					placeholder="Search integrations (Gmail, Slack, GitHub…)"
					value={query}
				/>
			</div>

			<ToolkitResults
				connectionByToolkit={connectionByToolkit}
				error={toolkits.error as Error | null}
				isLoading={toolkits.isLoading}
				query={query}
				toolkits={filtered}
			/>
		</div>
	);
}

/** The toolkit grid body: handles loading / error / empty / results without
 *  nested ternaries (early returns keep each state readable). */
function ToolkitResults({
	toolkits,
	connectionByToolkit,
	isLoading,
	error,
	query,
}: {
	toolkits: ComposioToolkit[];
	connectionByToolkit: Map<string, ComposioConnection>;
	isLoading: boolean;
	error: Error | null;
	query: string;
}) {
	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<p className="text-destructive text-sm">
				Couldn't load integrations: {error.message}
			</p>
		);
	}
	if (toolkits.length === 0) {
		return (
			<Empty className="py-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={PlugSocketIcon} />
					</EmptyMedia>
					<EmptyTitle>No integrations match “{query}”</EmptyTitle>
					<EmptyDescription>Try a different search term.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
			{toolkits.map((toolkit) => (
				<ToolkitCard
					connection={connectionByToolkit.get(toolkit.slug) ?? null}
					key={toolkit.slug}
					toolkit={toolkit}
				/>
			))}
		</div>
	);
}

function KeyMissingState() {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={Idea01Icon} />
				</EmptyMedia>
				<EmptyTitle>Add your Composio key to connect accounts</EmptyTitle>
				<EmptyDescription>
					Connections are powered by Composio. Add your Composio API key in
					Gateway → Keys, then your available integrations appear here.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

/** Connected / pending / nothing — extracted so the card avoids a nested ternary. */
function ConnectionStatusBadge({
	connected,
	pending,
}: {
	connected: boolean;
	pending: boolean;
}) {
	if (connected) {
		return (
			<Badge className="gap-1" variant="secondary">
				<span className="size-1.5 rounded-full bg-success" />
				Connected
			</Badge>
		);
	}
	if (pending) {
		return <Badge variant="outline">Pending…</Badge>;
	}
	return null;
}

function ToolkitCard({
	toolkit,
	connection,
}: {
	toolkit: ComposioToolkit;
	connection: ComposioConnection | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const initiate = useInitiateComposioConnection();
	const isConnected = connection?.active ?? false;
	const isPending = Boolean(connection) && !isConnected;

	const handleConnect = async () => {
		try {
			const result = await initiate.mutateAsync(toolkit.slug);
			if (!result.redirectUrl) {
				sileo.error({ title: "Composio did not return a connect link." });
				return;
			}
			await openExternal(result.redirectUrl);
			sileo.success({
				title: `Connecting ${toolkit.name}…`,
				description:
					"Authorize in your browser. The connection turns active here when you return.",
			});
		} catch (e) {
			const message =
				e instanceof Error ? e.message : "Could not start connect.";
			sileo.error({ title: message });
		}
	};

	return (
		<div className="rounded-lg bg-card p-4">
			<div className="flex items-start gap-3">
				<ToolkitLogo toolkit={toolkit} />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium text-sm">{toolkit.name}</span>
						<ConnectionStatusBadge
							connected={isConnected}
							pending={isPending}
						/>
					</div>
					{toolkit.description ? (
						<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
							{toolkit.description}
						</p>
					) : null}
				</div>
			</div>

			<div className="mt-3 flex items-center justify-between">
				<Button
					onClick={() => setExpanded((v) => !v)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						className={`mr-1 size-3.5 transition-transform ${
							expanded ? "rotate-90" : ""
						}`}
						icon={ArrowRight01Icon}
					/>
					{expanded ? "Hide tools" : "View tools"}
				</Button>

				<Button
					disabled={initiate.isPending}
					onClick={handleConnect}
					size="sm"
					variant={isConnected ? "outline" : "default"}
				>
					{initiate.isPending ? (
						<Spinner className="mr-2 size-3.5" />
					) : (
						<HugeiconsIcon className="mr-1.5 size-3.5" icon={Link01Icon} />
					)}
					{isConnected ? "Reconnect" : "Connect"}
				</Button>
			</div>

			{expanded ? <ToolkitTools toolkit={toolkit.slug} /> : null}
		</div>
	);
}

function ToolkitLogo({ toolkit }: { toolkit: ComposioToolkit }) {
	if (toolkit.logo) {
		return (
			// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; logo is a remote Composio URL
			// biome-ignore lint/correctness/useImageSize: sized via the `size-9` class, dimensions are fixed
			<img
				alt={`${toolkit.name} logo`}
				className="size-9 shrink-0 rounded-md bg-background object-contain p-1"
				draggable={false}
				src={toolkit.logo}
			/>
		);
	}
	return (
		<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
			<HugeiconsIcon
				className="size-4 text-muted-foreground"
				icon={PlugSocketIcon}
			/>
		</div>
	);
}

function ToolkitTools({ toolkit }: { toolkit: string }) {
	const actions = useComposioActions(toolkit);
	const triggers = useComposioTriggers(toolkit);

	return (
		<div className="mt-3 space-y-3 border-t pt-3">
			<ToolSection
				emptyLabel="No tools listed for this integration."
				error={actions.error as Error | null}
				items={(actions.data ?? []).map((a) => ({
					id: a.name,
					label: a.displayName,
					description: a.description,
				}))}
				loading={actions.isLoading}
				title="Tools"
			/>
			{triggers.data && triggers.data.length > 0 ? (
				<ToolSection
					emptyLabel="No triggers for this integration."
					error={triggers.error as Error | null}
					items={triggers.data.map((t) => ({
						id: t.name,
						label: t.displayName,
						description: t.description,
					}))}
					loading={triggers.isLoading}
					title="Triggers"
				/>
			) : null}
		</div>
	);
}

interface ToolSectionItem {
	description: string | null;
	id: string;
	label: string;
}

/** Renders one labelled list (Tools or Triggers); body via early returns. */
function ToolSectionBody({
	items,
	loading,
	error,
	emptyLabel,
}: {
	items: ToolSectionItem[];
	loading: boolean;
	error: Error | null;
	emptyLabel: string;
}) {
	if (loading) {
		return <Spinner className="size-4" />;
	}
	if (error) {
		return <p className="text-destructive text-xs">{error.message}</p>;
	}
	if (items.length === 0) {
		return <p className="text-muted-foreground text-xs">{emptyLabel}</p>;
	}
	return (
		<ul className="max-h-48 space-y-1 overflow-auto">
			{items.map((item) => (
				<li
					className="rounded-md px-2 py-1 text-xs hover:bg-muted/50"
					key={item.id}
				>
					<span className="font-medium">{item.label}</span>
					{item.description ? (
						<span className="block truncate text-muted-foreground">
							{item.description}
						</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

function ToolSection({
	title,
	items,
	loading,
	error,
	emptyLabel,
}: {
	title: string;
	items: ToolSectionItem[];
	loading: boolean;
	error: Error | null;
	emptyLabel: string;
}) {
	return (
		<div>
			<p className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{title}
			</p>
			<ToolSectionBody
				emptyLabel={emptyLabel}
				error={error}
				items={items}
				loading={loading}
			/>
		</div>
	);
}
