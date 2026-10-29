import type { ReactNode } from "react";
import { AgentsScene } from "./product-scenes/agents.tsx";
import { CloudScene } from "./product-scenes/cloud.tsx";
import { CoreProductScene } from "./product-scenes/core.tsx";
import { DesktopProductScene } from "./product-scenes/desktop.tsx";
import { MarketplaceScene } from "./product-scenes/marketplace.tsx";
import { Scene } from "./product-scenes/scene.tsx";
import { SdkScene } from "./product-scenes/sdk.tsx";
import { SkillsScene } from "./product-scenes/skills.tsx";

/**
 * Homepage card scenes for the released products that are not product realms
 * (`ProductRealmScene` draws those). The launched products draw an animated
 * hairline diagram of what they do (`product-scenes/`); the flag-gated ones
 * keep a muted card of mono rows and one status marker taken from the
 * product's own catalogue entry in `data/catalog/`.
 */
export type CatalogSceneId =
	| "desktop"
	| "agents"
	| "workflows"
	| "skills"
	| "marketplace"
	| "sdk"
	| "core"
	| "cloud"
	| "agents-as-a-service"
	| "red-team";

/** The catalogue name each card shows, matching `products.tsx`. */
export const CATALOG_SCENE_NAMES: Record<CatalogSceneId, string> = {
	desktop: "Ryu Desktop",
	agents: "Agents",
	workflows: "Workflows",
	skills: "Skills",
	marketplace: "Marketplace",
	sdk: "Ryu SDK",
	core: "Ryu Core",
	cloud: "Ryu Cloud",
	"agents-as-a-service": "Agents as a Service",
	"red-team": "Red Teaming",
};

export const isCatalogSceneId = (id: string): id is CatalogSceneId =>
	Object.hasOwn(CATALOG_SCENE_NAMES, id);

const COMPLETE = "text-realm-complete dark:text-realm-complete-dark";
const PROGRESS = "text-realm-progress dark:text-realm-progress-dark";

/** The amber note under a scene, as on the Compute scene. */
function Marker({ children }: { children: string }) {
	return (
		<div className="type-compact mt-5 border-realm-review-marker/45 border-l-2 bg-realm-review-marker/10 px-3 py-2 font-sans">
			{children}
		</div>
	);
}

/** Status rows with a right-aligned state. */
function StatusRows({
	rows,
}: {
	rows: readonly (readonly [string, string, string])[];
}) {
	return (
		<div className="type-caption">
			{rows.map(([name, state, tone]) => (
				<div
					className="flex items-center justify-between gap-3 border-border/40 border-b py-2"
					key={name}
				>
					<span>{name}</span>
					<span className={tone}>{state}</span>
				</div>
			))}
		</div>
	);
}

function MonoScene({
	children,
	id,
}: {
	children: ReactNode;
	id: CatalogSceneId;
}) {
	return (
		<Scene id={id}>
			<div className="type-caption absolute inset-0 overflow-hidden bg-muted/65 px-5 pt-5 font-mono">
				{children}
			</div>
		</Scene>
	);
}

export function ProductCatalogScene({ id }: { id: CatalogSceneId }) {
	switch (id) {
		case "desktop":
			return <DesktopProductScene />;
		case "agents":
			return <AgentsScene />;
		case "workflows":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 overflow-hidden bg-muted/65 px-5 pt-4">
						<StatusRows
							rows={[
								["Trigger · schedule", "Started", COMPLETE],
								["Agent · research", "Completed", COMPLETE],
								["Sub-agents · fan out", "Running", PROGRESS],
								["Skill · summarize", "Waiting", "text-muted-foreground"],
							]}
						/>
						<Marker>Runs survive restarts</Marker>
					</div>
				</Scene>
			);
		case "skills":
			return <SkillsScene />;
		case "marketplace":
			return <MarketplaceScene />;
		case "sdk":
			return <SdkScene />;
		case "core":
			return <CoreProductScene />;
		case "cloud":
			return <CloudScene />;
		case "agents-as-a-service":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 overflow-hidden bg-muted/65 px-5 pt-4">
						<StatusRows
							rows={[
								["Scope the task and its tools", "Agreed", COMPLETE],
								["Set the approval points", "Agreed", COMPLETE],
								["Set up the agent on Ryu", "In progress", PROGRESS],
							]}
						/>
						<p className="type-compact mt-4 text-muted-foreground">
							Standard Ryu underneath, yours to take in-house.
						</p>
					</div>
				</Scene>
			);
		case "red-team":
			return (
				<MonoScene id={id}>
					<StatusRows
						rows={[
							["Injection and leaks", "Probed", COMPLETE],
							["Tool abuse", "Probed", COMPLETE],
							["Harmful output", "Running", PROGRESS],
						]}
					/>
					<Marker>Tune your Gateway from results</Marker>
				</MonoScene>
			);
		default:
			return null;
	}
}
