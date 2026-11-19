import type { LiteralMessage } from "@ryu/i18n/react";

/** A seed label's catalog message and its translation in the active locale. */
type SeedLabelMessage = (
	tl: LiteralMessage
) => [source: string, translated: string];

/**
 * CRM object names, field names, option labels and view names that the CRM
 * backend seeds into a fresh workspace (`apps-store/crm/backend/src/store/seeds.rs`)
 * and that the catalog has no right-sense entry for. A wrong-sense or
 * ambiguous label translates through its own unambiguous message ("Deal"
 * would come out as the verb, "Won" and "Lost" need the deal-stage sense, "All
 * people" would read as workspace members); the rest translate through a
 * message spelled like the label. Each value renders already translated, so
 * the DOM localizer leaves it alone.
 */
export const CRM_SEED_LABEL_MESSAGES: Readonly<
	Record<string, SeedLabelMessage>
> = {
	"All companies": (tl) => ["All companies", tl("All companies")],
	"All deals": (tl) => ["All deals", tl("All deals")],
	"All notes": (tl) => ["All notes", tl("All notes")],
	"All people": (tl) => ["All people (CRM view)", tl("All people (CRM view)")],
	"All tasks": (tl) => ["All tasks", tl("All tasks")],
	ARR: (tl) => [
		"ARR (annual recurring revenue)",
		tl("ARR (annual recurring revenue)"),
	],
	Churned: (tl) => ["Churned", tl("Churned")],
	"Close date": (tl) => ["Close date (deal)", tl("Close date (deal)")],
	Deal: (tl) => ["Deal (CRM record)", tl("Deal (CRM record)")],
	Deals: (tl) => ["Deals (CRM records)", tl("Deals (CRM records)")],
	"E-commerce": (tl) => ["E-commerce", tl("E-commerce")],
	Employees: (tl) => ["Employees", tl("Employees")],
	Fintech: (tl) => ["Fintech", tl("Fintech")],
	Inbound: (tl) => ["Inbound (deal source)", tl("Inbound (deal source)")],
	Industry: (tl) => ["Industry", tl("Industry")],
	"Job title": (tl) => ["Job title", tl("Job title")],
	Lead: (tl) => ["Lead stage", tl("Lead stage")],
	Lost: (tl) => ["Lost (deal stage)", tl("Lost (deal stage)")],
	Manufacturing: (tl) => ["Manufacturing", tl("Manufacturing")],
	Negotiation: (tl) => ["Negotiation", tl("Negotiation")],
	Nonprofit: (tl) => ["Nonprofit", tl("Nonprofit")],
	Outbound: (tl) => ["Outbound (deal source)", tl("Outbound (deal source)")],
	Probability: (tl) => ["Probability", tl("Probability")],
	Prospect: (tl) => [
		"Prospect (company status)",
		tl("Prospect (company status)"),
	],
	Qualified: (tl) => ["Qualified (deal stage)", tl("Qualified (deal stage)")],
	Referral: (tl) => ["Referral (deal source)", tl("Referral (deal source)")],
	"Task board": (tl) => ["Task board", tl("Task board")],
	Won: (tl) => ["Won (deal stage)", tl("Won (deal stage)")],
};

/**
 * Seed labels whose catalog entry already has the right sense. They stay open
 * to the DOM localizer so a fresh workspace keeps reading in the user's
 * language; everything else a user typed renders exactly as written.
 */
export const LOCALIZABLE_SEED_LABELS: ReadonlySet<string> = new Set([
	"Amount",
	"Assignee",
	"Author",
	"Body",
	"Cancelled",
	"Companies",
	"Company",
	"Contacts",
	"Customer",
	"Description",
	"Domain",
	"Done",
	"Due",
	"Education",
	"Email",
	"Event",
	"Healthcare",
	"High",
	"In progress",
	"Location",
	"Low",
	"Media",
	"Medium",
	"Name",
	"Note",
	"Notes",
	"Other",
	"Owner",
	"Partner",
	"People",
	"Person",
	"Phone",
	"Pinned",
	"Pipeline",
	"Priority",
	"Proposal",
	"Source",
	"Stage",
	"Status",
	"Subject",
	"Tags",
	"Task",
	"Tasks",
	"To do",
	"Urgent",
	"Website",
]);
