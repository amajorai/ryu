import type { ReactNode } from "react";
import { Scene } from "./product-realm-scenes.tsx";

/**
 * Homepage card scenes for the released products that are not product realms
 * (`ProductRealmScene` draws those). They follow the realm scenes: a muted
 * card, small type, monochrome rows, and one status marker. Every line is
 * taken from the product's own catalogue entry in `data/catalog/`.
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

/** Initial-badge rows, the layout of the Connect and Mail scenes. */
function BadgeRows({ rows }: { rows: readonly (readonly [string, string])[] }) {
	return (
		<div className="divide-y divide-border/45 px-4 pt-3">
			{rows.map(([name, detail]) => (
				<div className="flex items-center gap-3 py-2.5" key={name}>
					<span className="type-compact flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted font-medium">
						{name[0]}
					</span>
					<div className="min-w-0 flex-1">
						<p className="type-caption font-medium">{name}</p>
						<p className="type-compact truncate text-muted-foreground">
							{detail}
						</p>
					</div>
				</div>
			))}
		</div>
	);
}

/** Label and value pairs in mono type, the layout of the Compute scene. */
function FieldGrid({
	fields,
}: {
	fields: readonly (readonly [string, string])[];
}) {
	return (
		<div className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-3">
			{fields.map(([label, value]) => (
				<div className="contents" key={label}>
					<span className="text-muted-foreground">{label}</span>
					<span>{value}</span>
				</div>
			))}
		</div>
	);
}

/** The amber note under a scene, as on the Gateway and Compute scenes. */
function Marker({ children }: { children: string }) {
	return (
		<div className="type-compact mt-5 border-realm-review-marker/45 border-l-2 bg-realm-review-marker/10 px-3 py-2 font-sans">
			{children}
		</div>
	);
}

/** Status rows with a right-aligned state, as on the Agent scene. */
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
			return (
				<Scene id={id}>
					<BadgeRows
						rows={[
							["Your models, your keys", "Local models, your keys, or a plan"],
							["Bring your history", "Claude Code and Codex threads"],
							["Apps and sandbox", "Agent actions run in a sandbox"],
						]}
					/>
				</Scene>
			);
		case "agents":
			return (
				<MonoScene id={id}>
					<FieldGrid
						fields={[
							["chat", "One model per job"],
							["voice", "Its own model"],
							["image", "Its own model"],
							["prompt", "Earlier versions kept"],
						]}
					/>
					<Marker>Share as an App and install it anywhere</Marker>
				</MonoScene>
			);
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
			return (
				<MonoScene id={id}>
					<div className="type-compact flex items-center justify-between text-muted-foreground">
						<span>skills.sh</span>
						<span>SKILL.md</span>
					</div>
					<div className="mt-5 space-y-2">
						<p>→ installed to the shared skills folder</p>
						<p>→ ready instantly, no restart</p>
						<p>→ full instructions load on demand</p>
					</div>
					<p className="type-compact mt-5 font-sans text-muted-foreground">
						Track every source and update it when it changes.
					</p>
				</MonoScene>
			);
		case "marketplace":
			return (
				<Scene id={id}>
					<div className="absolute inset-0 grid grid-cols-2 gap-2 overflow-hidden p-3">
						{["Apps", "Skills", "Models", "Themes"].map((kind) => (
							<div className="rounded-lg bg-background/90 p-3" key={kind}>
								<p className="type-caption font-medium">{kind}</p>
								<div className="mt-3 h-1 w-3/4 bg-foreground/20" />
								<div className="mt-2 h-1 w-1/2 bg-foreground/10" />
							</div>
						))}
					</div>
				</Scene>
			);
		case "sdk":
			return (
				<MonoScene id={id}>
					<p className="text-muted-foreground">$ create-ryu-app</p>
					<div className="mt-4 bg-foreground/4 p-3 leading-5">
						<p>→ project matches the App manifest</p>
						<p>→ models routed through the Gateway</p>
						<p>→ MCP server and client included</p>
					</div>
					<p className="type-compact mt-4 font-sans text-muted-foreground">
						Agents, workflows, tools, and skills in TypeScript.
					</p>
				</MonoScene>
			);
		case "core":
			return (
				<MonoScene id={id}>
					<div className="type-compact flex items-center justify-between text-muted-foreground">
						<span>ryu core</span>
						<span>headless · Docker</span>
					</div>
					<div className="mt-4">
						<StatusRows
							rows={[
								["Claude Code", "Ready", COMPLETE],
								["Codex", "Ready", COMPLETE],
								["Gemini CLI", "Ready", COMPLETE],
								["OpenAI-compatible", "Ready", COMPLETE],
							]}
						/>
					</div>
				</MonoScene>
			);
		case "cloud":
			return (
				<MonoScene id={id}>
					<FieldGrid
						fields={[
							["node", "Managed node"],
							["region", "EU or Singapore"],
							["calls", "Through the Gateway"],
							["runtime", "Open-source Ryu Core"],
						]}
					/>
					<Marker>Runs while your devices sleep</Marker>
				</MonoScene>
			);
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
