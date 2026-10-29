// Standalone browser story for the REAL onboarding `choose` fork — the first
// decision a new user makes (cloud / local / existing node), rendered straight
// from `@ryu/blocks/desktop/onboarding` with mock handlers.
//
// WHY IT NEEDS A BROWSER. The three runtime choices are tall, equal cards in a
// lobby-style row. That layout only exists once the real Tailwind utilities
// resolve, and the cards are borderless `bg-muted` tiles — a fill that is 3% off
// the page background in light theme and 12% in dark. Whether they read as cards
// at all is a fact about resolved colour in each scheme, so both themes render
// side by side.
//
// The local card is also the one that carries live install progress, so the
// progress columns pin the component milestones emitted by the public installer
// after the "Run AI locally" pick.

import { OnboardingView } from "@ryu/blocks/desktop/onboarding.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const HEADER = {
	title: "Where should Ryu do the work?",
	subtitle:
		"Want the easiest setup? Start with Ryu Cloud. You can also run Ryu here or use a server your team already has.",
};

function Column({
	dark,
	label,
	localChecking = false,
	localError,
	localUnreachable = false,
}: {
	dark: boolean;
	label: string;
	localChecking?: boolean;
	localError?: string;
	localUnreachable?: boolean;
}) {
	return (
		<div
			className={`${dark ? "dark" : ""} flex-1 bg-background text-foreground`}
			data-testid={`column-${label.toLowerCase().replace(/\s+/g, "-")}`}
		>
			<p className="p-4 font-medium text-muted-foreground text-xs uppercase tracking-widest">
				{label}
			</p>
			<OnboardingView
				isDesktop
				localChecking={localChecking}
				localError={localError ?? null}
				localUnreachable={localUnreachable}
				managedEntitled={false}
				step="choose"
				subtitle={HEADER.subtitle}
				title={HEADER.title}
			/>
		</div>
	);
}

/** The `installing` phase the local pick lands on. Its headline alternates
 *  between the flavour copy and the REAL state of the work — the two columns
 *  below are consecutive ticks of that same loop — and the bar carries the real
 *  download fraction. */
function Progress({
	dark,
	label,
	percent,
	status,
}: {
	dark: boolean;
	label: string;
	percent: number;
	status: string;
}) {
	return (
		<div
			className={`${dark ? "dark" : ""} flex-1 bg-background text-foreground`}
			data-testid={`column-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
		>
			<p className="p-4 font-medium text-muted-foreground text-xs uppercase tracking-widest">
				{label}
			</p>
			<OnboardingView
				isDesktop
				progress={percent}
				step="installing"
				title={status}
			/>
		</div>
	);
}

const storyParams = new URLSearchParams(window.location.search);
const chooseOnly = storyParams.has("choose-only");
const singleTheme = storyParams.has("single");

createRoot(document.getElementById("root")!).render(
	chooseOnly ? (
		singleTheme ? (
			<div className="flex min-h-screen">
				<Column dark label="Dark" />
			</div>
		) : (
			<div className="grid min-h-screen grid-cols-2">
				<Column dark={false} label="Light" />
				<Column dark label="Dark" />
			</div>
		)
	) : (
		<div className="flex min-h-screen">
			<Column dark={false} label="Light" />
			<Column dark label="Dark" />
			{/* Everything after the press happens on the `installing` phase — ONE
			    progress surface for the installer, Core boot, and local-stack wait.
			    These are the same component milestones the Desktop listener renders. */}
			<Progress
				dark
				label="Installer: Core"
				percent={15}
				status="Installing Ryu Core…"
			/>
			<Progress
				dark
				label="Installer: Gateway"
				percent={30}
				status="Installing the model gateway…"
			/>
			<Progress
				dark
				label="Installer: defaults"
				percent={80}
				status="Installing bundled models, engines, and skills…"
			/>
			{/* The failure state keeps the same three-card lobby layout so the error can
			    be compared with the healthy local choice. */}
			<Column
				dark
				label="Failed"
				localError="download https://github.com/amajorai/ryu/releases/latest/download/ryu-core-macos-aarch64: HTTP 404"
				localUnreachable
			/>
		</div>
	)
);
