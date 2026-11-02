import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type {
	Activity,
	CrmObject,
	CrmRecord,
	Field,
	ObjectWithFields,
	RelatedGroup,
	SchemaResponse,
	View,
} from "@/src/lib/api/crm.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

export const PROOF_PAGE = "/crm-record-detail-proof.html";
export const TIMESTAMP = "2026-10-01T00:00:00.000Z";
export const DEAL_ID = "deal_1";

export interface CapturedRequest {
	auth: string | null;
	body: unknown;
	method: string;
	origin: string;
	path: string;
	status: number;
}

export interface CrmProofFixture {
	activities: Activity[];
	failNext: (method: string, path: string, status?: number) => void;
	readRecord: (id: string) => CrmRecord | undefined;
	readRelated: () => RelatedGroup[];
	requests: CapturedRequest[];
	unexpected: string[];
}

export interface CrmFixtureOptions {
	linkedCompanyDeleted?: boolean;
}

export const evidenceDir =
	process.env.RYU_CRM_RECORD_DETAIL_PROOF_DIR ??
	proofEvidencePath("test-coverage-sweep-20260924/evidence");
export const proofStates = new WeakMap<
	Page,
	{ fixture?: CrmProofFixture; pageErrors: string[] }
>();

export function evidencePath(name: string): string {
	return path.resolve(evidenceDir, `${name}.png`);
}

export function makeObject({
	id,
	plural,
	singular,
	slug,
	titleFieldId,
}: Pick<CrmObject, "id" | "plural" | "singular" | "slug"> & {
	titleFieldId: string;
}): CrmObject {
	return {
		created_at: TIMESTAMP,
		id,
		is_standard: true,
		plural,
		position: 0,
		singular,
		slug,
		title_field_id: titleFieldId,
		updated_at: TIMESTAMP,
	};
}

export function makeField({
	fieldType,
	id,
	isSystem = false,
	name,
	objectId,
	position,
	slug,
}: {
	fieldType: Field["field_type"];
	id: string;
	isSystem?: boolean;
	name: string;
	objectId: string;
	position: number;
	slug: string;
}): Field {
	return {
		created_at: TIMESTAMP,
		field_type: fieldType,
		id,
		is_required: false,
		is_system: isSystem,
		is_unique: false,
		name,
		object_id: objectId,
		position,
		slug,
		updated_at: TIMESTAMP,
	};
}

export function makeActivity({
	completedAt = null,
	id,
	kind,
	title,
}: {
	completedAt?: string | null;
	id: string;
	kind: Activity["kind"];
	title: string;
}): Activity {
	return {
		completed_at: completedAt,
		created_at: TIMESTAMP,
		id,
		kind,
		record_id: DEAL_ID,
		title,
		updated_at: TIMESTAMP,
	};
}

export function makeFixtureSchema(): SchemaResponse {
	const dealTitle = makeField({
		fieldType: "text",
		id: "fld_deal_title",
		isSystem: true,
		name: "Deal name",
		objectId: "obj_deal",
		position: 0,
		slug: "title",
	});
	const amount = makeField({
		fieldType: "number",
		id: "fld_amount",
		name: "Amount",
		objectId: "obj_deal",
		position: 1,
		slug: "amount",
	});
	const companyLink = makeField({
		fieldType: "relation",
		id: "fld_company",
		name: "Company",
		objectId: "obj_deal",
		position: 2,
		slug: "company",
	});
	const companyTitle = makeField({
		fieldType: "text",
		id: "fld_company_title",
		isSystem: true,
		name: "Company name",
		objectId: "obj_company",
		position: 0,
		slug: "title",
	});
	const companyWebsite = makeField({
		fieldType: "url",
		id: "fld_company_website",
		name: "Website",
		objectId: "obj_company",
		position: 1,
		slug: "website",
	});
	const defaultView: View = {
		created_at: TIMESTAMP,
		filter: null,
		id: "view_deals",
		is_default: true,
		kind: "table",
		name: "All deals",
		object_id: "obj_deal",
		position: 0,
		sorts: [],
		updated_at: TIMESTAMP,
		visible_field_ids: [amount.id, companyLink.id],
	};
	const deal: ObjectWithFields = {
		fields: [dealTitle, amount, companyLink],
		object: makeObject({
			id: "obj_deal",
			plural: "Deals",
			singular: "Deal",
			slug: "deal",
			titleFieldId: dealTitle.id,
		}),
		record_count: 1,
		views: [defaultView],
	};
	const company: ObjectWithFields = {
		fields: [companyTitle, companyWebsite],
		object: makeObject({
			id: "obj_company",
			plural: "Companies",
			singular: "Company",
			slug: "company",
			titleFieldId: companyTitle.id,
		}),
		record_count: 2,
		views: [],
	};
	return { lists: [], objects: [deal, company] };
}

export async function openRecord(page: Page): Promise<void> {
	await page.goto(PROOF_PAGE);
	await expect(
		page.getByRole("button", { name: "Renewal Acme" })
	).toBeVisible();
	await page.getByRole("button", { name: "Renewal Acme" }).click();
	await expect(
		page.getByRole("heading", { name: "Renewal Acme" })
	).toBeVisible();
}

export async function capture(page: Page, name: string): Promise<void> {
	const target = evidencePath(name);
	await mkdir(path.dirname(target), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: target,
	});
}

export function requestFor(
	fixture: CrmProofFixture,
	method: string,
	requestPath: string
): CapturedRequest[] {
	return fixture.requests.filter(
		(request) => request.method === method && request.path === requestPath
	);
}
