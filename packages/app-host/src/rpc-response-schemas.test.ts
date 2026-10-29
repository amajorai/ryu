import { describe, expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import {
	activityRecordSchema,
	approvalRecordSchema,
	backgroundProcessSchema,
	type Capability,
	type ChatSendResult,
	calendarAgentRecordSchema,
	calendarJobRecordSchema,
	calendarWorkflowRecordSchema,
	chatConversationSummarySchema,
	chatSendResultSchema,
	cryptoStatusSchema,
	dispatchRpc,
	type HostServices,
	mailInboxSchema,
	mailMessageSchema,
	meetingRecordSchema,
	meetingTranscriptSchema,
	notificationRecordSchema,
	proactiveSuggestionRecordSchema,
	questRecordSchema,
	type RyuJsonValue,
	spaceDatabaseQueryResultSchema,
	timelineEventRecordSchema,
	uploadFileResultSchema,
	warmupAgentRecordSchema,
	warmupDetectionSchema,
} from "./rpc.ts";

describe("native host response contracts", () => {
	test("process decoding preserves owner fields, nullable exits and future metadata", () => {
		const process = {
			command: "sleep 1",
			cwd: "/tmp",
			elapsed_ms: 12,
			kind: "shell",
			process_id: "process",
			producer: "agent",
			running: true,
			started_at: 42,
			exit_code: null,
			exit_signal: null,
			pid: null,
			owner_metadata: { revision: 2 },
		};
		expect(backgroundProcessSchema.parse(process)).toEqual(process);
		expect(
			backgroundProcessSchema.safeParse({ ...process, running: "true" }).success
		).toBe(false);
		const { process_id: _, ...missingIdentity } = process;
		expect(backgroundProcessSchema.safeParse(missingIdentity).success).toBe(
			false
		);
	});
	test("crypto decoding preserves each custody rung and optional nullable metadata", () => {
		for (const source of ["keychain", "file", "unavailable"]) {
			const status = {
				key_beside_data: source === "file",
				source,
				key_file: null,
				keychain_service: "ryu",
				keychain_account: null,
				owner_revision: 2,
			};
			expect(cryptoStatusSchema.parse(status)).toEqual(status);
		}
		expect(
			cryptoStatusSchema.safeParse({ source: "file", key_beside_data: "true" })
				.success
		).toBe(false);
		expect(
			cryptoStatusSchema.safeParse({ key_beside_data: false }).success
		).toBe(false);
	});
});

describe("Core entity response projections", () => {
	test("validates the required identity without cloning future metadata", () => {
		const entity = { id: "entity", title: "Quest", future: { revision: 2 } };
		Object.defineProperty(entity, "__proto__", {
			value: { retained: true },
			enumerable: true,
		});
		for (const schema of [
			questRecordSchema,
			activityRecordSchema,
			mailInboxSchema,
			mailMessageSchema,
			calendarJobRecordSchema,
			calendarWorkflowRecordSchema,
			calendarAgentRecordSchema,
			warmupAgentRecordSchema,
			approvalRecordSchema,
			meetingRecordSchema,
			notificationRecordSchema,
			proactiveSuggestionRecordSchema,
		]) {
			expect(schema.parse(entity)).toBe(entity);
			expect(schema.safeParse({ ...entity, id: 42 }).success).toBe(false);
			expect(schema.safeParse({ title: "Missing identity" }).success).toBe(
				false
			);
		}
		expect(questRecordSchema.safeParse({ id: "quest" }).success).toBe(false);
		const detection = { agents: [entity], tz: "UTC", future: "preserved" };
		expect(warmupDetectionSchema.parse(detection)).toBe(detection);
		expect(
			warmupDetectionSchema.safeParse({ agents: [entity], tz: false }).success
		).toBe(false);
	});

	test("dispatch validates entity lists and retains original arrays and records", async () => {
		const quest = {
			id: "quest",
			title: "Task",
			completion_condition: "Done",
			future: { revision: 2 },
		};
		const quests = [quest];
		const inboxes = [{ id: "inbox", address: "inbox@example.test" }];
		const jobs = [{ id: "job", schedule: { kind: "every", everyMs: 60_000 } }];
		const detection = { agents: [{ id: "agent", windows: [] }], tz: "UTC" };
		const services: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: (claim: RouteClaim) =>
				Promise.resolve({ path: claim.path }),
			questsList: () => Promise.resolve(quests),
			questsCreate: () => Promise.resolve(quest),
			mailList: () => Promise.resolve(inboxes),
			calendarJobs: () => Promise.resolve(jobs),
			warmupDetect: () => Promise.resolve(detection),
		};
		const grants = new Set<Capability>([
			"quests.crud",
			"mail.crud",
			"calendar.crud",
			"warmup.crud",
		]);
		expect(await dispatchRpc("quests.list", [], grants, services)).toBe(quests);
		expect(await dispatchRpc("quests.create", [quest], grants, services)).toBe(
			quest
		);
		expect(await dispatchRpc("mail.list", [], grants, services)).toBe(inboxes);
		expect(await dispatchRpc("calendar.jobs", [], grants, services)).toBe(jobs);
		expect(await dispatchRpc("warmup.detect", [], grants, services)).toBe(
			detection
		);
	});
});

