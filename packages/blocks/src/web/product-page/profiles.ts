import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import { getProduct } from "../data/products.tsx";
import { requirementsForSlug } from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import type {
	ProductProfile,
	ProductProfileFile,
	ProfileRequirement,
} from "./profile-types.ts";
import * as agentApiA from "./profiles-agent-api-a.ts";
import * as agentApiB from "./profiles-agent-api-b.ts";
import * as builderA from "./profiles-builder-a.ts";
import * as builderB from "./profiles-builder-b.ts";
import * as catalog from "./profiles-catalog.ts";
import * as infrastructureA from "./profiles-infrastructure-a.ts";
import * as infrastructureB from "./profiles-infrastructure-b.ts";
import * as preview from "./profiles-preview.ts";
import * as workspace from "./profiles-workspace.ts";

function profileFile(
	file: string,
	module: {
		ARCHETYPE: ProductProfileFile["archetype"];
		PROFILE_SLUGS: readonly StageProductSlug[];
		PROFILES: Partial<Record<StageProductSlug, ProductProfile>>;
	}
): ProductProfileFile {
	return {
		file,
		archetype: module.ARCHETYPE,
		slugs: module.PROFILE_SLUGS,
		profiles: module.PROFILES,
	};
}

/** Every profile data file, each owned by one data unit. */
export const PROFILE_FILES: readonly ProductProfileFile[] = [
	profileFile("profiles-infrastructure-a.ts", infrastructureA),
	profileFile("profiles-infrastructure-b.ts", infrastructureB),
	profileFile("profiles-agent-api-a.ts", agentApiA),
	profileFile("profiles-agent-api-b.ts", agentApiB),
	profileFile("profiles-builder-a.ts", builderA),
	profileFile("profiles-builder-b.ts", builderB),
	profileFile("profiles-workspace.ts", workspace),
	profileFile("profiles-catalog.ts", catalog),
	profileFile("profiles-preview.ts", preview),
];

function mergeProfiles(): Partial<Record<StageProductSlug, ProductProfile>> {
	const merged: Partial<Record<StageProductSlug, ProductProfile>> = {};
	for (const file of PROFILE_FILES) {
		for (const slug of file.slugs) {
			const profile = file.profiles[slug];
			if (profile) {
				merged[slug] = profile;
			}
		}
	}
	return merged;
}

export const PRODUCT_PROFILES: Readonly<
	Partial<Record<StageProductSlug, ProductProfile>>
> = mergeProfiles();

export function getProductProfile(slug: string): ProductProfile | undefined {
	return (
		PRODUCT_PROFILES as Readonly<Record<string, ProductProfile | undefined>>
	)[slug];
}

function meets(
	requirement: ProfileRequirement,
	profile: ProductProfile
): boolean {
	switch (requirement) {
		case "facts":
			return profile.facts.length >= 2;
		case "architecture":
			return Boolean(profile.architecture);
		case "code":
			return Boolean(profile.code?.length);
		case "interfaces":
			return Boolean(profile.interfaces?.length);
		case "limits":
			return Boolean(profile.limits?.rows.length);
		case "openapi":
			return Boolean(profile.openapi);
		case "quickstart":
			return (profile.quickstart?.length ?? 0) >= 2;
		case "availability":
			return Boolean(profile.availability?.length);
		case "catalog":
			return Boolean(profile.catalog?.items.length);
		case "status":
			return (
				(profile.status?.today.length ?? 0) +
					(profile.status?.planned.length ?? 0) >=
				2
			);
		case "docs":
			return Boolean(profile.docs?.length);
		case "code-or-comparison":
			return Boolean(profile.code?.length || profile.comparison);
		default:
			return false;
	}
}

/**
 * Requirements a profile does not meet for a slug, in requirement order. A
 * missing profile misses every requirement; an unknown slug keeps `docs`.
 */
