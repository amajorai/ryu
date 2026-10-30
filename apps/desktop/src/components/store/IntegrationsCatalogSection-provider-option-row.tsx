import {
	Download01Icon,
	LinkSquare01Icon,
	Message01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import ImportToolsAction from "@ryu/marketplace/catalog/import-tools-action";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { StoreSearchRealm } from "@/src/hooks/useStoreSearch.ts";
import type { IntegrationOption } from "@/src/lib/api/integrations.ts";
import { providerOptionPrice } from "@/src/lib/integration-price.ts";
import {
	installChatPrompt,
	providerOptionKind,
	SOURCE_LABELS,
} from "./IntegrationsCatalogSection-options.ts";

export function ProviderOptionRow({
	brandName,
	onOpenConnections,
	onOpenInstallChat,
	onOpenRealm,
	option,
}: {
	brandName: string;
	onOpenConnections: () => void;
	onOpenInstallChat: (prompt: string) => void;
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
	option: IntegrationOption;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	const href = safeHttpUrl(option.url);
	const connectionId =
		option.connectionId ?? option.id.replace(/^directory:/, "");
	const chatSetup = (
		<Button
			onClick={() => onOpenInstallChat(installChatPrompt(brandName, option))}
			size="sm"
		>
			<HugeiconsIcon className="size-4" icon={Message01Icon} />
			Open setup chat
		</Button>
	);

	let action: React.ReactNode;
	if (option.available === false) {
		action = (
			<span className="text-muted-foreground text-xs">Not eligible</span>
		);
	} else if (option.action === "connect") {
		action = (
			<Button onClick={onOpenConnections} size="sm">
				Open Connections
			</Button>
		);
	} else if (option.action === "mcp") {
		action = (
			<Button onClick={() => onOpenRealm("mcp", brandName)} size="sm">
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				Find in MCP catalog
			</Button>
		);
	} else if (option.action === "rest-import" && connectionId) {
		action = (
			<ImportToolsAction
				body={{ id: connectionId }}
				endpoint="/api/tools/import/openapi"
				node={target}
			/>
		);
	} else if (option.action === "graphql-import" && option.url) {
		action = (
			<ImportToolsAction
				body={{ name: option.name, url: option.url }}
				endpoint="/api/tools/import/graphql"
				node={target}
			/>
		);
	} else if (option.action === "chat-setup") {
		action = chatSetup;
	} else {
		action = href ? (
			<Button
				render={<a href={href} rel="noopener noreferrer" target="_blank" />}
				size="sm"
				variant="ghost"
			>
				<HugeiconsIcon className="size-4" icon={LinkSquare01Icon} />
				View reference
			</Button>
		) : (
			chatSetup
		);
	}

	// One badge, for the exceptional state only; everything else is one muted
	// meta line under the name.
	const badge =
		option.available === false ? (
			<Badge className="shrink-0" variant="destructive">
				Unavailable
			</Badge>
		) : option.providerRole === "primary" ? (
			<Badge className="shrink-0" variant="secondary">
				Primary
			</Badge>
		) : option.isCheapest ? (
			<Badge className="shrink-0" variant="secondary">
				Lowest listed price
			</Badge>
		) : null;
	const meta = [
		SOURCE_LABELS.get(option.source) ?? option.source,
		providerOptionKind(option),
		option.providerRole === "alternative" ? tl("Alternative") : null,
		option.provider,
		option.capability,
		providerOptionPrice(option.price),
		option.availabilityNote,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className="flex min-h-12 items-center justify-between gap-3 border-border border-b py-2 last:border-b-0">
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm" title={option.name}>
						{option.name}
					</span>
					{badge}
				</div>
				{option.description ? (
					<div className="truncate text-detail text-muted-foreground">
						{option.description}
					</div>
				) : null}
				<div className="truncate text-muted-foreground text-xs">{meta}</div>
			</div>
			<span className="shrink-0">{action}</span>
		</div>
	);
}
