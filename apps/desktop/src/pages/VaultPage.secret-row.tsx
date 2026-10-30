import { Delete02Icon, RestoreBinIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { ROOT_FOLDER, STATUS_COPY } from "@/src/components/vault/vault-view.ts";
import type { VaultSecret } from "@/src/lib/api/vault.ts";
import {
	formatUpdatedAt,
	scopeIdLabel,
	scopeLabel,
} from "./VaultPage.model.ts";

export function SecretRow({
	deleteDisabled,
	onDelete,
	onOpen,
	onRestore,
	restoreDisabled,
	secret,
}: {
	deleteDisabled: boolean;
	onDelete: () => void;
	onOpen: () => void;
	onRestore: () => void;
	restoreDisabled: boolean;
	secret: VaultSecret;
}) {
	const tl = useLiteralMessages();
	const statusCopy =
		secret.status === "active" ? null : STATUS_COPY[secret.status];
	const isDeleted = secret.status === "deleted";
	return (
		<div className="flex items-center justify-between gap-4 p-4">
			<button
				aria-label={tl("Open {name}", { name: secret.name })}
				className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
				onClick={onOpen}
				type="button"
			>
				<span className="flex flex-wrap items-center gap-2">
					<code
						className={
							isDeleted
								? "font-medium font-mono text-muted-foreground text-sm line-through"
								: "font-medium font-mono text-sm"
						}
					>
						{secret.name}
					</code>
					<Badge variant="secondary">{scopeLabel(secret.scope)}</Badge>
					{secret.source === "control-plane" ? (
						<Badge variant="outline">Shared</Badge>
					) : null}
					{secret.binding ? (
						<Badge typography="code" variant="outline">
							mcp:{secret.binding.id}
						</Badge>
					) : (
						<Badge variant="outline">all MCP consumers</Badge>
					)}
					{statusCopy ? (
						<Badge variant={statusCopy.variant}>{statusCopy.label}</Badge>
					) : null}
				</span>
				<span className="mt-1 block truncate text-detail text-muted-foreground">
					{tl("{scope}{path} · v{version} · updated {updated}", {
						scope: scopeIdLabel(secret.scope, secret.scopeId),
						path: secret.path === ROOT_FOLDER ? "" : ` · ${secret.path}`,
						version: String(secret.version),
						updated: formatUpdatedAt(secret.updatedAt),
					})}
				</span>
			</button>
			{isDeleted ? (
				secret.capabilities.includes("write") ? (
					<Button
						aria-label={tl("Restore {name}", { name: secret.name })}
						disabled={restoreDisabled}
						onClick={onRestore}
						size="icon"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={RestoreBinIcon} />
					</Button>
				) : null
			) : secret.capabilities.includes("delete") ? (
				<Button
					aria-label={tl("Delete {name}", { name: secret.name })}
					disabled={deleteDisabled}
					onClick={onDelete}
					size="icon"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				</Button>
			) : null}
		</div>
	);
}