export function profileGapsFor(
	slug: string,
	profile: ProductProfile | undefined
): ProfileRequirement[] {
	const product = getProduct(slug);
	const requirements = requirementsForSlug(slug, {
		hasDocsCta: product ? Boolean(productDocsPath(product)) : true,
	});
	if (!profile) {
		return requirements;
	}
	return requirements.filter((requirement) => !meets(requirement, profile));
}

/** Requirements the registered profile for a slug does not meet yet. */
export function profileGaps(slug: string): ProfileRequirement[] {
	return profileGapsFor(slug, getProductProfile(slug));
}

const MIN_ARCHITECTURE_NODES = 3;
const MAX_ARCHITECTURE_NODES = 6;

/** Structural errors no type can express (counts, lengths, unique ids). */
export function profileShapeErrors(profile: ProductProfile): string[] {
	const errors: string[] = [];
	const nodes = profile.architecture?.nodes.length;
	if (
		nodes !== undefined &&
		(nodes < MIN_ARCHITECTURE_NODES || nodes > MAX_ARCHITECTURE_NODES)
	) {
		errors.push(`architecture has ${nodes} nodes; use 3–6`);
	}
	const columns = profile.comparison?.columns.length ?? 0;
	for (const row of profile.comparison?.rows ?? []) {
		if (row.values.length !== columns) {
			errors.push(
				`comparison row "${row.label}" has ${row.values.length} values for ${columns} columns`
			);
		}
	}
	const ids = profile.code?.map((sample) => sample.id) ?? [];
	if (new Set(ids).size !== ids.length) {
		errors.push("code sample ids repeat");
	}
	for (const link of profile.docs ?? []) {
		if (!link.path.startsWith("/docs")) {
			errors.push(`docs link "${link.label}" must be a /docs path`);
		}
	}
	for (const row of profile.interfaces ?? []) {
		if (row.status === "not-published" && !row.note) {
			errors.push(`interface "${row.name}" is not published but has no note`);
		}
	}
	return errors;
}

/** Every visible string a profile contributes, for copy checks (banned words). */
export function profileCopyStrings(profile: ProductProfile): string[] {
	const out: string[] = [];
	const add = (...values: (string | undefined)[]) => {
		for (const value of values) {
			if (value) {
				out.push(value);
			}
		}
	};
	for (const fact of profile.facts) {
		add(fact.label, fact.value);
	}
	for (const sample of profile.code ?? []) {
		add(sample.label, sample.filename);
	}
	const { architecture, comparison, guardrail, limits } = profile;
	add(architecture?.title, architecture?.caption);
	for (const node of architecture?.nodes ?? []) {
		add(node.label, node.detail);
	}
	for (const row of profile.interfaces ?? []) {
		add(row.name, row.summary, row.note);
	}
	add(limits?.title);
	for (const row of limits?.rows ?? []) {
		add(row.label, row.value, row.note);
	}
	for (const step of profile.quickstart ?? []) {
		add(step.title, step.description);
	}
	add(comparison?.title, comparison?.rowHeader, ...(comparison?.columns ?? []));
	for (const row of comparison?.rows ?? []) {
		add(row.label, ...row.values);
	}
	add(guardrail?.title, guardrail?.description);
	for (const line of guardrail?.lines ?? []) {
		add(line.text);
	}
	add(profile.availabilityTitle);
	for (const row of profile.availability ?? []) {
		add(row.platform, row.note);
	}
	add(profile.catalog?.title, profile.catalog?.subtitle);
	for (const item of profile.catalog?.items ?? []) {
		add(item.title, item.description);
	}
	const status = profile.status;
	for (const item of [
		...(status?.today ?? []),
		...(status?.planned ?? []),
		...(status?.notPlanned ?? []),
		...(profile.security?.points ?? []),
	]) {
		add(item.text);
	}
	for (const link of [...(profile.docs ?? []), ...(profile.related ?? [])]) {
		add(link.label, "description" in link ? link.description : undefined);
	}
	return out;
}
