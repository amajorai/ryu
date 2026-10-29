import proofStyles from "./chat-start-page-story.module.css";
// Standalone browser story for the EMPTY chat start page carrying the app
// launchpad in its `emptyStateFooter` slot — the real `AgentChat`, mounted the way
// `ChatPage` mounts it (`emptyStatePosition="center"`, no messages).
//
// What this exists to catch: the start page is a CENTRED column, and adding a
// footer to a centred column is exactly the change that silently pushes the
// composer off-centre or clips the greeting off the top of a short pane. Neither
// is visible to a type-check — both are rendered-geometry facts — so the story
// mounts two pane heights side by side:
//
//   • `tall`  — the ordinary window. Everything fits; the column is centred.
//   • `short` — a squeezed split pane. The launchpad is the one child allowed to
//     give way (it carries `min-h-0`, its rows are `minmax(0, 1fr)`), so the
//     composer must still be fully visible and the greeting must not be cut off.
//
// The launchpad is mounted as `AppLaunchpadGrid` with canned items rather than the
// hook-driven `AppLaunchpad`, because the hooks need the app's node/provider tree.
// The slot, the centring and the shrink behaviour — the things under test — are
// identical either way.

import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import {
	AppLaunchpadGrid,
	type LaunchpadItem,
} from "../../src/components/chat/AppLaunchpad.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

const ITEMS: LaunchpadItem[] = [
	{
		id: "app__browser",
		label: "Browser",
		iconId: "lucide:globe",
		seedId: "@ryu/browser",
	},
	{
		id: "app__crm",
		label: "Harbor",
		iconId: "lucide:contact",
		seedId: "@ryu/crm",
	},
	{
		id: "app__drafts",
		label: "Drafts",
		iconId: "lucide:send",
		seedId: "@ryu/drafts",
	},
	{
		id: "app__blueprint",
		label: "Blueprint",
		iconId: "lucide:workflow",
		seedId: "@ryu/blueprint",
	},
	{
		id: "app__news",
		label: "Wire",
		iconId: "lucide:newspaper",
		seedId: "@ryu/news",
	},
	{
		id: "app__tuition",
		label: "Tuition",
		iconId: "lucide:graduation-cap",
		seedId: "@ryu/tuition",
	},
	{
		id: "app__ugc",
		label: "Campaigns",
		iconId: "lucide:megaphone",
		seedId: "@ryu/ugc",
	},
	{
		id: "app__mission",
		label: "Mission Control",
		iconId: "lucide:radar",
		seedId: "@ryu/mission-control",
	},
	{
		id: "app__warmup",
		label: "Warmup",
		iconId: "lucide:flame",
		seedId: "@ryu/warmup",
	},
	{
		id: "app__memory",
		label: "Memory",
		iconId: "lucide:brain",
		seedId: "@ryu/memory",
	},
];

/** Stand-in for the real `EmptyStateHeader` (logo + greeting + folder picker +
 *  the Agent · Model · Thinking dropdown), which cannot be mounted here — it needs
 *  the composer factory's provider tree. Only its HEIGHT matters to what this story
 *  tests, and 170px is what the real one occupies. Without it the column never
 *  overflows a short pane, which is precisely the case under test. */
declare module "react" {
	interface CSSProperties {
		"--chat-pane-height"?: string;
	}
}

function HeaderStandIn() {
	return (
		<div
			className={`${proofStyles.headerStandIn} flex flex-col items-center justify-end gap-2 pb-4`}
			data-testid="header-standin"
		>
			<div className="size-12 rounded-full bg-muted" />
			<div className="font-medium text-lg">What are we doing?</div>
			<div className="h-7 w-40 rounded-md bg-muted" />
		</div>
	);
}

function Pane({
	height,
	label,
	testId,
	withLaunchpad,
}: {
	height: number;
	label: string;
	testId: string;
	withLaunchpad: boolean;
}) {
	return (
		<section className={proofStyles.fixture1}>
			<h2 className={proofStyles.fixture2}>
				{label} — {height}px
			</h2>
			<div
				className={`${proofStyles.paneHeight} flex min-h-0 flex-col overflow-hidden rounded-lg border`}
				data-testid={testId}
				style={{ "--chat-pane-height": `${height}px` }}
			>
				<ChatDisplayPrefs>
					<AgentChat
						currentUser={{ id: "me", name: "You" }}
						emptyStateFooter={
							withLaunchpad ? (
								<AppLaunchpadGrid
									items={ITEMS}
									onOpen={() => {
										// The story never launches anything.
									}}
								/>
							) : undefined
						}
						emptyStateHeader={<HeaderStandIn />}
						emptyStatePosition="center"
						messages={[]}
						onSend={() => {
							// The story never sends; the composer is here because the real
							// surface always carries one.
						}}
						status="ready"
					/>
				</ChatDisplayPrefs>
			</div>
		</section>
	);
}

function Story() {
	return (
		<div className={proofStyles.fixture3}>
			<Pane
				height={640}
				label="Tall pane, with launchpad"
				testId="pane-tall"
				withLaunchpad
			/>
			<Pane
				height={320}
				label="Short split pane, with launchpad (composer must stay visible)"
				testId="pane-short"
				withLaunchpad
			/>
			{/* THE overflow case: header + composer + launchpad is ~420px of content
			    in a 200px pane. This is the frame the `max-h-full flex-col` column and
			    the launchpad's `min-h-0` exist for, and the one a pane that merely
			    FITS can never exercise. The composer must remain fully visible. */}
			<Pane
				height={200}
				label="Squeezed pane, content overflows (composer must stay visible)"
				testId="pane-squeezed"
				withLaunchpad
			/>
			{/* The control: the same surface with NOTHING in the footer slot, which is
			    what every other `AgentChat` consumer still renders. */}
			<Pane
				height={320}
				label="Short split pane, no launchpad (unchanged control)"
				testId="pane-control"
				withLaunchpad={false}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
