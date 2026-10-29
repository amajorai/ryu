import { useModelContextStore } from "@ryu/app-host/model-context";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";

/** App-supplied context stays removable until the user sends the next turn. */
export function ModelContextAttachments({ scope }: { scope: string }) {
	const tl = useLiteralMessages();
	const entries = useModelContextStore((store) => store.entries);
	const visible = Object.entries(entries).filter(
		([, entry]) => entry.scope === scope
	);
	if (visible.length === 0) {
		return null;
	}
	return (
		<div
			className="flex flex-wrap gap-2 px-3 py-2"
			data-testid="model-context-attachments"
		>
			{visible.flatMap(([owner, entry]) =>
				(entry.state.content ?? []).map((item, index) => {
					if (
						item.annotations?.audience.length === 1 &&
						item.annotations.audience[0] === "assistant"
					) {
						return null;
					}
					const title =
						item._meta?.["openai/title"] ||
						(item.type === "text"
							? item.text.slice(0, 64) || "App context"
							: item.type === "resource_link"
								? item.name
								: item.type === "resource"
									? item.resource.uri
									: "App image");
					const thumbnail =
						item.type === "image"
							? `data:${item.mimeType};base64,${item.data}`
							: item._meta?.["openai/thumbnail"]?.src;
					return (
						<div
							className="flex max-w-64 items-center gap-2 rounded-lg border bg-muted/40 ps-2"
							key={`${owner}:${entry.state.updateId}:${index}`}
						>
							{thumbnail ? (
								<img
									alt=""
									className="size-7 rounded object-cover"
									height={28}
									referrerPolicy="no-referrer"
									src={thumbnail}
									width={28}
								/>
							) : null}
							<span className="truncate text-xs" title={title}>
								{title}
							</span>
							<Button
								aria-label={tl("Remove {title}", { title })}
								onClick={() =>
									useModelContextStore.getState().remove(owner, index)
								}
								size="icon-sm"
								variant="ghost"
							>
								×
							</Button>
						</div>
					);
				})
			)}
			{visible
				.filter(([, entry]) => entry.state.structuredContent)
				.map(([owner]) => (
					<Button
						key={`${owner}:structured`}
						onClick={() =>
							useModelContextStore.getState().remove(owner, "structured")
						}
						size="sm"
						variant="outline"
					>
						App data ×
					</Button>
				))}
		</div>
	);
}
