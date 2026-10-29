// Live proof: the shipping Library component reads the actual ryu-skills API.
// Run an isolated registry/API on 127.0.0.1:18943; no skill fixtures are used.
import { PotionIcon } from "@hugeicons/core-free-icons";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import SidebarLibrarySection from "../../src/components/library/SidebarLibrarySection.tsx";
import type { InstalledSkill } from "../../src/lib/api/skills.ts";
import "../../src/index.css";

function BuiltinSkillsLive() {
	const [skills, setSkills] = useState<InstalledSkill[]>([]);
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		fetch("http://127.0.0.1:18943/api/skills", { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`Skills request failed: ${response.status}`);
				}
				const result: { skills: InstalledSkill[] } = await response.json();
				setSkills(result.skills);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) {
					setError(String(reason));
				}
			});
		return () => controller.abort();
	}, []);
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<h1 className="font-heading text-2xl">Skills</h1>
				<Input
					aria-label="Search skills"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search skills…"
					value={query}
				/>
				{error ? <p role="alert">{error}</p> : null}
				<SidebarLibrarySection
					icon={PotionIcon}
					items={skills.map((skill) => ({
						id: skill.id,
						name: skill.name,
						icon: PotionIcon,
						subtitle: skill.description,
						onOpen: () =>
							window.open(
								`http://127.0.0.1:18943/api/skills/${skill.id}/source`,
								"_blank",
								"noopener"
							),
					}))}
					label="Skills"
					query={query}
					view="list"
				/>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<BuiltinSkillsLive />);
}
