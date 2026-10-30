import {
	ArrowRight01Icon,
	Idea01Icon,
	Link01Icon,
	PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	accessLevelSummary,
	ConnectionPermissionDialog,
} from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import { useInitiateComposioConnection } from "@/src/hooks/useComposioCatalog.ts";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { ToolkitTools } from "./ToolkitTools.tsx";

/** The toolkit grid body: handles loading / error / empty / results without
 *  nested ternaries (early returns keep each state readable). */
export function ToolkitResults({
	toolkits,
	connectionByToolkit,
	isLoading,
	error,
	onClearQuery,
	onRetry,
	query,
}: {
	toolkits: ComposioToolkit[];
	connectionByToolkit: Map<string, ComposioConnection>;
	isLoading: boolean;
	error: Error | null;
	onClearQuery: () => void;
	/** Re-run the toolkit read after a failure. */
	onRetry: () => void;
	query: string;
}) {
	const tl = useLiteralMessages();
	if (isLoading) {
		return <SkeletonRows spacing="status" />;
	}
	if (error) {
		return (
			<Empty className="py-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={PlugSocketIcon} />
					</EmptyMedia>
					<EmptyTitle>Couldn't load integrations</EmptyTitle>
					<EmptyDescription>
						Check your connection, then try again.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="outline">
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (toolkits.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={PlugSocketIcon} />
					</EmptyMedia>
					<EmptyTitle>
						{tl("No integrations match “{query}”", { query })}
					</EmptyTitle>
					<EmptyDescription>Try a different search term.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearQuery} size="sm" variant="ghost">
						Clear search
					</Button>
				</EmptyContent>
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

export function KeyMissingState({ onOpenKeys }: { onOpenKeys: () => void }) {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={Idea01Icon} />
				</EmptyMedia>
				<EmptyTitle>Add your Composio key to connect accounts</EmptyTitle>
				<EmptyDescription>
					Connections are powered by Composio. Add your Composio API key in
					Gateway → API keys, then your available integrations appear here.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onOpenKeys} size="sm">
					Open Gateway keys
				</Button>
			</EmptyContent>
		</Empty>
	);
}

/** Connected / pending / nothing — extracted so the card avoids a nested ternary. */
export function ConnectionStatusBadge({
	connected,
	pending,
}: {
	connected: boolean;
	pending: boolean;
}) {
	if (connected) {
		return (
			<Badge variant="secondary">
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

export function ToolkitCard({
	toolkit,
	connection,
}: {
	toolkit: ComposioToolkit;
	connection: ComposioConnection | null;
}) {
	const tl = useLiteralMessages();
	const [expanded, setExpanded] = useState(false);
	const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
	const initiate = useInitiateComposioConnection();
	const isConnected = connection?.active ?? false;
	const isPending = Boolean(connection) && !isConnected;

	const handleConnect = async (accessLevel: ConnectionAccessLevel) => {
		const result = await initiate.mutateAsync({
			accessLevel,
			toolkit: toolkit.slug,
		});
		if (!result.redirectUrl) {
			throw new Error("Composio did not return a connect link.");
		}
		await openExternal(result.redirectUrl);
		sileo.success({
			title: `Connecting ${toolkit.name}…`,
			description:
				"Authorize in your browser. The connection turns active here when you return.",
		});
	};

	return (
		<div className="rounded-lg bg-card p-4">
			<div className="flex items-start gap-3">
				<ToolkitLogo toolkit={toolkit} />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium text-sm" title={toolkit.name}>
							{toolkit.name}
						</span>
						<ConnectionStatusBadge
							connected={isConnected}
							pending={isPending}
						/>
					</div>
					<Badge className="mt-1 w-fit" variant="outline">
						{tl("Access: {level}", {
							level: accessLevelSummary(connection?.accessLevel),
						})}
					</Badge>
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
					disabled={permissionDialogOpen}
					loading={initiate.isPending}
					onClick={() => setPermissionDialogOpen(true)}
					size="sm"
					variant={isConnected ? "outline" : "default"}
				>
					{!initiate.isPending && (
						<HugeiconsIcon className="mr-1.5 size-3.5" icon={Link01Icon} />
					)}
					{isConnected ? "Reconnect" : "Connect"}
				</Button>
			</div>

			{expanded ? <ToolkitTools toolkit={toolkit.slug} /> : null}
			<ConnectionPermissionDialog
				connectionName={toolkit.name}
				connectionType="Composio"
				currentLevel={connection?.accessLevel}
				onConfirm={handleConnect}
				onOpenChange={setPermissionDialogOpen}
				open={permissionDialogOpen}
			/>
		</div>
	);
}

export function ToolkitLogo({ toolkit }: { toolkit: ComposioToolkit }) {
	const tl = useLiteralMessages();
	if (toolkit.logo) {
		return (
			// Tauri/Vite app, no next/image; logo is a remote Composio URL
			// sized via the `size-9` class, dimensions are fixed
			<img
				alt={tl("{name} logo", { name: toolkit.name })}
				className="size-9 shrink-0 rounded-lg bg-background object-contain p-1"
				draggable={false}
				src={safeMediaUrl(toolkit.logo) ?? undefined}
			/>
		);
	}
	return (
		<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
			<HugeiconsIcon
				className="size-4 text-muted-foreground"
				icon={PlugSocketIcon}
			/>
		</div>
	);
}
