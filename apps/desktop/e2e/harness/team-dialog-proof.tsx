import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

declare const window: Window;

import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type TeamAgentOption,
	TeamDialog,
	type TeamDraft,
} from "../../src/components/teams/TeamDialog.tsx";
import {
	createTeam,
	fetchTeams,
	type Team,
	updateTeam,
} from "../../src/lib/api/teams.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

interface TeamWire {
	coordination: string;
	created_at: string;
	description: string | null;
	id: string;
	lead_agent_id: string | null;
	members: string[];
	name: string;
	updated_at: string;
}

interface CapturedRequest {
	authorization: string | null;
	body?: unknown;
	method: string;
	path: string;
	status: number | null;
}

interface FixtureSnapshot {
	nextId: number;
	requests: CapturedRequest[];
	teams: TeamWire[];
}

interface TeamDialogProofState {
	failNextWrite: (path: string) => void;
	holdNextWrite: (path: string) => void;
	releaseHeldWrite: (failed: boolean) => void;
	snapshot: () => FixtureSnapshot;
}

declare global {
	interface Window {
		__teamDialogProof: TeamDialogProofState;
	}
}

const teamInputSchema = z.object({
	coordination: z.string(),
	description: z.string().nullable(),
	lead_agent_id: z.string().nullable(),
	members: z.array(z.string()),
	name: z.string(),
});
const teamWireSchema = teamInputSchema.extend({
	created_at: z.string(),
	updated_at: z.string(),
	id: z.string(),
});
const snapshotSchema = z.object({
	nextId: z.number(),
	teams: z.array(teamWireSchema),
	requests: z.array(
		z.object({
			authorization: z.string().nullable(),
			body: z.json().optional(),
			method: z.string(),
			path: z.string(),
			status: z.number().nullable(),
		})
	),
});

const STORAGE_KEY = "ryu-team-dialog-proof-fixture";
const TARGET = { token: "team-dialog-proof-token", url: "http://proof.local" };
const AGENTS: TeamAgentOption[] = [
	{ builtIn: true, engine: "acp:claude", id: "planner", name: "Planner" },
	{ builtIn: true, engine: "acp:codex", id: "critic", name: "Critic" },
	{ builtIn: true, engine: "acp:gemini", id: "runner", name: "Runner" },
];
const INITIAL_TEAM: TeamWire = {
	coordination: "debate-synthesis",
	created_at: "2026-01-02T03:04:05.000Z",
	description: "Original purpose",
	id: "team-existing",
	lead_agent_id: "critic",
	members: ["planner", "critic"],
	name: "Existing group",
	updated_at: "2026-01-02T03:04:05.000Z",
};

function readSnapshot(): FixtureSnapshot {
	const raw = localStorage.getItem(STORAGE_KEY);
	return raw
		? snapshotSchema.parse(JSON.parse(raw))
		: { nextId: 1, requests: [], teams: [] };
}

function saveSnapshot(snapshot: FixtureSnapshot): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function parseBody(body: BodyInit | null | undefined) {
	if (!isNativeText(body)) {
		return null;
	}
	try {
		return parseProofJson(body);
	} catch {
		return null;
	}
}

const failurePaths = new Map<string, number>();
let heldWritePath: string | null = null;
let resolveHeldWrite: ((failed: boolean) => void) | null = null;

function initializeFixture(): void {
	if (localStorage.getItem(STORAGE_KEY)) {
		return;
	}
	const editing = new URLSearchParams(window.location.search).has("edit");
	saveSnapshot({
		nextId: 1,
		requests: [],
		teams: editing ? [INITIAL_TEAM] : [],
	});
}

