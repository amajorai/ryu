import { z } from "zod";
import type {
	AdminComment,
	AdminRequest,
	AutomationRun,
	BoardRecord,
	TriageSuggestion,
	WorkspaceRecord,
} from "../../../apps-store/feedback-board/ui/src/admin/api.ts";
import type {} from "../../../apps-store/feedback-board/ui/src/ryu.d.ts";
import type {
	PublicComment,
	PublicRelease,
	PublicStatus,
} from "../../../apps-store/feedback-board/ui/src/shared/types.ts";
import { type ProofJsonRecord, parseProofJsonRecord } from "./fixture-json.ts";

export const PublicStatusSchema = z
	.object({
		code: z.string(),
		label: z.string(),
		terminal: z.boolean(),
		tone: z.string(),
	})
	.catchall(z.json()) satisfies z.ZodType<PublicStatus>;
export const PublicCommentSchema = z
	.object({
		author_name: z.string(),
		body: z.string(),
		created_at: z.number(),
		id: z.string(),
	})
	.catchall(z.json()) satisfies z.ZodType<PublicComment>;
export const PublicReleaseSchema = z
	.object({
		body: z.string(),
		created_at: z.number(),
		id: z.string(),
		published_at: z.number().nullable(),
		request_ids: z.array(z.string()),
		status: z.string(),
		title: z.string(),
		updated_at: z.number(),
		workspace_id: z.string(),
	})
	.catchall(z.json()) satisfies z.ZodType<PublicRelease>;
export const WorkspaceRecordSchema = z
	.object({
		allow_guest_posts: z.boolean(),
		default_agent_id: z.string().nullable(),
		default_automation_mode: z.enum([
			"manual",
			"assist",
			"prepare",
			"build_review",
			"autopilot",
		]),
		default_workflow_id: z.string().nullable(),
		description: z.string(),
		id: z.string(),
		moderate_public_writes: z.boolean(),
		name: z.string(),
		primary_color: z.string(),
		revision: z.number(),
		slug: z.string(),
		updated_at: z.number(),
	})
	.catchall(z.json()) satisfies z.ZodType<WorkspaceRecord>;
export const BoardRecordSchema = z
	.object({
		allow_guest_posts: z.boolean(),
		automation_mode: z
			.enum(["manual", "assist", "prepare", "build_review", "autopilot"])
			.nullable(),
		description: z.string(),
		id: z.string(),
		moderate_public_writes: z.boolean(),
		name: z.string(),
		revision: z.number(),
		slug: z.string(),
		updated_at: z.number(),
		workspace_id: z.string(),
	})
	.catchall(z.json()) satisfies z.ZodType<BoardRecord>;
export const AdminRequestSchema = z
	.object({
		ai_summary: z.string().nullable(),
		author_email: z.string().nullable(),
		author_name: z.string(),
		automation_mode: z
			.enum(["manual", "assist", "prepare", "build_review", "autopilot"])
			.nullable(),
		board_id: z.string(),
		body: z.string(),
		category: z.string(),
		comment_count: z.number(),
		created_at: z.number(),
		duplicate_confidence: z.number().nullable(),
		duplicate_of: z.string().nullable(),
		id: z.string(),
		impact_score: z.number().nullable(),
		internal_notes: z.string(),
		moderation_state: z.string(),
		plan_id: z.string().nullable(),
		priority: z.number(),
		public_visible: z.boolean(),
		revision: z.number(),
		shipped_at: z.number().nullable(),
		space_doc_id: z.string().nullable(),
		status: z.string(),
		tags: z.array(z.string()),
		title: z.string(),
		updated_at: z.number(),
		vote_count: z.number(),
		workflow_run_id: z.string().nullable(),
	})
	.catchall(z.json()) satisfies z.ZodType<AdminRequest>;
export const AdminCommentSchema = z
	.object({
		author_name: z.string(),
		body: z.string(),
		created_at: z.number(),
		id: z.string(),
		moderation_state: z.string(),
		request_id: z.string(),
		visibility: z.string(),
	})
	.catchall(z.json()) satisfies z.ZodType<AdminComment>;
export const AutomationRunSchema = z
	.object({
		agent_id: z.string().nullable(),
		created_at: z.number(),
		error: z.string().nullable(),
		id: z.string(),
		mode: z.enum(["manual", "assist", "prepare", "build_review", "autopilot"]),
		plan_id: z.string().nullable(),
		request_id: z.string(),
		result_summary: z.string().nullable(),
		status: z.string(),
		updated_at: z.number(),
		workflow_id: z.string().nullable(),
		workflow_run_id: z.string().nullable(),
	})
	.catchall(z.json()) satisfies z.ZodType<AutomationRun>;
