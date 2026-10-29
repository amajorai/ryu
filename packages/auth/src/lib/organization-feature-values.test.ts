import { afterAll, beforeAll, beforeEach, expect, it, mock } from "bun:test";
import type { EffectivePolicyScope } from "@ryu/db/models/effective-policy";

interface Control {
	enabled: boolean;
	key: string;
	userId: string | null;
}
interface TeamControl {
	enabled: boolean;
	key: string;
	teamId: string;
}

let controls: Control[] = [];
let teamControls: TeamControl[] = [];
let teamRows: { _id: string }[] = [];
let memberships: { teamId: string }[] = [];
let allowedFeatures: string[] = [];
/** Per-scope `allowedFeatures`, keyed by the scope's team (or "" for none). */
let teamAllowedFeatures: Record<string, string[]> = {};
let policyScopes: EffectivePolicyScope[] = [];
let resolveValues: typeof import("./organization-feature-values.ts").resolveOrganizationFeatureValues;

const leanList = <Row>(rows: () => Row[]) => ({
	limit: () => ({ lean: async () => rows() }),
	select: () => ({ lean: async () => rows() }),
});

beforeAll(async () => {
	mock.module("@ryu/db/models/control-plane.model", () => ({
		Team: { find: () => leanList(() => teamRows) },
		TeamMember: { find: () => leanList(() => memberships) },
	}));
	mock.module("@ryu/db/models/effective-policy", () => ({
		loadEffectivePolicy: async (
			_organizationId: string,
			scope: EffectivePolicyScope
		) => {
			policyScopes.push(scope);
			return {
				lockedFields: [],
				rules: {
					allowedFeatures:
						teamAllowedFeatures[scope.teamId ?? ""] ?? allowedFeatures,
				},
			};
		},
	}));
	mock.module("@ryu/db/models/organization-feature-control.model", () => ({
		OrganizationFeatureControl: { find: () => leanList(() => controls) },
		OrganizationTeamFeatureControl: {
			find: (filter: { teamId: { $in: string[] } }) =>
				leanList(() =>
					teamControls.filter((row) => filter.teamId.$in.includes(row.teamId))
				),
		},
	}));
	({ resolveOrganizationFeatureValues: resolveValues } = await import(
		"./organization-feature-values.ts"
	));
});

beforeEach(() => {
	controls = [];
	teamControls = [];
	teamRows = [];
	memberships = [];
	allowedFeatures = [];
	teamAllowedFeatures = {};
	policyScopes = [];
});

afterAll(() => {
	mock.restore();
});

it("layers organization, the member's teams, then the member", async () => {
	controls = [{ enabled: false, key: "products.box", userId: null }];
	teamRows = [{ _id: "team-a" }];
	memberships = [{ teamId: "team-a" }];
	teamControls = [{ enabled: true, key: "products.box", teamId: "team-a" }];
	let values = await resolveValues({
		keys: ["products.box"],
		organizationId: "org",
		userId: "user",
	});
	expect(values.get("products.box")).toBe(true);

	controls.push({ enabled: false, key: "products.box", userId: "user" });
	values = await resolveValues({
		keys: ["products.box"],
		organizationId: "org",
		userId: "user",
	});
	expect(values.get("products.box")).toBe(false);
	expect(policyScopes.slice(-2)).toEqual([
		{ userId: "user" },
		{ teamId: "team-a", userId: "user" },
	]);
});

it("applies each of the member's team policy layers to allowedFeatures", async () => {
	teamRows = [{ _id: "team-a" }, { _id: "team-b" }];
	memberships = [{ teamId: "team-a" }, { teamId: "team-b" }];
	teamAllowedFeatures = { "team-b": ["products.mail"] };
	const values = await resolveValues({
		keys: ["products.box", "products.mail"],
		organizationId: "org",
		userId: "user",
	});
	expect(values.get("products.box")).toBe(false);
	expect(values.get("products.mail")).toBe(true);
	expect(policyScopes).toEqual([
		{ userId: "user" },
		{ teamId: "team-a", userId: "user" },
		{ teamId: "team-b", userId: "user" },
	]);
});

it("applies the member's user layer alongside each team layer", async () => {
	teamRows = [{ _id: "team-a" }];
	memberships = [{ teamId: "team-a" }];
	teamAllowedFeatures = { "": ["products.mail"], "team-a": ["products.box"] };
	const values = await resolveValues({
		keys: ["products.box", "products.mail"],
		organizationId: "org",
		userId: "user",
	});
	expect(values.get("products.box")).toBe(false);
	expect(values.get("products.mail")).toBe(false);
});

it("leaves a member with no teams on the organization and user layers", async () => {
	allowedFeatures = ["products.*"];
	const values = await resolveValues({
		keys: ["products.box", "apps.install"],
		organizationId: "org",
		userId: "user",
	});
	expect(values.get("products.box")).toBe(true);
	expect(values.get("apps.install")).toBe(false);
	expect(policyScopes).toEqual([{ userId: "user" }]);
});

it("uses only the teams a node names, never the caller's other teams", async () => {
	teamControls = [
		{ enabled: false, key: "products.box", teamId: "team-a" },
		{ enabled: true, key: "products.box", teamId: "team-b" },
	];
	const values = await resolveValues({
		keys: ["products.box"],
		organizationId: "org",
		policyScope: { teamId: "team-b", userId: "user" },
		teamIds: ["team-b"],
		userId: "user",
	});
	expect(values.get("products.box")).toBe(true);
	expect(policyScopes).toEqual([{ teamId: "team-b", userId: "user" }]);
});

it("turns off every feature the policy's allowedFeatures excludes", async () => {
	controls = [{ enabled: true, key: "apps.install", userId: null }];
	allowedFeatures = ["products.*"];
	const values = await resolveValues({ organizationId: "org" });
	expect(values.get("apps.install")).toBe(false);
	expect(values.get("products.box")).toBe(true);
	expect(policyScopes).toEqual([{}]);
});
