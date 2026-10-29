import {
	ExtensionHost,
	shouldEnableCompanionFormEvents,
} from "@ryu/app-host/ExtensionHost";
import {
	capabilitiesFromGrants,
	type HostServices,
	type TuitionRequestPayload,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	Item,
	MasteryReport,
	ReviewCandidate,
	Session,
	Skill,
	Source,
	Subject,
} from "../../../../apps-store/tuition/ui/src/types.ts";
import type {
	TuitionFixtures,
	TuitionProofApi,
	TuitionProofCall,
} from "./tuition-companion-proof.types.ts";
import "../../src/index.css";

const PLUGIN_ID = "@ryu/tuition";
const FIXTURE_KEY = "ryu.tuition-companion-proof.fixtures";

interface Failure {
	message: string;
	method: string;
	path: string;
}

declare global {
	interface Window {
		__tuitionProof?: TuitionProofApi;
	}
}

const BIOLOGY: Subject = {
	detail: "Cell biology and energy conversion",
	exam_date: "2026-12-18",
	id: "subject-biology",
	name: "Biology",
	timezone: "Asia/Singapore",
};

const CHEMISTRY: Subject = {
	detail: "Atoms, bonds, and reactions",
	exam_date: null,
	id: "subject-chemistry",
	name: "Chemistry",
	timezone: "Asia/Singapore",
};

const SETTINGS = {
	ready_threshold: 0.8,
	target_mastery: 0.9,
	per_skill_item_cap: 5,
	default_item_seconds: 60,
	sessions_per_day: 1,
	at_risk_overrun: 1.15,
	trajectory_window: 10,
	trajectory_min_sessions: 3,
};

const ITEMS: Item[] = [
	{
		archived: false,
		choices: [
			{ id: "choice-a", text: "The inner mitochondrial membrane" },
			{ id: "choice-b", text: "The cytosol" },
		],
		id: "item-mcq",
		kind: "mcq",
		prompt: "Where is the electron transport chain?",
		skill_id: "skill-respiration",
	},
	{
		archived: false,
		choices: [],
		id: "item-free",
		kind: "free",
		prompt: "Explain how ATP synthase uses the proton gradient.",
		skill_id: "skill-respiration",
	},
	{
		archived: false,
		choices: [],
		id: "item-cloze",
		kind: "cloze",
		prompt: "The ETC is in the | and uses a gradient of |.",
		skill_id: "skill-respiration",
	},
];

const initialSkill = (): Skill => ({
	detail: "Mitochondrial energy conversion",
	due_at: null,
	ease: 2.5,
	id: "skill-respiration",
	interval_days: 0,
	lapses: 0,
	mastery: 0.62,
	name: "Cellular respiration",
	prereqs: [],
	reps: 0,
	status: "active",
	subject_id: BIOLOGY.id,
});

const initialCandidates = (): ReviewCandidate[] => [
	{
		answer: "ATP synthase makes ATP using the proton gradient.",
		id: "candidate-gradient",
		prompt: "What does ATP synthase use to make ATP?",
		skill_label: "Cellular respiration",
		status: "pending",
		subject_id: BIOLOGY.id,
	},
	{
		answer: "The inner mitochondrial membrane.",
		id: "candidate-location",
		prompt: "Where is the electron transport chain?",
		skill_label: "Cellular respiration",
		status: "pending",
		subject_id: BIOLOGY.id,
	},
];

function makeFixtures(): TuitionFixtures {
	const skill = initialSkill();
	const mastery: MasteryReport = {
		skills: [
			{
				correct_answers_to_target: 3,
				due_at: null,
				mastery: skill.mastery,
				name: skill.name,
				skill_id: skill.id,
			},
		],
		trajectory: { needed: 3, sessions: 1, state: "unknown" },
	};
	return {
		activeSettings: structuredClone(SETTINGS),
		attempts: [],
		candidates: initialCandidates(),
		items: structuredClone(ITEMS),
		mastery,
		sessionProgress: {},
		sessions: [],
		skills: [skill],
		sources: [],
		subjects: [BIOLOGY, CHEMISTRY],
	};
}

function copy<T>(value: T): T {
	return structuredClone(value);
}

function persistFixtures(): void {
	window.sessionStorage.setItem(FIXTURE_KEY, JSON.stringify(fixtures));
}

function loadFixtures(): TuitionFixtures {
	const saved = window.sessionStorage.getItem(FIXTURE_KEY);
	// SAFETY: This controlled proof persists the authored makeFixtures state plus its mounted subject/skill/source/session/answer actions and finite 0.95/2 settings edits; the public proof API exposes cloned reads, not state injection. Foreign storage edits and nonfinite form edits are outside this fixture.
	return saved ? (JSON.parse(saved) as TuitionFixtures) : makeFixtures();
}

