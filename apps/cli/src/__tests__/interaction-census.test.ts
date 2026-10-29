import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

// These tests consume the control records and summary counts; all other
// generated census metadata retains its native JSON values and references.
const controlFields = z.looseObject({
	id: z.string(),
	source: z.string().optional(),
	source_anchor: z.string().optional(),
	status: z.enum(["covered", "partial", "uncovered"]),
	tests: z.array(z.string()).optional(),
});
const countField = z.number().refine(Number.isInteger).nonnegative();
const censusFields = z.looseObject({
	controls: z.array(controlFields),
	summary: z.looseObject({
		covered: countField,
		partial: countField,
		total_control_records: countField,
		uncovered: countField,
	}),
});
const censusSchema = z.custom<z.output<typeof censusFields>>(
	(value) =>
		appJsonValueSchema.safeParse(value).success &&
		censusFields.safeParse(value).success
);

const cliRoot = resolve(import.meta.dir, "../..");
const census = censusSchema.parse(
	JSON.parse(readFileSync(resolve(cliRoot, "interaction-census.json"), "utf8"))
);

const PRIVACY_CONTROL_IDS = [
	"settings.privacy.analytics",
	"settings.privacy.community_stats",
	"settings.privacy.crash_reports",
	"settings.privacy.diagnostics_export",
	"settings.privacy.otlp_endpoint",
	"settings.privacy.support_duration",
	"settings.privacy.support_access",
	"settings.privacy.row_navigation",
	"settings.privacy.panel_navigation",
	"settings.privacy.retry",
];

const UPDATE_CONTROL_IDS = ["settings.updates_auto_update"];

const CLI_PARITY_CONTROL_IDS = [
	"chat.slash_argument_choices",
	"chat.acp_advertised_commands",
];

const MEMORY_CONTROL_IDS = [
	"settings.memory.auto_recall",
	"settings.memory.snippets_per_reply",
	"settings.memory.context_budget",
	"settings.memory.reply_reserve",
	"settings.memory.auto_compact",
	"settings.memory.skill_disclosure",
	"settings.memory.search_ranking",
	"settings.memory.retry",
	"settings.memory.panel_navigation",
];

const MEMORY_BOUNDARY_IDS = [
	"settings.memory.cross_session_consent_boundary",
	"settings.memory.sensitive_topic_consent_boundary",
	"settings.memory.library_boundary",
	"settings.memory.summarizer_model_boundary",
];

const GATEWAY_SAFETY_CONTROL_IDS = [
	"gateway.guardrails.status_readonly",
	"gateway.guardrails.retry",
];

const SAFETY_BOUNDARY_IDS = ["settings.safety.policy_edit_boundary"];

const INFERENCE_CONTROL_IDS = [
	"settings.inference_engine",
	"settings.inference_engine_launch_defaults",
];

const INFERENCE_BOUNDARY_IDS = ["settings.inference_model_launch_boundary"];

const AGENT_INFERENCE_CONTROL_IDS = ["agents.inference_authoring"];

const IDENTITY_ACCOUNT_CONTROL_IDS = [
	"settings.profile.no_write_guards",
	"settings.account.auth_status",
	"settings.account.device_login_payload",
	"settings.account.active_switch_noop",
	"settings.sessions.list_retry",
	"settings.sessions.revoke_remote",
	"settings.sessions.revoke_all_confirmation",
	"settings.sessions.current_no_write",
	"cli.identity.login",
	"cli.identity.logout",
	"cli.identity.whoami",
	"cli.identity.account",
	"cli.identity.plan",
	"cli.identity.sessions_list",
	"cli.identity.sessions_revoke",
	"cli.identity.sessions_revoke_all",
	"cli.identity.auth_backend_unavailable",
];

const IDENTITY_ACCOUNT_BOUNDARY_IDS = [
	"settings.account.security_mutations_boundary",
	"settings.account.email_verification_boundary",
	"settings.profile.avatar_boundary",
	"settings.profile.personal_context_boundary",
	"settings.authorized_apps.boundary",
];

