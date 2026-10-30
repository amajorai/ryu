import { useLiteralMessages } from "@ryu/i18n/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import type { BackupOperation } from "@/src/lib/api/backups.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { bytes, scopeLabel } from "./BackupSettings-shared.ts";
import { SettingsCard } from "./shared/settings-items.tsx";

export function OperationRow({ operation }: { operation: BackupOperation }) {
	const tl = useLiteralMessages();
	const parsed = z
		.object({
			recoveryPath: z.string().optional().catch(undefined),
			spaceId: z.string().optional().catch(undefined),
			needsReindex: z.boolean().optional().catch(undefined),
		})
		.safeParse(operation.result);
	const result = parsed.success ? parsed.data : {};
	const recoveryPath = isNativeText(result.recoveryPath)
		? result.recoveryPath
		: null;
	return (
		<SettingsCard>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm">
					{operation.action === "restore" ? "Restore" : "Backup"} ·{" "}
					{scopeLabel(operation.scope)}
				</p>
				<span
					className={`text-xs ${operation.status === "failed" ? "text-status-destructive" : "text-muted-foreground"}`}
					role="status"
				>
					{operation.status === "completed"
						? "Completed"
						: operation.status === "running"
							? "Running…"
							: operation.status === "pending"
								? "Queued"
								: "Failed"}
				</span>
			</div>
			<p className="mt-1 text-muted-foreground text-xs">
				{formatDateTime(operation.createdAt)}
				{operation.backup ? ` · ${bytes(operation.backup.bytes)}` : ""}
			</p>
			{operation.error && (
				<p className="mt-2 text-sm text-status-destructive" role="alert">
					{operation.error}
				</p>
			)}
			{isNativeText(result.spaceId) && (
				<p className="mt-2 text-sm">
					{result.needsReindex === true
						? tl(
								"A new private Space has been restored. Source recovery completed; run re-indexing when an embedding model is available."
							)
						: tl(
								"A new private Space has been restored. Search indexing completed."
							)}
				</p>
			)}
			{recoveryPath && (
				<div className="mt-3 grid gap-2">
					<p className="text-sm">
						Node recovery is ready. Stop Core, then start it using the recovered
						data folder:
					</p>
					<pre className="overflow-x-auto rounded-md bg-muted p-3 font-code text-xs">{`env -u RYU_MASTER_KEY RYU_KEYCHAIN=off RYU_DIR='${recoveryPath.replaceAll("'", "'\\''")}' ryu-core`}</pre>
					<p className="text-muted-foreground text-xs">
						The recovered master key is stored privately in this folder.
						Existing node data is unchanged.
					</p>
				</div>
			)}
		</SettingsCard>
	);
}