let fixtures = makeFixtures();
let readOnly = false;
let connected = false;
let root: Root | null = null;
const calls: TuitionProofCall[] = [];
const failures: Failure[] = [];

function failCall(call: TuitionProofCall, message: string): never {
	call.status = 503;
	throw new Error(message);
}

function recordCall(input: TuitionRequestPayload): TuitionProofCall {
	const call: TuitionProofCall = {
		...(input.body === undefined ? undefined : { body: copy(input.body) }),
		method: input.method ?? "GET",
		path: input.path,
		status: 0,
	};
	calls.push(call);
	return call;
}

function responseSettings(): Record<string, number> {
	return copy(fixtures.activeSettings);
}

function masteryFor(subjectId: string): MasteryReport {
	return {
		...copy(fixtures.mastery),
		skills: fixtures.mastery.skills.filter((skill) =>
			fixtures.skills.some(
				(entry) => entry.id === skill.skill_id && entry.subject_id === subjectId
			)
		),
	};
}

function routeTuitionRequest(input: TuitionRequestPayload) {
	const call = recordCall(input);
	const method = input.method ?? "GET";
	const path = input.path;

	const failureIndex = failures.findIndex(
		(failure) => failure.method === method && failure.path === path
	);
	if (failureIndex >= 0) {
		const [failure] = failures.splice(failureIndex, 1);
		return failCall(call, failure?.message ?? "Local Tuition fixture failed.");
	}
	if (readOnly && method !== "GET") {
		call.status = 403;
		throw new Error("Tuition edit permission is required for this action.");
	}

	try {
		let result;
		if (method === "GET" && path === "/subjects") {
			result = { subjects: copy(fixtures.subjects) };
		} else if (method === "POST" && path === "/subjects") {
			// SAFETY: The compiled mounted Tuition Subjects form supplies trimmed name, date string or null, and the native Intl timezone string to createSubject; its bridge forwards that authored object unchanged into this private POST handler.
			const body = input.body as Partial<Subject>;
			const subject: Subject = {
				detail: "Local fixture subject",
				exam_date: body.exam_date ?? null,
				id: `subject-${fixtures.subjects.length + 1}`,
				name: body.name ?? "Untitled",
				timezone: body.timezone ?? "Asia/Singapore",
			};
			fixtures.subjects.push(subject);
			result = copy(subject);
		} else if (method === "GET" && path.startsWith("/skills?subject_id=")) {
			const subjectId = new URL(
				path,
				"https://tuition.fixture"
			).searchParams.get("subject_id");
			result = {
				prereqs: [],
				skills: copy(
					fixtures.skills.filter((skill) => skill.subject_id === subjectId)
				),
			};
		} else if (method === "POST" && path === "/skills") {
			// SAFETY: The compiled mounted Tuition Skills form supplies its fixture subject string ID and trimmed name to createSkill; its bridge forwards that authored object unchanged into this private POST handler.
			const body = input.body as {
				detail?: string;
				name?: string;
				subject_id?: string;
			};
			const skill: Skill = {
				detail: body.detail ?? "",
				due_at: null,
				ease: 2.5,
				id: `skill-${fixtures.skills.length + 1}`,
				interval_days: 0,
				lapses: 0,
				mastery: 0.5,
				name: body.name ?? "Untitled skill",
				prereqs: [],
				reps: 0,
				status: "active",
				subject_id: body.subject_id ?? BIOLOGY.id,
			};
			fixtures.skills.push(skill);
			fixtures.mastery.skills.push({
				correct_answers_to_target: 4,
				due_at: null,
				mastery: skill.mastery,
				name: skill.name,
				skill_id: skill.id,
			});
			result = copy(skill);
		} else if (method === "GET" && path.startsWith("/mastery?subject_id=")) {
			const subjectId = new URL(
				path,
				"https://tuition.fixture"
			).searchParams.get("subject_id");
			result = masteryFor(subjectId ?? "");
		} else if (method === "GET" && path.startsWith("/sources?subject_id=")) {
			const subjectId = new URL(
				path,
				"https://tuition.fixture"
			).searchParams.get("subject_id");
			result = {
				sources: copy(
					fixtures.sources.filter((source) => source.subject_id === subjectId)
				),
			};
		} else if (method === "POST" && path === "/sources") {
			// SAFETY: The compiled mounted Tuition Sources form supplies its fixture subject string ID, trimmed title, and textarea string to createSource; its bridge forwards that authored object unchanged into this private POST handler.
			const body = input.body as {
				subject_id?: string;
				text?: string;
				title?: string;
			};
			const source: Source = {
				id: `source-${fixtures.sources.length + 1}`,
				kind: "text",
				subject_id: body.subject_id ?? BIOLOGY.id,
				title: body.title ?? "Untitled",
			};
			fixtures.sources.push(source);
			result = copy(source);
		} else if (method === "GET" && path.startsWith("/candidates")) {
			const subjectId = new URL(
				path,
				"https://tuition.fixture"
			).searchParams.get("subject_id");
			result = {
				candidates: copy(
					fixtures.candidates.filter(
						(candidate) =>
							candidate.status === "pending" &&
							(!subjectId || candidate.subject_id === subjectId)
					)
				),
			};
		} else if (
			method === "POST" &&
			/^\/candidates\/[^/]+\/(accept|reject)$/.test(path)
		) {
			const [, id, decision] =
				path.match(/^\/candidates\/([^/]+)\/(accept|reject)$/) ?? [];
			const candidate = fixtures.candidates.find((entry) => entry.id === id);
			if (!(candidate && decision)) {
				call.status = 404;
				throw new Error("Review candidate was not found.");
			}
			candidate.status = decision === "accept" ? "accepted" : "rejected";
			result = { status: candidate.status };
		} else if (method === "GET" && path === "/settings") {
			result = responseSettings();
		} else if (method === "PUT" && path === "/settings") {
			// SAFETY: This controlled Tuition proof starts from authored numeric SETTINGS and edits only the finite values 0.95 and 2 in its mounted Settings test; putSettings forwards that numeric object. Number conversion alone does not validate arbitrary form values.
			fixtures.activeSettings = copy(input.body as Record<string, number>);
			result = { ok: true };
		} else if (method === "POST" && path === "/sessions/plan") {
			// SAFETY: The mounted Tuition session form passes its selected fixture subject string ID and numeric minutes state to planSession, whose bridge body is exactly { subject_id, minutes } for this controlled POST.
			const body = input.body as { minutes?: number; subject_id?: string };
			const session: Session = {
				id: `session-${fixtures.sessions.length + 1}`,
				planned_minutes: body.minutes ?? 15,
				status: "active",
				subject_id: body.subject_id ?? BIOLOGY.id,
			};
			fixtures.sessions.push(session);
			fixtures.sessionProgress[session.id] = 0;
			result = { note: null, planned: [], session: copy(session) };
		} else if (method === "GET" && /^\/sessions\/[^/]+\/next$/.test(path)) {
			const [, sessionId] = path.match(/^\/sessions\/([^/]+)\/next$/) ?? [];
			const index = sessionId ? (fixtures.sessionProgress[sessionId] ?? 0) : 0;
			const item = fixtures.items[index] ?? null;
			if (item) {
				fixtures.sessionProgress[sessionId ?? ""] = index + 1;
				result = { done: false, item: copy(item), position: index + 1 };
			} else {
				result = { done: true, item: null };
			}
		} else if (method === "POST" && /^\/sessions\/[^/]+\/answer$/.test(path)) {
			const [, sessionId] = path.match(/^\/sessions\/([^/]+)\/answer$/) ?? [];
			// SAFETY: The mounted Tuition answer action passes its current fixture item string ID and response string to answer, whose bridge body is exactly { item_id, response } for this controlled POST.
			const body = input.body as { item_id?: string; response?: string };
			const item = fixtures.items.find((entry) => entry.id === body.item_id);
			if (!(sessionId && item)) {
				call.status = 404;
				throw new Error("Study session or item was not found.");
			}
			const response = body.response ?? "";
			fixtures.attempts.push({
				item_id: item.id,
				response,
				session_id: sessionId,
			});
			const resultForAnswer = gradeFixtureAnswer(item, response);
			const skill = fixtures.skills.find((entry) => entry.id === item.skill_id);
			if (skill && resultForAnswer.informative) {
				skill.mastery = resultForAnswer.mastery_after;
				skill.reps += 1;
				const reportSkill = fixtures.mastery.skills.find(
					(entry) => entry.skill_id === skill.id
				);
				if (reportSkill) {
					reportSkill.mastery = skill.mastery;
				}
			}
			result = resultForAnswer;
		} else if (method === "POST" && /^\/sessions\/[^/]+\/finish$/.test(path)) {
			const [, sessionId] = path.match(/^\/sessions\/([^/]+)\/finish$/) ?? [];
			const session = fixtures.sessions.find((entry) => entry.id === sessionId);
			if (!session) {
				call.status = 404;
				throw new Error("Study session was not found.");
			}
			session.status = "completed";
			result = { skills_rescheduled: 1 };
		} else {
			call.status = 404;
			throw new Error(`No local Tuition fixture route for ${method} ${path}.`);
		}

		call.status = method === "POST" ? 201 : 200;
		persistFixtures();
		return copy(result);
	} catch (error) {
		if (call.status === 0) {
			call.status = 500;
		}
		throw error;
	}
}

