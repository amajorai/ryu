import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	Activity,
	Code,
	FileText,
	type LucideIcon,
	Palette,
	SquareKanban,
	SquareTerminal,
} from "lucide-react";
import { memo } from "react";
import type { LiveArtKind, LiveArtSpec } from "./live-model.ts";
import { liveStage } from "./live-palette.ts";

/** The segment a stream is in, shown on its stage like a broadcast bug. */
export const LIVE_SEGMENTS: Record<
	LiveArtKind,
	{ icon: LucideIcon; label: string }
> = {
	board: { icon: SquareKanban, label: "Planning" },
	canvas: { icon: Palette, label: "Design" },
	chart: { icon: Activity, label: "Ops" },
	code: { icon: Code, label: "Code" },
	doc: { icon: FileText, label: "Writing" },
	terminal: { icon: SquareTerminal, label: "Terminal" },
};

/** The facecam: the agent's picture framed in the channel colour, with a name plate. */
function LiveCam({
	agent,
	colors,
}: {
	agent: InterfaceAgent;
	colors: ReturnType<typeof liveStage>;
}) {
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<span className="absolute top-[7%] right-[4%] flex w-[19%] flex-col items-stretch">
			<span
				className="relative block aspect-square overflow-hidden rounded-[1.4cqw] border-[0.5cqw] bg-black/30"
				style={{ borderColor: colors.frame }}
			>
				{agent.avatarUrl ? (
					<img
						alt=""
						className="size-full object-cover"
						height={64}
						src={agent.avatarUrl}
						width={64}
					/>
				) : (
					<DitherAvatar animate={false} className="size-full" name={seed} />
				)}
			</span>
			<span
				className="mt-[1.2cqw] truncate rounded-[0.8cqw] px-[1.4cqw] py-[0.9cqw] text-center font-bold text-[clamp(8px,2.4cqw,16px)] uppercase leading-none tracking-wider"
				style={{ background: colors.frame, color: colors.frameText }}
			>
				{agent.name}
			</span>
		</span>
	);
}

/**
 * A stream frame, built from the thread rather than faked: a stage lit in the
 * channel's colour, the segment it is in, the agent on camera, and the content
 * itself, the latest message on thumbnails and the stream's title in the
 * player (where captions carry the message). Sized in container units so it
 * reads the same from a grid tile to the player. Decorative: the tile or
 * player around it carries everything in text.
 */
export const LiveScene = memo(function LiveSceneImpl({
	agent = null,
	className,
	mode = "thumb",
	spec,
}: {
	agent?: InterfaceAgent | null;
	className?: string;
	mode?: "player" | "thumb";
	spec: LiveArtSpec;
}) {
	const colors = liveStage(spec);
	const segment = LIVE_SEGMENTS[spec.kind];
	const Icon = segment.icon;
	const player = mode === "player";
	const quote = !player && spec.excerpt;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"absolute inset-0 block overflow-hidden text-left",
				className
			)}
			data-art={spec.kind}
			style={{ background: colors.ground, color: colors.text }}
		>
			<span
				className={cn(
					"absolute left-[6%] flex w-[64%] flex-col",
					player ? "top-[14%]" : "top-[24%]"
				)}
			>
				<span
					className="flex items-center gap-[1.2cqw] font-semibold text-[clamp(9px,2.8cqw,16px)] uppercase leading-none tracking-[0.14em]"
					style={{ color: colors.accent }}
				>
					<Icon className="size-[1.25em] shrink-0" strokeWidth={2.25} />
					{segment.label}
				</span>
				{quote ? (
					<>
						<span className="mt-[2.4cqw] line-clamp-3 text-pretty font-semibold text-[clamp(11px,5cqw,30px)] leading-[1.22] tracking-tight">
							{spec.excerpt}
						</span>
						<span
							className="mt-[1.8cqw] truncate font-medium text-[clamp(10px,3cqw,16px)]"
							style={{ color: colors.muted }}
						>
							{spec.speaker}
						</span>
					</>
				) : (
					<span
						className={cn(
							"mt-[2cqw] line-clamp-3 text-balance font-bold leading-[1.08] tracking-tight",
							player
								? "text-[clamp(18px,4.6cqw,44px)]"
								: "text-[clamp(12px,6cqw,32px)]"
						)}
					>
						{spec.title}
					</span>
				)}
			</span>
			{agent ? <LiveCam agent={agent} colors={colors} /> : null}
		</span>
	);
});