test("CLI interaction census counts match unique controls and live test selectors", () => {
	const ids = census.controls.map((control) => control.id);
	expect(ids).toHaveLength(census.summary.total_control_records);
	expect(new Set(ids).size).toBe(ids.length);

	for (const status of ["covered", "partial", "uncovered"] as const) {
		expect(
			census.controls.filter((control) => control.status === status)
		).toHaveLength(census.summary[status]);
	}

	for (const control of census.controls) {
		if (control.status === "covered") {
			expect(control.tests?.length ?? 0).toBeGreaterThan(0);
		}
		for (const reference of control.tests ?? []) {
			const separator = reference.indexOf("#");
			const testPath = reference.slice(0, separator);
			const testTitle = reference.slice(separator + 1);
			const sourcePath = resolve(cliRoot, testPath);
			expect(separator).toBeGreaterThan(0);
			expect(existsSync(sourcePath)).toBe(true);
			expect(testTitle.length).toBeGreaterThan(0);
			expect(readFileSync(sourcePath, "utf8")).toContain(testTitle);
		}
	}
});

test("CLI privacy census covers each visible setting and its separate navigation controls", () => {
	const privacyControls = census.controls.filter((control) =>
		control.id.startsWith("settings.privacy.")
	);
	expect(privacyControls.map((control) => control.id)).toEqual(
		PRIVACY_CONTROL_IDS
	);
	for (const control of privacyControls) {
		expect(control.status).toBe("covered");
		expect(control.tests?.length ?? 0).toBeGreaterThan(0);
	}
});

test("CLI updates census covers the shared automatic-update setting", () => {
	const updateControls = census.controls.filter((control) =>
		UPDATE_CONTROL_IDS.includes(control.id)
	);
	expect(updateControls.map((control) => control.id)).toEqual(
		UPDATE_CONTROL_IDS
	);
	expect(updateControls[0]?.status).toBe("covered");
	expect(updateControls[0]?.tests?.length ?? 0).toBeGreaterThan(0);
});

test("CLI chat parity census covers structured arguments and ACP-advertised commands", () => {
	const parityControls = census.controls.filter((control) =>
		CLI_PARITY_CONTROL_IDS.includes(control.id)
	);
	expect(parityControls.map((control) => control.id)).toEqual(
		CLI_PARITY_CONTROL_IDS
	);
	for (const control of parityControls) {
		expect(control.status).toBe("covered");
		expect(control.tests?.length ?? 0).toBeGreaterThan(0);
	}
});

test("CLI Memory census records implemented advanced capabilities with remaining library control gaps", () => {
	const memoryControls = census.controls.filter((control) =>
		MEMORY_CONTROL_IDS.includes(control.id)
	);
	expect(memoryControls.map((control) => control.id)).toEqual(
		MEMORY_CONTROL_IDS
	);
	for (const control of memoryControls) {
		expect(control.status).toBe("covered");
		expect(control.tests?.length ?? 0).toBeGreaterThan(0);
	}
	const boundaries = census.controls.filter((control) =>
		MEMORY_BOUNDARY_IDS.includes(control.id)
	);
	expect(boundaries.map((control) => control.id)).toEqual(MEMORY_BOUNDARY_IDS);
	for (const boundary of boundaries) {
		expect(boundary.status).toBe("covered");
	}
});

test("CLI Gateway safety census separates status actions from reachable policy editing", () => {
	const controls = census.controls.filter((control) =>
		GATEWAY_SAFETY_CONTROL_IDS.includes(control.id)
	);
	expect(controls.map((control) => control.id)).toEqual(
		GATEWAY_SAFETY_CONTROL_IDS
	);
	for (const control of controls) {
		expect(control.status).toBe("covered");
		expect(control.tests?.length ?? 0).toBeGreaterThan(0);
	}
	const boundaries = census.controls.filter((control) =>
		SAFETY_BOUNDARY_IDS.includes(control.id)
	);
	expect(boundaries.map((control) => control.id)).toEqual(SAFETY_BOUNDARY_IDS);
	expect(boundaries[0]?.status).toBe("covered");
});