export const TriageSuggestionSchema = z
	.object({
		category: z.string(),
		confidence: z.number(),
		duplicate_request_ids: z.array(z.string()),
		impact_score: z.number(),
		summary: z.string(),
		tags: z.array(z.string()),
	})
	.catchall(z.json()) satisfies z.ZodType<TriageSuggestion>;
export const FixtureBoardSchema = BoardRecordSchema.extend({
	statuses: z.array(PublicStatusSchema),
});
export type FixtureBoard = z.infer<typeof FixtureBoardSchema>;
export type FixtureWorkspace = z.infer<typeof WorkspaceRecordSchema>;
export type FixtureRequest = z.infer<typeof AdminRequestSchema>;
export type FixtureComment = z.infer<typeof AdminCommentSchema>;
export type FixtureRelease = z.infer<typeof PublicReleaseSchema>;
export type FixtureAutomationRun = z.infer<typeof AutomationRunSchema>;
export const WorkspacePatchSchema = WorkspaceRecordSchema.partial();
export const BoardPatchSchema = FixtureBoardSchema.partial();
export const RequestPatchSchema = AdminRequestSchema.partial();
export const CommentReviewSchema = z
	.object({ approved: z.boolean(), revision: z.number() })
	.catchall(z.json());
export const TriageBodySchema = z
	.object({ suggestion: TriageSuggestionSchema })
	.catchall(z.json());
export const BriefBodySchema = z
	.object({ space_doc_id: z.string() })
	.catchall(z.json());
export const MergeBodySchema = z
	.object({ duplicate_request_id: z.string() })
	.catchall(z.json());
export const AutomationBodySchema = AutomationRunSchema.pick({
	agent_id: true,
	mode: true,
	plan_id: true,
	status: true,
	workflow_id: true,
	workflow_run_id: true,
})
	.partial()
	.extend({ mode: AutomationRunSchema.shape.mode });
export const ReleaseDraftSchema = PublicReleaseSchema.pick({
	title: true,
	body: true,
	request_ids: true,
});
export const ReleasePublishSchema = z
	.object({ body: z.string().optional() })
	.catchall(z.json());
export const PublicCommentBodySchema = z
	.object({ author_name: z.string().optional(), body: z.string().optional() })
	.catchall(z.json());
export const PublicRequestBodySchema = z
	.object({
		title: z.string().optional(),
		body: z.string().optional(),
		category: z.string().optional(),
		author_name: z.string().optional(),
		email: z.string().optional(),
	})
	.catchall(z.json());
export const ResetBodySchema = z
	.object({ emptyBoard: z.boolean().optional() })
	.catchall(z.json());
export const FailureBodySchema = z
	.object({
		method: z.string(),
		path: z.string(),
		status: z.number().optional(),
	})
	.catchall(z.json());
const JsonRecordSchema = z.record(z.string(), z.json());
const FixtureSnapshotSchema = z
	.object({
		board: FixtureBoardSchema,
		calls: z.array(
			z
				.object({
					body: z.json().optional(),
					method: z.string(),
					path: z.string(),
					surface: z.string(),
				})
				.catchall(z.json())
		),
		comments: z.array(z.tuple([z.string(), z.array(AdminCommentSchema)])),
		docs: z.array(
			z.tuple([
				z.string(),
				z.object({ source: z.string(), title: z.string() }).catchall(z.json()),
			])
		),
		releases: z.array(PublicReleaseSchema),
		requests: z.array(AdminRequestSchema),
		votes: z.array(z.tuple([z.string(), z.array(z.string())])),
		workflowDefinitions: z.array(z.tuple([z.string(), JsonRecordSchema])),
		workflowInputs: z.array(JsonRecordSchema),
		workspace: WorkspaceRecordSchema,
	})
	.catchall(z.json());
export type FeedbackFixtureSnapshot = z.infer<typeof FixtureSnapshotSchema>;
export function parseFeedbackFixtureSnapshot(
	raw: string
): FeedbackFixtureSnapshot {
	const input = parseProofJsonRecord(raw);
	FixtureSnapshotSchema.parse(input);
	// SAFETY: the schemas checked all owner fields, captured calls, and tuple collections; keep the checked original so opaque request own keys remain unchanged.
	return input as FeedbackFixtureSnapshot;
}
export function parseFeedbackFixtureBody(raw: string): ProofJsonRecord {
	return parseProofJsonRecord(raw);
}
