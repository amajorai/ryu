import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { useId } from "react";
import { compactAge } from "./interface-renderer.ts";
import { frameStyle, SV_PLANK_TEXT, SV_TEXT } from "./world-2d-frame.ts";
import { ChoicePointer } from "./world-agent-panel-icons.tsx";
import { UI_FONT } from "./world-agent-panel-styles.ts";

/** Past conversations as Stardew dialogue choices. */
export function DialogueChoices({
	onOpen,
	threads,
}: {
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-h-[6.5rem] shrink flex-col gap-1.5 px-1.5 pb-1"
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<h3
				className={cn(
					"-mt-[22px] self-start px-1 text-[12px] uppercase leading-none tracking-[0.06em]",
					UI_FONT
				)}
				id={headingId}
				style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
			>
				Past conversations
			</h3>
			{threads.length === 0 ? (
				<p className="font-sans font-semibold text-[#7a4a24] text-[14px] leading-snug">
					Nothing yet. Say something below to start your first conversation.
				</p>
			) : null}
			<ul className="-mx-1 flex max-h-[13.5rem] min-h-0 flex-col overflow-y-auto px-1 [scrollbar-color:#c99a5a_transparent] [scrollbar-width:thin]">
				{threads.map((thread) => (
					<li key={thread.id}>
						<button
							className="group flex w-full items-center gap-2 border-2 border-transparent py-1.5 pr-1.5 pl-0.5 text-left font-sans font-semibold text-[15px] leading-tight outline-none hover:border-[#d9a25a] hover:bg-[#ecc681] focus-visible:border-[#5b2a0b] focus-visible:bg-[#ecc681]"
							onClick={() => onOpen(thread.id)}
							type="button"
						>
							<ChoicePointer />
							<span className="min-w-0 flex-1 truncate">
								{thread.title || "Untitled"}
							</span>
							{thread.running ? (
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5 text-[#2f6b1f] text-[11px]",
										UI_FONT
									)}
								>
									<span
										aria-hidden="true"
										className="size-[6px] bg-[#4f9534] motion-safe:animate-pulse"
									/>
									Working
								</span>
							) : null}
							<span className="shrink-0 text-[#7a4a24] text-[12px] tabular-nums">
								{compactAge(thread.updatedAt)}
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
