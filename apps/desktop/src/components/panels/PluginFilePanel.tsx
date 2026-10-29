import { Button } from "@ryu/ui/components/button.tsx";
import { useMemo } from "react";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { PluginFileHandler } from "@/src/lib/api/plugins.ts";
import {
	createOpenedFileAccess,
	ownedCompanionId,
} from "@/src/lib/plugin-file-handlers.ts";
import PluginCompanionPage from "@/src/pages/PluginCompanionPage.tsx";

export function PluginFilePanel({
	path,
	handler,
	onClose,
}: {
	path: string;
	handler: PluginFileHandler;
	onClose(): void;
}) {
	const { companions, file_handlers: handlers = [] } = usePluginContributions();
	const enabled = handlers.some(
		(entry) => entry.id === handler.id && entry.plugin === handler.plugin
	);
	const companionId = ownedCompanionId(
		handler.companion,
		handler.plugin,
		companions
	);
	const fileAccess = useMemo(
		() => createOpenedFileAccess(path, handler.editable),
		[path, handler.editable]
	);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-2 border-b px-3 py-2">
				<span className="min-w-0 flex-1 truncate text-sm">
					{fileAccess.name} · {handler.title}
				</span>
				<Button onClick={onClose} size="sm" variant="ghost">
					Back to files
				</Button>
			</div>
			<div className="min-h-0 flex-1">
				{enabled && companionId ? (
					<PluginCompanionPage
						companionId={companionId}
						fileAccess={fileAccess}
						mountContext={{
							surface: "file",
							file: {
								uri: fileAccess.uri,
								name: fileAccess.name,
								editable: fileAccess.editable,
							},
						}}
					/>
				) : (
					<p className="p-4 text-muted-foreground text-sm" role="status">
						This file handler is no longer enabled.
					</p>
				)}
			</div>
		</div>
	);
}
