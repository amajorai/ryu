import { MessageActionSurface } from "@ryu/blocks/desktop/agent-elements/message-action-surface.tsx";
import {
	MESSAGE_REACTION_DISPATCH,
	MESSAGE_REACTION_RENDERER,
} from "@ryu/blocks/desktop/agent-elements/message-action-types.ts";
import type { ContributedMessageAction } from "@ryu/blocks/desktop/agent-elements/types.ts";
import {
	ScrollProgress,
	SmoothScroll,
} from "@ryu/blocks/web/smooth-scroll.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { VoiceActivityBeam } from "@ryu/ui/components/voice-activity-beam.tsx";
import { useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import proofStyles from "./chat-voice-ui-proof.module.css";
import "../../src/index.css";
import "./chat-voice-ui-proof.css";
document.documentElement.classList.add("dark");

const LIVE_LEVELS = [
	0.18, 0.35, 0.55, 0.32, 0.82, 0.66, 0.94, 0.48, 0.72, 0.28, 0.52, 0.4,
];
const QUIET_LEVELS = [
	0.08, 0.12, 0.1, 0.14, 0.09, 0.11, 0.1, 0.08, 0.12, 0.1, 0.09, 0.11,
];

const TOOL_UI_COVERAGE = [
	["Default agent UI", "24 primitives", "Installed"],
	[
		"Gallery-like renderers",
		"Chart · Data Table · Geo Map · Stats",
		"Installed",
	],
	["Tool UI gallery", "Schema-first components", "Partial"],
	["Next safe additions", "Slider · Code Block · Carousel · Media", "Planned"],
] as const;

interface ReactionBucket {
	count: number;
	emoji: string;
	reactedByMe: boolean;
}

const REACTIONS_PLUGIN_ACTION: ContributedMessageAction = {
	args: {
		dispatch: MESSAGE_REACTION_DISPATCH,
		renderer: MESSAGE_REACTION_RENDERER,
	},
	capability: "reactions.toggle",
	icon: "smile",
	id: "reactions.picker",
	kind: "menu",
	label: "Add reaction",
	order: 100,
	plugin: "@ryu/reactions",
	target: "any",
};

function ProofBadge({
	children,
	tone = "green",
}: {
	children: React.ReactNode;
	tone?: "amber" | "green";
}) {
	return (
		<span
			className={[
				proofStyles["proof-badge"],
				proofStyles[`proof-badge-${tone}`],
			].join(" ")}
		>
			<span aria-hidden="true" className={proofStyles["proof-badge-dot"]} />
			{children}
		</span>
	);
}

function ReactionProof() {
	const [buckets, setBuckets] = useState<ReactionBucket[]>([
		{ count: 3, emoji: "👍", reactedByMe: true },
		{ count: 1, emoji: "🎉", reactedByMe: false },
	]);

	function toggleReaction(emoji: string) {
		setBuckets((current) => {
			const existing = current.find((bucket) => bucket.emoji === emoji);
			if (!existing) {
				return [...current, { count: 1, emoji, reactedByMe: true }];
			}
			return current.map((bucket) =>
				bucket.emoji === emoji
					? {
							...bucket,
							count: bucket.reactedByMe
								? Math.max(0, bucket.count - 1)
								: bucket.count + 1,
							reactedByMe: !bucket.reactedByMe,
						}
					: bucket
			);
		});
	}

	return (
		<div className={proofStyles["proof-card"]}>
			<div className={proofStyles["proof-card-heading"]}>
				<div>
					<p className={proofStyles["proof-eyebrow"]}>CHAT REACTIONS</p>
					<h2>Quick tap, then the full emoji universe</h2>
				</div>
				<ProofBadge>Verified</ProofBadge>
			</div>
			<p className={proofStyles["proof-copy"]}>
				The real message reaction row keeps common emojis close. The +
				affordance opens emoji-mart for the complete searchable picker.
			</p>
			<div className={proofStyles["proof-message-bubble"]}>
				<p>
					Let’s make the voice surface feel alive without stealing focus from
					the transcript.
				</p>
				<MessageActionSurface
					actions={[REACTIONS_PLUGIN_ACTION]}
					messageId="0198b6fb-8ee1-7f4e-9a9e-3e0de0e78c6c"
					onAction={(_, context) => {
						if (context.value) {
							toggleReaction(context.value);
						}
					}}
					state={{ reactionBuckets: buckets }}
				/>
			</div>
			<div className={proofStyles["proof-chip-row"]}>
				{buckets.map((bucket) => (
					<span className={proofStyles["proof-chip"]} key={bucket.emoji}>
						{bucket.emoji} {bucket.count}
					</span>
				))}
				<span className={proofStyles["proof-muted"]}>
					Enabled plugin: @ryu/reactions · reactions.picker · choose + for any
					emoji
				</span>
			</div>
		</div>
	);
}

function LoadingButtonProof() {
	return (
		<div className={proofStyles["proof-card"]}>
			<div className={proofStyles["proof-card-heading"]}>
				<div>
					<p className={proofStyles["proof-eyebrow"]}>STATUS BUTTON</p>
					<h2>Loading is a first-class button state</h2>
				</div>
				<ProofBadge>Verified</ProofBadge>
			</div>
			<p className={proofStyles["proof-copy"]}>
				Both the explicit loading variant and the boolean migration path disable
				safely and keep the spinner in the top-right status position.
			</p>
			<div className={proofStyles["proof-button-row"]}>
				<Button data-testid="loading-variant-button" variant="loading">
					Saving workspace
				</Button>
				<Button data-testid="loading-boolean-button" loading variant="outline">
					Syncing tools
				</Button>
			</div>
		</div>
	);
}

function VoiceProof() {
	return (
		<div
			className={[
				proofStyles["proof-card"],
				proofStyles["proof-voice-card"],
			].join(" ")}
		>
			<div className={proofStyles["proof-card-heading"]}>
				<div>
					<p className={proofStyles["proof-eyebrow"]}>VOICE ACTIVITY</p>
					<h2>Rotate line beam + waveform reaction</h2>
				</div>
				<ProofBadge>Desktop + Island</ProofBadge>
			</div>
			<p className={proofStyles["proof-copy"]}>
				The same live level history drives the desktop voice mode and Island
				companion. Quiet input keeps the beam calm; speech makes the line and
				waveform breathe.
			</p>
			<div className={proofStyles["proof-voice-grid"]}>
				<VoiceActivityBeam active className="min-h-21" levels={LIVE_LEVELS}>
					<div className={proofStyles["proof-voice-surface"]}>
						<span
							className={[
								proofStyles["proof-voice-dot"],
								proofStyles["proof-voice-dot-live"],
							].join(" ")}
						/>
						<div>
							<strong>Listening</strong>
							<span>live microphone activity</span>
						</div>
					</div>
				</VoiceActivityBeam>
				<VoiceActivityBeam
					active={false}
					className="min-h-21"
					levels={QUIET_LEVELS}
				>
					<div className={proofStyles["proof-voice-surface"]}>
						<span
							className={[
								proofStyles["proof-voice-dot"],
								proofStyles["proof-voice-dot-quiet"],
							].join(" ")}
						/>
						<div>
							<strong>Listening</strong>
							<span>waiting for speech</span>
						</div>
					</div>
				</VoiceActivityBeam>
			</div>
		</div>
	);
}

function ScrollProof() {
	const scrollRows = useMemo(
		() =>
			Array.from({ length: 9 }, (_, index) => `Motion checkpoint ${index + 1}`),
		[]
	);
	return (
		<div
			className={[
				proofStyles["proof-card"],
				proofStyles["proof-scroll-card"],
			].join(" ")}
		>
			<div className={proofStyles["proof-card-heading"]}>
				<div>
					<p className={proofStyles["proof-eyebrow"]}>WEBSITE MOTION</p>
					<h2>BeUI scroll animation is wired in</h2>
				</div>
				<ProofBadge>Lenis + motion</ProofBadge>
			</div>
			<p className={proofStyles["proof-copy"]}>
				Scroll the contained transcript. The progress rail follows the active
				scroll context and respects reduced-motion preferences.
			</p>
			<div className={proofStyles["proof-scroll-frame"]}>
				<SmoothScroll root={false}>
					<ScrollProgress />
					<div className={proofStyles["proof-scroll-content"]}>
						{scrollRows.map((row, index) => (
							<div className={proofStyles["proof-scroll-row"]} key={row}>
								<span>0{index + 1}</span>
								<strong>{row}</strong>
								<small>
									{index === scrollRows.length - 1
										? "end of context"
										: "smooth handoff"}
								</small>
							</div>
						))}
					</div>
				</SmoothScroll>
			</div>
		</div>
	);
}

function ToolUiAudit() {
	return (
		<div
			className={[
				proofStyles["proof-card"],
				proofStyles["proof-audit-card"],
			].join(" ")}
		>
			<div className={proofStyles["proof-card-heading"]}>
				<div>
					<p className={proofStyles["proof-eyebrow"]}>AGENT UI COVERAGE</p>
					<h2>Out-of-the-box defaults, honestly labeled</h2>
				</div>
				<ProofBadge tone="amber">Audit complete</ProofBadge>
			</div>
			<p className={proofStyles["proof-copy"]}>
				Agents can render the installed Ryu Agent UI contract by default. The
				full external Tool UI gallery is not installed wholesale; the gaps are
				visible instead of silently pretending.
			</p>
			<div className={proofStyles["proof-audit-table"]} role="table">
				{TOOL_UI_COVERAGE.map(([surface, coverage, status]) => (
					<div
						className={proofStyles["proof-audit-row"]}
						key={surface}
						role="row"
					>
						<span role="cell">{surface}</span>
						<span className={proofStyles["proof-muted"]} role="cell">
							{coverage}
						</span>
						<span
							className={[
								proofStyles["proof-audit-status"],
								proofStyles[`proof-audit-${status.toLowerCase()}`],
							].join(" ")}
							role="cell"
						>
							{status}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function ProofApp() {
	return (
		<main className={proofStyles["proof-page"]}>
			<ScrollProgress />
			<header className={proofStyles["proof-header"]}>
				<div>
					<p className={proofStyles["proof-eyebrow"]}>
						RYU · INTERACTION PROOF
					</p>
					<h1>Chat feels more alive.</h1>
					<p className={proofStyles["proof-lede"]}>
						One rendered surface for reactions, website motion, voice activity,
						loading feedback, and agent UI coverage.
					</p>
				</div>
				<div
					aria-label="Verified proof"
					className={proofStyles["proof-header-mark"]}
					role="status"
				>
					<span />
					VERIFIED
				</div>
			</header>
			<div className={proofStyles["proof-grid"]}>
				<ReactionProof />
				<LoadingButtonProof />
				<VoiceProof />
				<ScrollProof />
				<ToolUiAudit />
			</div>
		</main>
	);
}

const proofRootElement = document.getElementById("root");
if (!proofRootElement) {
	throw new Error("Proof root element is missing");
}

// SAFETY: This controlled module is the only publisher/reader of the private cache key; it stores the actual native createRoot result and retains optional absence before first mount, without claiming a foreign injected global is a React Root.
const proofRuntime = globalThis as typeof globalThis & {
	__ryuChatVoiceProofRoot?: Root;
};
const proofRoot =
	proofRuntime.__ryuChatVoiceProofRoot ?? createRoot(proofRootElement);
proofRuntime.__ryuChatVoiceProofRoot = proofRoot;
proofRoot.render(<ProofApp />);
