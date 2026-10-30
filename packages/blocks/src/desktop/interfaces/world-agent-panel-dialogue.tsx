import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { frameStyle, SV_PLANK_TEXT, SV_TEXT } from "./world-2d-frame.ts";
import { PixelPortrait } from "./world-2d-portrait.tsx";
import { WorkingDots } from "./world-agent-panel-icons.tsx";
import { UI_FONT } from "./world-agent-panel-styles.ts";

/** The villager's framed portrait with the name plate under it. */
function PortraitCard({
	agent,
	lookIndex,
	small,
}: {
	agent: InterfaceAgent;
	lookIndex: number;
	small: boolean;
}) {
	return (
		<div className="flex shrink-0 flex-col items-center gap-1.5">
			<div
				className="flex items-end justify-center overflow-hidden"
				style={frameStyle("slot", 2)}
			>
				{/* A narrow panel (or an open thread) gets the 2x bust. */}
				<PixelPortrait
					agentId={agent.id}
					className={cn("-mb-[4px]", small ? null : "@sm:hidden")}
					crop="bust"
					lookIndex={lookIndex}
					scale={2}
					working={agent.status === "working"}
				/>
				{small ? null : (
					<PixelPortrait
						agentId={agent.id}
						className="-mb-[4px] @sm:block hidden"
						crop="bust"
						lookIndex={lookIndex}
						scale={3}
						working={agent.status === "working"}
					/>
				)}
			</div>
			<p
				className={cn(
					"max-w-[120px] truncate text-center text-[13px] leading-none",
					UI_FONT
				)}
				style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
			>
				{agent.name}
			</p>
		</div>
	);
}

const GREETINGS = [
	"What do you need?",
	"What are we working on today?",
	"Got something for me?",
	"Good to see you. What's up?",
] as const;

/** What the villager says when you walk up: a line in their own voice. */
function villagerLine(
	agent: InterfaceAgent,
	threads: readonly InterfaceThread[],
	brief: boolean
): string {
	if (agent.status === "working") {
		const busy = threads.find((thread) => thread.running);
		const line = busy?.title
			? `Hang on, I'm deep in “${busy.title}”.`
			: "Hang on, I'm in the middle of something.";
		return brief ? line : `${line} Leave me a note and I'll get to it.`;
	}
	let hash = 0;
	for (const char of agent.id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
	}
	const greeting = GREETINGS[hash % GREETINGS.length] ?? GREETINGS[0];
	return threads.length > 0
		? `Hey, it's ${agent.name} again! ${greeting}`
		: `Hey! I'm ${agent.name}. First time stopping by? ${greeting}`;
}

/** The dialogue box: the villager's line beside the portrait. */
export function DialogueBox({
	agent,
	compact,
	lookIndex,
	threads,
}: {
	agent: InterfaceAgent;
	compact: boolean;
	lookIndex: number;
	threads: readonly InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	const working = agent.status === "working";
	return (
		<section
			aria-label={tl("{name} says", { name: agent.name })}
			className="flex shrink-0 items-start gap-3 p-1.5"
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-2 self-stretch pt-0.5">
				<p
					className={cn(
						"font-sans font-semibold text-[17px] leading-snug",
						compact && "line-clamp-2"
					)}
				>
					{villagerLine(agent, threads, compact)}
				</p>
				{agent.description ? (
					<p
						className={cn(
							"font-sans font-semibold text-[#7a4a24] text-[12px] leading-tight",
							compact && "line-clamp-1"
						)}
					>
						<span className="sr-only">Role: </span>
						{agent.description}
					</p>
				) : null}
				<p
					className={cn(
						"mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-[#e2b36e] border-t-2 border-dashed pt-2 text-[12px] leading-none",
						UI_FONT
					)}
				>
					{working ? (
						<>
							<WorkingDots />
							<span>Working</span>
						</>
					) : (
						<span className="text-[#5b7a2a]">Idle · ready to talk</span>
					)}
					<span aria-hidden="true" className="text-[#c99a5a]">
						·
					</span>
					<span className="text-[#7a4a24]">
						{threads.length > 0
							? tl(
									"{count, plural, one {{countText} past chat} other {{countText} past chats}}",
									{ count: threads.length, countText: String(threads.length) }
								)
							: "First visit"}
					</span>
				</p>
			</div>
			<PortraitCard agent={agent} lookIndex={lookIndex} small={compact} />
		</section>
	);
}
