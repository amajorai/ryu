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
	ShoppingCart01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { EmployeeBadge } from "@ryu/ui/components/employee-badge.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTheme } from "next-themes";
import {
	Component,
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AGENT_IDENTITY_MODE_OPTIONS } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import {
	buildMysteryPool,
	drawMysteryAgent,
	MYSTERY_RARITY_STYLES,
	type MysteryAgent,
	mysteryAgentDescription,
	mysteryAgentId,
	mysteryAgentName,
	mysteryRarity,
	mysteryRarityReason,
} from "@/src/lib/agent-mystery-box.ts";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	fetchDetail,
	formatPricingLabel,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";
import { communityAgentNotice } from "./CommunityAgents.tsx";

const MysteryBoxScene = lazy(
	() => import("@ryu/ui/components/mystery-box/mystery-box-scene.tsx")
);

/** Ribbon color of a closed box — neutral, so the tier is a surprise. */
const CLOSED_ACCENT = "#d4d4d8";
/** How long after the lid pops the card starts flying out. */
const REVEAL_DELAY_MS = 180;
/** The flat fallback box's rattle, standing in for the scene's `onBurst`. */
const FLAT_BOX_OPEN_MS = 900;

type Phase = "closed" | "opening" | "revealed" | "added";

/** WebGL can be missing (remote desktops, disabled GPU): show a flat box. */
class SceneBoundary extends Component<
	{ children: ReactNode; fallback: ReactNode; onError: () => void },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch() {
		this.props.onError();
	}

	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function FlatBox({
	accent,
	opening,
	onActivate,
}: {
	accent: string;
	opening: boolean;
	onActivate: () => void;
}) {
	return (
		<div className="flex h-full items-center justify-center">
			<motion.button
				animate={
					opening
						? { rotate: [0, -8, 8, -12, 12, 0], scale: [1, 1.05, 1.1, 0.4] }
						: { rotate: 0, scale: 1 }
				}
				aria-label="Open the mystery box"
				className="flex size-36 items-center justify-center rounded-3xl bg-secondary font-bold text-6xl shadow-xl"
				disabled={opening}
				onClick={onActivate}
				style={{ boxShadow: `0 0 48px ${accent}55`, color: accent }}
				transition={{ duration: 0.9 }}
				type="button"
			>
				?
			</motion.button>
		</div>
	);
}

function errorMessage(cause: unknown): string {
	if (cause instanceof ApiError && cause.serverMessage) {
		return cause.serverMessage;
	}
	return cause instanceof Error ? cause.message : String(cause);
}

function PrizeCard({
	agent,
	accent,
	ringed,
}: {
	agent: MysteryAgent;
	accent: string;
	/** The animated metal ring is its own WebGL instance: off without WebGL. */
	ringed: boolean;
}) {
	const { resolvedTheme } = useTheme();
	const id = mysteryAgentId(agent);
	return (
		<div className="relative w-56">
			{/* The halo the card rises out of. */}
			<div
				aria-hidden="true"
				className="absolute -inset-10 rounded-full opacity-70 blur-3xl"
				style={{ background: accent }}
			/>
			<div className="relative overflow-hidden rounded-2xl">
				<EmployeeBadge
					employeeId={id}
					logo={
						agent.kind === "runtime" ? (
							<AgentCatalogLogo
								className="size-20"
								entry={agent.entry}
								size="80px"
							/>
						) : undefined
					}
					metalTheme={resolvedTheme === "light" ? "light" : "dark"}
					name={mysteryAgentName(agent)}
					ringed={ringed}
					role={mysteryAgentDescription(agent) ?? undefined}
				/>
				{/* One holographic sweep across the face, like a foil card. */}
				<motion.div
					animate={{ x: "160%" }}
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 -left-full w-full skew-x-[-20deg] mix-blend-overlay"
					initial={{ x: "0%" }}
					style={{
						background: `linear-gradient(90deg, transparent, ${accent}aa, #ffffffcc, ${accent}aa, transparent)`,
					}}
					transition={{ delay: 0.55, duration: 0.9, ease: "easeInOut" }}
				/>
			</div>
		</div>
	);
}

/**
 * What an Agent Template will do with the user's accounts, shown before Add:
 * its Identity setting (from the listing's detail read, the same one the Store
 * detail panel makes) and the trust notice the Store shows above Install.
 */
function TemplateDisclosure({ card }: { card: MarketplaceCard }) {
	const detailQuery = useQuery({
		queryKey: ["marketplace", "detail", "agent", card.id],
		queryFn: () => fetchDetail("agent", card.id),
	});
	const identityMode = detailQuery.data?.identityMode ?? null;
	return (
		<div
			className="mt-1 flex max-w-md flex-col gap-1"
			data-testid="mystery-template-disclosure"
		>
			{identityMode ? (
				<p className="font-medium text-xs">
					Identity: {AGENT_IDENTITY_MODE_OPTIONS[identityMode].title}
				</p>
			) : null}
			<p className="text-muted-foreground text-xs">
				{communityAgentNotice(identityMode)}
			</p>
		</div>
	);
}

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
				toast.success(`${prize.entry.name} is now one of your agents`);
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

				<div className="relative h-80 overflow-hidden rounded-3xl bg-gradient-to-b from-muted/40 to-muted/5">
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
											<PrizeCard
												accent={style.accent}
												agent={prize}
												ringed={!sceneFailed}
											/>
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
						? `You pulled ${mysteryAgentName(prize)}, ${style.label}.`
						: ""}
				</p>

				{showPrize ? (
					<div className="flex flex-col items-center gap-1 text-center">
						<div className="flex items-center gap-2">
							<span
								className="font-semibold text-xs uppercase tracking-widest"
								style={{ color: style.accent }}
							>
								{style.label}
							</span>
							<Badge typography="normal" variant="outline">
								{prize.kind === "runtime"
									? "Agent"
									: `Agent Template · ${prize.card.author ?? "Community"}`}
							</Badge>
						</div>
						<p className="font-heading font-medium text-lg">
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

/** The invitation at the top of the Agents tab. */
export function AgentMysteryBoxBanner({ onOpen }: { onOpen: () => void }) {
	return (
		<button
			className="group mb-6 flex w-full items-center gap-4 rounded-2xl border border-border bg-gradient-to-r from-accent/60 via-background to-background p-4 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/30"
			onClick={onOpen}
			type="button"
		>
			<span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-110">
				<HugeiconsIcon className="size-6" icon={GiftIcon} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-medium">Not sure which agent to get?</span>
				<span className="text-muted-foreground text-sm">
					Open a Mystery Box to pull a random agent from the Store — keep it or
					skip to the next one.
				</span>
			</span>
			<span className="hidden shrink-0 items-center gap-1 font-medium text-sm sm:flex">
				Open a box
				<HugeiconsIcon
					className="size-4 transition-transform group-hover:translate-x-0.5"
					icon={ArrowRight01Icon}
				/>
			</span>
		</button>
	);
}
