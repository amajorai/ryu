import { LazyPatchDiff } from "@ryu/blocks/desktop/agent-elements/lazy-patch-diff.tsx";
import { usePierreShadowLocalizer } from "@ryu/blocks/desktop/agent-elements/use-pierre-shadow-localizer.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card.tsx";
import type { ReactElement } from "react";

export function DiffFilePreviewPopover({
	children,
	filePath,
	patch,
}: {
	children: ReactElement;
	filePath: string;
	patch: string;
}) {
	const tl = useLiteralMessages();
	const localizeDiffCopy = usePierreShadowLocalizer();
	return (
		<HoverCard>
			<HoverCardTrigger closeDelay={120} delay={180} render={children} />
			<HoverCardContent
				align="start"
				appearance="composer-preview"
				className="w-[min(42rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden"
				side="left"
				sideOffset={10}
			>
				<div className="mb-1 flex items-center gap-2 px-2 py-1 text-muted-foreground text-xs">
					<span className="min-w-0 flex-1 truncate font-mono text-foreground">
						{filePath}
					</span>
					<span>{tl("Preview")}</span>
				</div>
				<div
					className="max-h-[28rem] overflow-auto rounded-xl border border-border/60 bg-background/60"
					ref={localizeDiffCopy}
				>
					<LazyPatchDiff
						disableWorkerPool
						options={{
							diffStyle: "unified",
							lineHoverHighlight: "line",
						}}
						patch={patch}
					/>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
