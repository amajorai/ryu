import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	VersionHistory,
	type VersionMeta,
} from "../../src/components/versioning/VersionHistory.tsx";
import "../../src/index.css";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const INITIAL_CURRENT = `# Launch plan

## Rollout
- General availability
- 1,000 seats

Owner: Mina

Ship the onboarding guide with the announcement.`;

const INITIAL_VERSIONS: VersionMeta[] = [
	{
		captureType: "named",
		createdAt: Date.now() - HOUR_MS,
		createdBy: "Mina Chen",
		granularity: "exact",
		id: "named-review",
		label: "Editorial review",
		revision: 12,
		title: "Launch plan",
	},
	{
		captureType: "automatic",
		createdAt: Date.now() - 3 * HOUR_MS,
		createdBy: "Mina Chen",
		granularity: "ten_minute",
		id: "automatic-latest",
		revision: 11,
		title: "Launch plan",
	},
	{
		captureType: "automatic",
		createdAt: Date.now() - 2 * DAY_MS,
		createdBy: "Alex Rivera",
		granularity: "hour",
		id: "automatic-hourly",
		revision: 8,
		title: "Launch plan",
	},
	{
		captureType: "baseline",
		createdAt: Date.now() - 9 * DAY_MS,
		createdBy: "Mina Chen",
		granularity: "exact",
		id: "baseline",
		revision: 0,
		title: "Launch plan",
	},
];

const INITIAL_SOURCES = new Map<string, string>(
	Object.entries({
		"named-review": `# Launch plan

## Rollout
- Beta release
- 500 seats

Owner: Mina`,
		"automatic-latest": `# Launch plan

## Rollout
- General availability
- 750 seats

Owner: Mina`,
		"automatic-hourly": `# Launch plan

## Rollout
- Private beta
- 200 seats`,
		baseline: "# Launch plan\n\nFirst outline.",
	})
);

function Story() {
	const [current, setCurrent] = useState(INITIAL_CURRENT);
	const [status, setStatus] = useState("All changes saved");
	const [versions, setVersions] = useState(INITIAL_VERSIONS);
	const [sources, setSources] = useState(INITIAL_SOURCES);

	const source = useMemo(
		() => ({
			getValue: async (versionId: string) => sources.get(versionId) ?? "",
			list: async () => versions,
			restore: async (versionId: string) => {
				const restored = sources.get(versionId) ?? current;
				const guardId = `guard-${Date.now()}`;
				const now = Date.now();
				setSources((existing) => new Map(existing).set(guardId, current));
				setVersions((existing) => [
					{
						captureType: "restore_guard",
						createdAt: now,
						createdBy: "Mina Chen",
						granularity: "exact",
						id: guardId,
						label: "Before restore",
						revision: 14,
						title: "Launch plan",
					},
					...existing,
				]);
				setCurrent(restored);
				setStatus("Restored Editorial review · undo point saved");
			},
			snapshot: async (label?: string) => {
				const id = `named-${Date.now()}`;
				const now = Date.now();
				setSources((existing) => new Map(existing).set(id, current));
				setVersions((existing) => [
					{
						captureType: "named",
						createdAt: now,
						createdBy: "Mina Chen",
						granularity: "exact",
						id,
						label: label ?? "Saved version",
						revision: 13,
						title: "Launch plan",
					},
					...existing,
				]);
				setStatus(`Named version “${label}”`);
			},
		}),
		[current, sources, versions]
	);

	return (
		<main className="min-h-screen bg-background text-foreground">
			<header className="flex h-14 items-center justify-between border-b px-8">
				<div className="text-muted-foreground text-xs">
					Spaces / Product launch
				</div>
				<div className="flex items-center gap-3">
					<output
						className="text-muted-foreground text-xs"
						data-testid="status"
					>
						{status}
					</output>
					<VersionHistory currentValue={current} source={source} />
				</div>
			</header>
			<article className="mx-auto max-w-3xl px-12 py-16">
				<p className="mb-3 text-4xl">🚀</p>
				<h1 className="font-semibold text-4xl tracking-tight">Launch plan</h1>
				<p className="mt-3 text-muted-foreground">
					The source page stays visible behind the history panel for context.
				</p>
				<div className="mt-10 whitespace-pre-line rounded-xl border bg-card p-7 leading-7 shadow-sm">
					{current}
				</div>
			</article>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
