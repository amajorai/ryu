import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FirstProjectStep } from "@/src/components/onboarding/FirstProjectStep.tsx";
import { fetchProjects, type ProjectRecord } from "@/src/lib/api/hierarchy.ts";
import { markFirstProjectSkipped } from "@/src/lib/first-project.ts";
import {
	ONBOARDING_CHAT_ROUTE_STATE,
	onboardingInitialTab,
	withOnboardingProject,
} from "@/src/lib/onboarding-navigation.ts";
import "../../src/index.css";

const query = new URLSearchParams(window.location.search);
const target = {
	url: query.get("target") ?? window.location.origin,
	token: "first-project-node-token",
	userJwt: null,
};
function Proof() {
	const [created, setCreated] = useState<ProjectRecord | null>(null);
	const [skipped, setSkipped] = useState(false);
	const [projects, setProjects] = useState<ProjectRecord[]>([]);
	const [error, setError] = useState<string | null>(null);
	const readback = query.get("view") === "readback";
	useEffect(() => {
		if (readback) {
			void fetchProjects(target)
				.then(setProjects)
				.catch((cause) => setError(String(cause)));
		}
	}, [readback]);
	const initialTab = created
		? onboardingInitialTab(
				withOnboardingProject(
					ONBOARDING_CHAT_ROUTE_STATE,
					created.coordinatorConversationId
						? {
								mainThreadId: created.coordinatorConversationId,
								name: created.name,
							}
						: null
				)
			)
		: null;
	return (
		<main className="h-screen w-screen bg-background text-foreground">
			{readback ? (
				<section className="p-8">
					<h1>Saved projects</h1>
					{error ? (
						<p role="alert">{error}</p>
					) : (
						projects.map((project) => (
							<article key={project.id}>
								<h2>{project.name}</h2>
								<p>{project.description}</p>
								<pre data-testid="saved-project">{JSON.stringify(project)}</pre>
							</article>
						))
					)}
				</section>
			) : created ? (
				<section className="p-8">
					<h1>{created.name}</h1>
					<p>Project acknowledged by the selected node</p>
					<pre data-testid="acknowledged-project">
						{JSON.stringify(created)}
					</pre>
					<pre data-testid="initial-project-tab">
						{JSON.stringify(initialTab)}
					</pre>
				</section>
			) : skipped ? (
				<section className="p-8">
					<h1>Project skipped for now</h1>
				</section>
			) : (
				<FirstProjectStep
					coordinatorAgentId="coordinator-reviewed"
					onCreated={setCreated}
					onSkip={() => {
						markFirstProjectSkipped();
						setSkipped(true);
					}}
					target={target}
				/>
			)}
		</main>
	);
}
const root = document.getElementById("root");
if (!root) {
	throw new Error("First project proof root missing");
}
createRoot(root).render(<Proof />);