function gradeFixtureAnswer(item: Item, response: string) {
	const masteryBefore =
		fixtures.skills.find((skill) => skill.id === item.skill_id)?.mastery ?? 0.5;
	const correct =
		item.id === "item-mcq"
			? response === "choice-a"
			: item.id === "item-cloze"
				? response.toLowerCase() === "mitochondria|protons"
				: true;
	return {
		blanks:
			item.id === "item-cloze"
				? response.split("|").map((blank) => blank.trim().length > 0)
				: [],
		correct,
		feedback:
			item.kind === "free"
				? "Your explanation connected the gradient to ATP synthesis."
				: null,
		graded_by: item.kind === "free" ? "rubric" : "deterministic",
		informative: true,
		mastery_after: Math.min(0.99, masteryBefore + (correct ? 0.08 : 0.01)),
		mastery_before: masteryBefore,
		note: null,
		rubric:
			item.kind === "free"
				? "Credit the proton gradient driving rotational catalysis."
				: null,
		score: correct ? 1 : 0,
	};
}

function createServices(): HostServices {
	return {
		listAgents: async () => [],
		registerRoute: async (claim) =>
			validatePluginRoute(PLUGIN_ID, claim)
				? { path: claim.path }
				: Promise.reject(
						new Error(`Route '${claim.path}' is not Tuition's surface.`)
					),
		tuitionRequest: async (input: TuitionRequestPayload) => {
			if (readOnly && (input.method ?? "GET") !== "GET") {
				const call = recordCall(input);
				call.status = 403;
				throw new Error("Tuition edit permission is required for this action.");
			}
			return appResponseValueSchema.parse(routeTuitionRequest(input));
		},
	};
}