describe("host response projections", () => {
	test("chat summary and send replies retain their public fields and metadata", () => {
		const summary = {
			agent_id: null,
			created_at: 1,
			id: "chat",
			message_count: 2,
			run_status: null,
			title: null,
			updated_at: 3,
			future: { revision: 1 },
		};
		expect(chatConversationSummarySchema.parse(summary)).toBe(summary);
		expect(
			chatConversationSummarySchema.safeParse({
				...summary,
				message_count: "2",
			}).success
		).toBe(false);
		const sent = {
			conversation_id: "chat",
			status: "accepted",
			future: true,
		} satisfies ChatSendResult & { future: boolean };
		expect(chatSendResultSchema.parse(sent)).toBe(sent);
		expect(
			chatSendResultSchema.safeParse({ ...sent, status: "failed" }).success
		).toBe(false);
	});
	test("uploaded files preserve exact host URLs and bytes metadata", () => {
		const uploaded = {
			data_url: "data:text/plain;base64,YQ==",
			id: "upload",
			mime_type: "text/plain",
			name: "a.txt",
			size: 1,
			space_id: "space",
			url: "https://core.example.test/api/uploads/upload",
			future: true,
		};
		expect(uploadFileResultSchema.parse(uploaded)).toBe(uploaded);
		expect(
			uploadFileResultSchema.safeParse({ ...uploaded, size: "1" }).success
		).toBe(false);
	});
	test("database replies accept nested JSON while preserving original row identity", () => {
		let nested: RyuJsonValue = {};
		for (let depth = 0; depth < 20; depth += 1) {
			nested = { child: nested };
		}
		const reply = {
			columns: ["id", "value"],
			rows: [["row", nested, null, true, 1]],
			schema: [{ id: "id", label: "Identity", name: "id" }],
			truncated: false,
			future: { revision: 1 },
		};
		expect(spaceDatabaseQueryResultSchema.parse(reply)).toBe(reply);
		expect(
			spaceDatabaseQueryResultSchema.safeParse({
				...reply,
				rows: [[undefined]],
			}).success
		).toBe(false);
		expect(
			spaceDatabaseQueryResultSchema.safeParse({ ...reply, truncated: "false" })
				.success
		).toBe(false);
	});
});

test("meeting transcript follows the Core client segment and text owner", () => {
	const transcript = {
		segments: [
			{
				created_at: "2026-10-06T00:00:00Z",
				id: 1,
				meeting_id: "meeting",
				speaker: null,
				t_offset_ms: 0,
				text: "Hello",
				future: true,
			},
		],
		text: "Hello",
		future: true,
	};
	expect(meetingTranscriptSchema.parse(transcript)).toBe(transcript);
	expect(
		meetingTranscriptSchema.safeParse({
			...transcript,
			segments: [{ text: "Missing required segment fields" }],
		}).success
	).toBe(false);
});

test("timeline events preserve public metadata and reject private locators", () => {
	const visible = {
		app_name: null,
		event_type: "app_switch",
		track: 3,
		ts: 42,
		url: null,
		window_title: null,
		future: true,
	};
	expect(timelineEventRecordSchema.parse(visible)).toBe(visible);
	expect(
		timelineEventRecordSchema.safeParse({
			...visible,
			app_path: "/Applications/App.app",
		}).success
	).toBe(false);
	expect(
		timelineEventRecordSchema.safeParse({
			...visible,
			bundle_id: "com.example.app",
		}).success
	).toBe(false);
	expect(
		timelineEventRecordSchema.safeParse({ ...visible, track: "3" }).success
	).toBe(false);
});

test("database response JSON validates special own dictionary entries before preserving them", () => {
	const validCell = JSON.parse('{"__proto__":{"text":"valid"}}');
	const response = {
		columns: ["value"],
		rows: [[validCell]],
		schema: [],
		truncated: false,
	};
	expect(spaceDatabaseQueryResultSchema.parse(response)).toBe(response);
	expect(Object.hasOwn(response.rows[0]?.[0] ?? {}, "__proto__")).toBe(true);
	const invalidCell = Object.fromEntries([["__proto__", () => "invalid"]]);
	expect(
		spaceDatabaseQueryResultSchema.safeParse({
			...response,
			rows: [[invalidCell]],
		}).success
	).toBe(false);
});

test("spaces search preserves the native nullable distance contract", async () => {
	const matches = [
		{
			chunk_id: "nonfinite",
			content: "Native match",
			distance: null,
			document_id: "document",
			metadata: { future: true },
		},
		{
			chunk_id: "finite",
			content: "Native match",
			distance: 0.5,
			document_id: "document",
		},
	];
	const services = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		spacesSearch: async () => matches,
	} satisfies HostServices;
	const result = await dispatchRpc(
		"spaces.search",
		[{ space_id: "space", query: "Native" }],
		new Set<Capability>(["spaces.docs"]),
		services
	);
	expect(result).toBe(matches);
	expect(result).toEqual(matches);
});
