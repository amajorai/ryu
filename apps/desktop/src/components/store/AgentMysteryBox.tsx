// apps/desktop/src/components/store/AgentMysteryBox.tsx
//
// The Store's Agent Mystery Box: for anyone who doesn't know which agent to get.
// A 3D gift box drops in; tapping it rattles it, the lid blows off, and a random
// agent's badge flips out of the light — rarity color and all. Keep it (Add) or
// Skip, and a fresh box drops in. Pulls don't repeat until every agent in the
// pool has come out once.
//
// The draw and the rarity live in `lib/agent-mystery-box.ts`; this file is only
// the show. The 3D scene is `@ryu/ui/components/mystery-box/mystery-box-scene`,
// lazy-loaded so three.js costs nothing until a box is opened. If WebGL is
// unavailable the stage falls back to a flat box and the flow is unchanged — the
// box is a garnish, the "Open box" button is the real control.

import {
	ArrowRight01Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	GiftIcon,
	MoreHorizontalIcon,
	ShoppingCart01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	buildMysteryPool,
	drawMysteryAgent,
	MYSTERY_RARITY_STYLES,
	type MysteryAgent,
	mysteryAgentId,
	mysteryAgentName,
	mysteryRarity,
	mysteryRarityReason,
} from "@/src/lib/agent-mystery-box.ts";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import {
	formatPricingLabel,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";
import {
	CLOSED_ACCENT,
	errorMessage,
	FLAT_BOX_OPEN_MS,
	FlatBox,
	MysteryBoxScene,
	type Phase,
	PrizeCard,
	REVEAL_DELAY_MS,
	SceneBoundary,
	TemplateDisclosure,
} from "./mystery-box/MysteryBoxParts.tsx";

export interface AgentMysteryBoxProps {
	/** Add a runtime from the catalog. Rejects on failure. */
	onAddRuntime: (id: string) => Promise<void>;
	/** Install a published Agent Template. Rejects on failure. */
	onAddTemplate: (card: MarketplaceCard) => Promise<void>;
	onBuyTemplate: (card: MarketplaceCard) => void;
	onOpenChange: (open: boolean) => void;
	/** Open the pulled agent's full listing in the Store's detail panel. */
	onViewDetails: (agent: MysteryAgent) => void;
	open: boolean;
	runtimes: readonly AgentCatalogEntry[];
	templates: readonly MarketplaceCard[];
}

export function AgentMysteryBox({
	onAddRuntime,
	onAddTemplate,
	onBuyTemplate,
	onOpenChange,
	onViewDetails,
	open,
	runtimes,
	templates,
}: AgentMysteryBoxProps) {
	const tl = useLiteralMessages();
	const reducedMotion = useReducedMotion() ?? false;
	const [phase, setPhase] = useState<Phase>("closed");
	const [round, setRound] = useState(0);
	const [prize, setPrize] = useState<MysteryAgent | null>(null);
	const [cardVisible, setCardVisible] = useState(false);
	const [adding, setAdding] = useState(false);
	const [sceneFailed, setSceneFailed] = useState(false);
	const seen = useRef<ReadonlySet<string>>(new Set());
	const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const pool = useMemo(
		() => buildMysteryPool(runtimes, templates),
		[runtimes, templates]
	);

	const rarity = prize ? mysteryRarity(prize) : null;
	const style = rarity ? MYSTERY_RARITY_STYLES[rarity] : null;
	const accent = phase === "closed" || !style ? CLOSED_ACCENT : style.accent;

	const handleBurst = useCallback(() => {
		if (revealTimer.current) {
			clearTimeout(revealTimer.current);
		}
		revealTimer.current = setTimeout(() => {
			setCardVisible(true);
			setPhase("revealed");
		}, REVEAL_DELAY_MS);
	}, []);

	const openBox = useCallback(() => {
		if (phase !== "closed") {
			return;
		}
		const draw = drawMysteryAgent(pool, seen.current);
		if (!draw) {
			return;
		}
		seen.current = draw.seen;
		setPrize(draw.agent);
		setCardVisible(false);
		setPhase("opening");
	}, [phase, pool]);

	// No scene to call `onBurst` (WebGL missing, or the chunk failed — even
	// mid-open): the flat box's rattle stands in for it.
	useEffect(() => {
		if (!(sceneFailed && phase === "opening")) {
			return;
		}
		const timer = setTimeout(handleBurst, reducedMotion ? 0 : FLAT_BOX_OPEN_MS);
		return () => clearTimeout(timer);
	}, [handleBurst, phase, reducedMotion, sceneFailed]);

	useEffect(
		() => () => {
			if (revealTimer.current) {
				clearTimeout(revealTimer.current);
			}
		},
		[]
	);

	const nextBox = useCallback(() => {
		if (revealTimer.current) {
			clearTimeout(revealTimer.current);
		}
		setCardVisible(false);
		setPhase("closed");
		setRound((value) => value + 1);
	}, []);

	const addPrize = async () => {
		if (!prize) {
			return;
		}
		setAdding(true);
		try {
			if (prize.kind === "runtime") {
				await onAddRuntime(prize.entry.id);
				toast.success(
					tl("{name} is now one of your agents", { name: prize.entry.name })
				);
			} else {
				await onAddTemplate(prize.card);
			}
			setPhase("added");
		} catch (cause) {
			toast.error("Couldn't add this agent", {
				description: errorMessage(cause),
			});
		} finally {
			setAdding(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (!next) {
			nextBox();
			setPrize(null);
		}
		onOpenChange(next);
	};

	const pricing = prize?.kind === "template" ? prize.card.pricing : null;
	const reason = prize ? mysteryRarityReason(prize) : null;
	const showPrize = cardVisible && prize && style;

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Agent Mystery Box</DialogTitle>
					<DialogDescription>
						Not sure which agent to get? Open a box to pull a random one from
						the Store. Keep it, or skip it and open another.
					</DialogDescription>
				</DialogHeader>

				<div className="relative h-80 overflow-hidden rounded-xl bg-muted">
					{pool.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
							<HugeiconsIcon
								className="size-8 text-muted-foreground"
								icon={CheckmarkCircle02Icon}
							/>
							<p className="font-medium">You've collected every agent</p>
							<p className="text-muted-foreground text-sm">
								Nothing is left to pull — every available agent is already
								added.
							</p>
						</div>
					) : (
						<>
							<div
								className={cn(
									"absolute inset-0 transition-opacity duration-500",
									showPrize ? "opacity-30" : "opacity-100"
								)}
							>
								<SceneBoundary
									fallback={
										<FlatBox
											accent={accent}
											onActivate={openBox}
											opening={phase === "opening"}
										/>
									}
									onError={() => setSceneFailed(true)}
								>
									<Suspense fallback={null}>
										<MysteryBoxScene
											accent={accent}
											className="h-full w-full"
											onActivate={openBox}
											onBurst={handleBurst}
											opening={phase !== "closed"}
											reducedMotion={reducedMotion}
											round={round}
										/>
									</Suspense>
								</SceneBoundary>
							</div>
							<div
								className="pointer-events-none absolute inset-0 flex items-center justify-center"
								style={{ perspective: 1200 }}
							>
								<AnimatePresence>
									{showPrize ? (
										<motion.div
											animate={{ opacity: 1, rotateY: 0, scale: 1, y: 0 }}
											className="pointer-events-auto"
											exit={
												reducedMotion
													? { opacity: 0 }
													: {
															opacity: 0,
															rotate: -14,
															transition: { duration: 0.35 },
															x: -360,
														}
											}
											initial={
												reducedMotion
													? { opacity: 0, rotateY: 0, scale: 1, y: 0 }
													: { opacity: 0, rotateY: -540, scale: 0.2, y: 110 }
											}
											key={mysteryAgentId(prize)}
											style={{ transformStyle: "preserve-3d" }}
											transition={
												reducedMotion
													? { duration: 0.2 }
													: {
															damping: 15,
															mass: 0.9,
															stiffness: 110,
															type: "spring",
														}
											}
										>
											<PrizeCard agent={prize} ringed={!sceneFailed} />
										</motion.div>
									) : null}
								</AnimatePresence>
							</div>
							{phase === "closed" ? (
								<p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-muted-foreground text-xs">
									Tap the box to open it
								</p>
							) : null}
						</>
					)}
				</div>

				<p aria-live="polite" className="sr-only">
					{showPrize
						? tl("You pulled {name}, {label}.", {
								name: mysteryAgentName(prize),
								label: style.label,
							})
						: ""}
				</p>

				{showPrize ? (
					<div className="flex flex-col items-center gap-1 text-center">
						<div className="flex items-center gap-2">
							<span
								className="text-detail text-muted-foreground"
								style={{ color: style.accent }}
							>
								{style.label}
							</span>
							<Badge typography="normal" variant="outline">
								{prize.kind === "runtime"
									? "Agent"
									: tl("Agent Template · {author}", {
											author: prize.card.author ?? "Community",
										})}
							</Badge>
						</div>
						<p className="font-semibold text-lg tracking-tight">
							{mysteryAgentName(prize)}
						</p>
						{reason ? (
							<p className="text-muted-foreground text-xs">{reason}</p>
						) : null}
						{prize.kind === "template" ? (
							<TemplateDisclosure card={prize.card} />
						) : null}
					</div>
				) : null}

				<DialogFooter>
					{phase === "revealed" && prize ? (
						<>
							<Button onClick={nextBox} variant="ghost">
								Skip
								<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
							</Button>
							<Button onClick={() => onViewDetails(prize)} variant="ghost">
								View details
							</Button>
							{pricing && prize.kind === "template" ? (
								<Button
									onClick={() => onBuyTemplate(prize.card)}
									variant="secondary"
								>
									<HugeiconsIcon className="size-4" icon={ShoppingCart01Icon} />
									<span className="font-mono tabular-nums">
										{formatPricingLabel(pricing)}
									</span>
								</Button>
							) : null}
							<Button loading={adding} onClick={addPrize}>
								{adding ? null : (
									<HugeiconsIcon className="size-4" icon={Download01Icon} />
								)}
								Add to my agents
							</Button>
						</>
					) : null}
					{phase === "added" && prize ? (
						<>
							<Button onClick={() => onViewDetails(prize)} variant="ghost">
								View details
							</Button>
							<Button onClick={nextBox}>
								<HugeiconsIcon className="size-4" icon={GiftIcon} />
								Open another
							</Button>
						</>
					) : null}
					{phase === "closed" || phase === "opening" ? (
						<Button
							disabled={pool.length === 0}
							loading={phase === "opening"}
							onClick={openBox}
						>
							{phase === "opening" ? null : (
								<HugeiconsIcon className="size-4" icon={GiftIcon} />
							)}
							{phase === "opening" ? "Opening…" : "Open box"}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The Agents tab's `⋯`: the Mystery Box lives here rather than as a banner
 *  over the list, so the catalog opens on the agents themselves. */
export function AgentsOverflowMenu({
	onOpenMysteryBox,
}: {
	onOpenMysteryBox: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="More agent actions"
						size="icon-sm"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-52">
				<DropdownMenuItem onClick={onOpenMysteryBox}>
					<HugeiconsIcon className="size-4" icon={GiftIcon} />
					Open a Mystery Box
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