function mount(input: {
	appHtml: string;
	tab: string;
	grants?: string[];
	readOnly?: boolean;
}): void {
	if (!input.appHtml.includes("Tuition")) {
		throw new Error("The compiled Tuition Companion bundle was not supplied.");
	}
	fixtures = loadFixtures();
	readOnly = input.readOnly === true;
	connected = false;
	const nonce = crypto.randomUUID();
	const srcdoc = htmlCompanionSrcdoc(nonce, input.appHtml, PLUGIN_ID, {
		tab: input.tab,
	});
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Tuition proof is missing #host-root.");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(
			"main",
			{
				className:
					"mx-auto flex h-screen max-w-5xl flex-col bg-background p-6 text-foreground",
			},
			createElement(
				"header",
				{ className: "mb-5 flex items-center justify-between gap-4" },
				createElement(
					"div",
					null,
					createElement(
						"p",
						{ className: "text-primary text-xs tracking-widest" },
						"RYU · COMPILED COMPANION PROOF"
					),
					createElement(
						"h1",
						{ className: "mt-1 text-2xl font-medium" },
						"Tuition"
					)
				),
				createElement(
					"span",
					{
						className:
							"rounded-full border px-3 py-1 text-xs text-muted-foreground",
					},
					"LOCAL FIXTURES"
				)
			),
			createElement(
				"div",
				{
					className: "min-h-0 flex-1 overflow-hidden rounded-xl border bg-card",
				},
				createElement(ExtensionHost, {
					allowForms: shouldEnableCompanionFormEvents(false, true),
					granted: capabilitiesFromGrants(input.grants ?? ["tuition:crud"]),
					nonce,
					onConnected: () => {
						connected = true;
					},
					services: createServices(),
					srcdoc,
					title: "Tuition proof",
				})
			)
		)
	);
}

const api: TuitionProofApi = {
	calls: () => copy(calls),
	connected: () => connected,
	failNext: (method, path, message) => failures.push({ method, path, message }),
	mount,
	state: () =>
		copy({
			activeSettings: fixtures.activeSettings,
			attempts: fixtures.attempts,
			candidates: fixtures.candidates,
			calls,
			sessions: fixtures.sessions,
			skills: fixtures.skills,
			sources: fixtures.sources,
			subjects: fixtures.subjects,
		}),
};

window.__tuitionProof = api;
document.body.setAttribute("data-harness-ready", "1");
