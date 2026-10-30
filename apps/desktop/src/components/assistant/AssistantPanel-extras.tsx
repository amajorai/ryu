import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	AssistantBuilderSession,
	PageContextItem,
} from "@/src/store/useAssistantStore.ts";
import { surfaceDescription } from "./AssistantPanel-request.ts";

/** Empty-state header for a takeover, worded per surface, with the surface's own
 *  one-tap starter prompts underneath (an app declares them; the built-in
 *  builders declare none and simply render nothing extra). */
export function BuilderEmptyState({
	onPrompt,
	session,
	title,
}: {
	onPrompt: (prompt: string) => void;
	session: AssistantBuilderSession;
	title: string | null;
}) {
	const prompts = session.prompts?.filter((p) => p.trim().length > 0) ?? [];
	return (
		<div className="flex flex-col gap-1 px-1 pb-3 text-center">
			<span className="font-medium text-sm">{title}</span>
			<span className="text-detail text-muted-foreground">
				{surfaceDescription(session)}
			</span>
			{prompts.length > 0 ? (
				<div className="mt-2 flex flex-wrap justify-center gap-1.5">
					{prompts.map((prompt) => (
						<Button
							className="rounded-full"
							key={prompt}
							onClick={() => onPrompt(prompt)}
							size="sm"
							variant="outline"
						>
							{prompt}
						</Button>
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * The page-context chips — shown in generic chat and on app-defined surfaces,
 * not in the built-in agent/workflow builders. Extracted so the panel's render
 * stays lean.
 */
export function GenericAssistantExtras(props: {
	divider: string;
	effectiveContext: PageContextItem[];
	genericContext: PageContextItem | null;
	onDismissContext: () => void;
	onRemovePageContext: (id: string) => void;
	onRestoreContext: () => void;
}) {
	const { divider, effectiveContext, genericContext } = props;
	const tl = useLiteralMessages();
	return effectiveContext.length > 0 ? (
		<div
			className={cn(
				"flex shrink-0 flex-wrap items-center gap-1.5 px-3 py-2",
				divider
			)}
		>
			{effectiveContext.map((c) => (
				<span
					className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs"
					key={c.id}
				>
					<span className="truncate" title={c.title}>
						{c.title}
					</span>
					{/* Shell-set attribution — an app feeding the assistant says so. */}
					{c.source ? (
						<span className="shrink-0 opacity-60">· {c.source}</span>
					) : null}
					<button
						aria-label={tl("Remove {title} from context", { title: c.title })}
						className="shrink-0 rounded-full p-0.5 hover:bg-background"
						onClick={() =>
							c.id.startsWith("tab:")
								? props.onDismissContext()
								: props.onRemovePageContext(c.id)
						}
						type="button"
					>
						<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
					</button>
				</span>
			))}
		</div>
	) : (
		genericContext && (
			<div className={cn("flex shrink-0 items-center px-3 py-1.5", divider)}>
				<button
					className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
					onClick={() => props.onRestoreContext()}
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
					Add current page
				</button>
			</div>
		)
	);
}