initializeFixture();
window.__teamDialogProof = {
	failNextWrite: (path) => {
		failurePaths.set(path, (failurePaths.get(path) ?? 0) + 1);
	},
	holdNextWrite: (path) => {
		heldWritePath = path;
	},
	releaseHeldWrite: (failed) => {
		if (!resolveHeldWrite) {
			throw new Error("no team write is being held");
		}
		const resolve = resolveHeldWrite;
		resolveHeldWrite = null;
		resolve(failed);
	},
	snapshot: () => structuredClone(readSnapshot()),
};

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const request = input instanceof Request ? input : null;
	const url = new URL(request?.url ?? String(input), window.location.href);
	if (!url.pathname.startsWith("/api/teams")) {
		return nativeFetch(input, init);
	}

	const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
	const headers = new Headers(init?.headers ?? request?.headers);
	const body = parseBody(
		init?.body ?? (request ? await request.clone().text() : null)
	);
	const snapshot = readSnapshot();
	const captured: CapturedRequest = {
		authorization: headers.get("authorization"),
		body,
		method,
		path: url.pathname,
		status: null,
	};
	snapshot.requests.push(captured);
	saveSnapshot(snapshot);

	if (method !== "GET" && heldWritePath === url.pathname) {
		heldWritePath = null;
		const failed = await new Promise<boolean>((resolve) => {
			resolveHeldWrite = resolve;
		});
		if (failed) {
			captured.status = 503;
			saveSnapshot(snapshot);
			return jsonResponse(
				{ message: "Team fixture temporarily unavailable." },
				503
			);
		}
	}
	if (method !== "GET" && (failurePaths.get(url.pathname) ?? 0) > 0) {
		failurePaths.set(url.pathname, (failurePaths.get(url.pathname) ?? 1) - 1);
		captured.status = 503;
		saveSnapshot(snapshot);
		return jsonResponse(
			{ message: "Team fixture temporarily unavailable." },
			503
		);
	}

	if (method === "GET" && url.pathname === "/api/teams") {
		captured.status = 200;
		saveSnapshot(snapshot);
		return jsonResponse({ teams: snapshot.teams });
	}
	if (method === "POST" && url.pathname === "/api/teams") {
		const input = teamInputSchema.parse(body);
		const team: TeamWire = {
			coordination: input.coordination,
			created_at: "2026-04-05T06:07:08.000Z",
			description: input.description,
			id: `team-created-${snapshot.nextId}`,
			lead_agent_id: input.lead_agent_id,
			members: [...input.members],
			name: input.name,
			updated_at: "2026-04-05T06:07:08.000Z",
		};
		snapshot.nextId += 1;
		snapshot.teams = [...snapshot.teams, team];
		saveSnapshot(snapshot);
		captured.status = 201;
		saveSnapshot(snapshot);
		return jsonResponse({ team });
	}
	const teamId = decodeURIComponent(url.pathname.slice("/api/teams/".length));
	if (method === "PATCH" && teamId) {
		const index = snapshot.teams.findIndex((team) => team.id === teamId);
		if (index < 0) {
			captured.status = 404;
			saveSnapshot(snapshot);
			return jsonResponse({ message: "Unknown team fixture." }, 404);
		}
		const patch = teamInputSchema.partial().parse(body);
		const current = snapshot.teams[index];
		const updated: TeamWire = {
			...current,
			...(isNativeText(patch.name) ? { name: patch.name } : undefined),
			...(isNativeText(patch.description) || patch.description === null
				? { description: patch.description }
				: undefined),
			...(Array.isArray(patch.members)
				? { members: [...patch.members] }
				: undefined),
			...(isNativeText(patch.coordination)
				? { coordination: patch.coordination }
				: undefined),
			...(isNativeText(patch.lead_agent_id) || patch.lead_agent_id === null
				? { lead_agent_id: patch.lead_agent_id }
				: undefined),
			updated_at: "2026-04-05T06:07:08.000Z",
		};
		snapshot.teams[index] = updated;
		saveSnapshot(snapshot);
		captured.status = 200;
		saveSnapshot(snapshot);
		return jsonResponse({ team: updated });
	}
	return jsonResponse(
		{ message: `No local teams fixture for ${method} ${url.pathname}.` },
		404
	);
};

function ProofArtifact() {
	const editing = new URLSearchParams(window.location.search).has("edit");
	const [open, setOpen] = useState(false);
	const [editingTeam, setEditingTeam] = useState<Team | null>(null);
	const [teams, setTeams] = useState<Team[]>([]);
	useEffect(() => {
		fetchTeams(TARGET)
			.then((loaded) => {
				setTeams(loaded);
				if (editing) {
					setEditingTeam(loaded[0] ?? null);
				}
			})
			.catch(() => undefined);
	}, [editing]);

	const submit = async (draft: TeamDraft): Promise<void> => {
		if (editingTeam) {
			await updateTeam(TARGET, editingTeam.id, draft);
		} else {
			await createTeam(TARGET, draft);
		}
		const readback = await fetchTeams(TARGET);
		setTeams(readback);
		if (editingTeam) {
			setEditingTeam(
				readback.find((team) => team.id === editingTeam.id) ?? null
			);
		}
	};

	return (
		<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
			<div className="mx-auto max-w-4xl">
				<header className="mb-6 flex items-start justify-between gap-4">
					<div>
						<p className="text-primary text-xs tracking-(--tracking-section-label)">
							RYU · LOCAL GROUP SETTINGS PROOF
						</p>
						<h1 className="mt-2 font-semibold text-3xl">Agent groups</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Production TeamDialog with local Core team endpoints and persisted
							fixture readback.
						</p>
					</div>
					<Button onClick={() => setOpen(true)} type="button">
						Open group dialog
					</Button>
				</header>
				<section
					aria-label="Saved groups"
					className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"
				>
					<h2 className="font-semibold text-lg">Saved groups</h2>
					{teams.length === 0 ? (
						<p className="mt-2 text-muted-foreground text-sm">
							No saved groups.
						</p>
					) : (
						<ul className="mt-3 flex flex-col gap-3">
							{teams.map((team) => (
								<li
									className="rounded-lg border border-white/10 p-3"
									data-testid={`team-record-${team.id}`}
									key={team.id}
								>
									<p className="font-medium" data-testid="team-name">
										{team.name}
									</p>
									<p className="mt-1 text-muted-foreground text-sm">
										{team.description ?? "No description"}
									</p>
									<p className="mt-1 text-xs">
										{team.coordination} · {team.members.join(" → ")} · lead{" "}
										{team.leadAgentId ?? "none"}
									</p>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
			<TeamDialog
				agents={AGENTS}
				onClose={() => setOpen(false)}
				onSubmit={submit}
				open={open}
				team={editingTeam}
			/>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("TeamDialog proof root is missing");
}
createRoot(root).render(<ProofArtifact />);
document.body.dataset.harnessReady = "1";