test("CLI inference census covers engine launch defaults and records the unexposed per-model contract", () => {
	const controls = census.controls.filter((control) =>
		INFERENCE_CONTROL_IDS.includes(control.id)
	);
	expect(controls.map((control) => control.id)).toEqual(INFERENCE_CONTROL_IDS);
	for (const control of controls) {
		expect(control.status).toBe("covered");
		expect(control.tests?.length ?? 0).toBeGreaterThan(0);
	}
	const boundaries = census.controls.filter((control) =>
		INFERENCE_BOUNDARY_IDS.includes(control.id)
	);
	expect(boundaries.map((control) => control.id)).toEqual(
		INFERENCE_BOUNDARY_IDS
	);
	expect(boundaries[0]?.status).toBe("partial");
});

test("CLI agent inference census covers the canonical per-agent sampling contract", () => {
	const controls = census.controls.filter((control) =>
		AGENT_INFERENCE_CONTROL_IDS.includes(control.id)
	);
	expect(controls.map((control) => control.id)).toEqual(
		AGENT_INFERENCE_CONTROL_IDS
	);
	expect(controls[0]?.status).toBe("covered");
	expect(controls[0]?.tests?.length ?? 0).toBeGreaterThan(0);
});

test("CLI identity census records reachable account capabilities and granular control evidence", () => {
	const controls = census.controls.filter((control) =>
		IDENTITY_ACCOUNT_CONTROL_IDS.includes(control.id)
	);
	expect(controls.map((control) => control.id)).toEqual(
		IDENTITY_ACCOUNT_CONTROL_IDS
	);
	for (const control of controls) {
		expect(control.status).toBe("covered");
		expect(control.tests?.length ?? 0).toBeGreaterThan(0);
	}
	const boundaries = census.controls.filter((control) =>
		IDENTITY_ACCOUNT_BOUNDARY_IDS.includes(control.id)
	);
	expect(boundaries.map((control) => control.id)).toEqual(
		IDENTITY_ACCOUNT_BOUNDARY_IDS
	);
	for (const boundary of boundaries) {
		expect(boundary.status).toBe("covered");
	}
});

test("CLI granular parity census names production source anchors and actual App interaction selectors", () => {
	const added = census.controls.filter((control) => control.source_anchor);
	expect(added.length).toBeGreaterThan(0);
	for (const control of added) {
		expect(control.source).toBeDefined();
		const source = readFileSync(resolve(cliRoot, control.source!), "utf8");
		expect(source).toContain(control.source_anchor!);
		for (const reference of control.tests ?? []) {
			const testSource = readFileSync(
				resolve(cliRoot, reference.split("#")[0]!),
				"utf8"
			);
			expect(testSource).toContain("<App");
			expect(testSource).toContain("testRender");
			expect(testSource).toContain("expect(");
		}
	}
});

test("CLI parity census keeps absent per-model editor separate from implemented settings", () => {
	const boundary = census.controls.find(
		(control) => control.id === "settings.inference_model_launch_boundary"
	);
	expect(boundary?.status).toBe("partial");
	for (const [path, anchor] of [
		["src/overlays/settings/profile.tsx", "<PersonalContext"],
		["src/overlays/settings/profile.tsx", "<ProfileAvatar"],
		["src/overlays/settings/index.tsx", "<AuthorizedAppsPanel"],
		["src/overlays/settings/memory.tsx", "<MemoryAdvanced"],
		["src/overlays/settings/memory.tsx", "<MemoryLibrary"],
		["src/overlays/gateway/index.tsx", "<GatewayAdvancedPolicy"],
	] as const) {
		expect(readFileSync(resolve(cliRoot, path), "utf8")).toContain(anchor);
	}
});
