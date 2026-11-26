// Standalone browser story for the REAL onboarding `choose` fork — the first
// decision a new user makes (cloud / local / existing node), rendered straight
// from `@ryu/blocks/desktop/onboarding` with mock handlers.
//
// WHY IT NEEDS A BROWSER. The three runtime choices are equal, bordered cards
// whose grid is a container query: one row once the step's column is 42rem
// wide, stacked below that. That layout only exists once the real Tailwind
// utilities resolve, so the half-width theme columns here exercise the stacked
// form and `?choose-only&single` (one full-width column) the row. Both themes
// render side by side because the card border is a fact about resolved colour
// in each scheme.
//
// The local card is also the one that carries live install progress, so the
// progress columns pin the component milestones emitted by the public installer
// after the "Run AI locally" pick.
//
// `?language` is the step as the onboarding page shows it: one full window
// with the language control the page keeps on this phase, under the real
// language provider, so a choice re-renders the step. `&theme=dark` and
// `&surface=web` (a browser, which has no native window controls) vary it.

import { OnboardingView } from "@ryu/blocks/desktop/onboarding.tsx";
import { createRoot } from "react-dom/client";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import {
	OnboardingLanguageControl,
	onboardingPhaseKeepsLanguage,
} from "../../src/components/onboarding/OnboardingLanguageControl.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const HEADER = {
	title: "Where should Ryu do the work?",
	subtitle:
		"Ryu Cloud is the easiest. You can also run Ryu here or on your team's server.",
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

/** The `choose` phase inside the onboarding page's frame, with the language
 *  control the page keeps on it. */
function ChooseWithLanguage({ surface }: { surface: "desktop" | "web" }) {
	return (
		<AppSurfaceProvider surface={surface}>
			<LanguagePackBridge>
				<div
					className="relative h-screen bg-background text-foreground"
					data-testid="choose-with-language"
				>
					<OnboardingView
						isDesktop
						localChecking={false}
						localError={null}
						localUnreachable={false}
						managedEntitled={false}
						step="choose"
						subtitle={HEADER.subtitle}
						title={HEADER.title}
					/>
					{onboardingPhaseKeepsLanguage("choose") ? (
						<OnboardingLanguageControl />
					) : null}
				</div>
			</LanguagePackBridge>
		</AppSurfaceProvider>
	);
}

const storyParams = new URLSearchParams(window.location.search);
const chooseOnly = storyParams.has("choose-only");
const singleTheme = storyParams.has("single");
const withLanguage = storyParams.has("language");
if (withLanguage) {
	// The menu opens in a portal on the body, so the theme goes on the root.
	document.documentElement.classList.toggle(
		"dark",
		storyParams.get("theme") === "dark"
	);
	// The language provider reads installed packs from the active node. This
	// page's own origin has none, so only the built-in languages are listed.
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "choose-proof",
		nodes: [
			{
				name: "choose-proof",
				url: window.location.origin,
				token: "choose-proof-node",
			},
		],
	});
}

createRoot(document.getElementById("root")!).render(
	withLanguage ? (
		<ChooseWithLanguage
			surface={storyParams.get("surface") === "web" ? "web" : "desktop"}
		/>
	) : chooseOnly ? (
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
