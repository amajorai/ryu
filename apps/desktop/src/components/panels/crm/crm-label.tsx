import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { NativeSelectOption } from "@ryu/ui/components/native-select.tsx";

/**
 * CRM object names and option labels are schema data, so the DOM localizer
 * must not treat them as UI copy: "Deal" would come out as the verb (配る,
 * Austeilen) and "Lead" as leadership. The two seed labels with a wrong-sense
 * catalog match translate through their own unambiguous messages instead.
 */
const DISAMBIGUATED_SEED_LABELS: Readonly<
	Record<string, (tl: LiteralMessage) => [source: string, translated: string]>
> = {
	Deal: (tl) => ["Deal (CRM record)", tl("Deal (CRM record)")],
	Lead: (tl) => ["Lead stage", tl("Lead stage")],
};

/**
 * Seed labels whose catalog entry already has the right sense. They stay open
 * to the DOM localizer so a fresh workspace keeps reading in the user's
 * language; everything else a user typed renders exactly as written.
 */
const LOCALIZABLE_SEED_LABELS: ReadonlySet<string> = new Set([
	"Cancelled",
	"Companies",
	"Company",
	"Customer",
	"Description",
	"Done",
	"Education",
	"Event",
	"Healthcare",
	"High",
	"In progress",
	"Location",
	"Low",
	"Media",
	"Medium",
	"Note",
	"Notes",
	"Other",
	"Partner",
	"People",
	"Person",
	"Pipeline",
	"Proposal",
	"Task",
	"Tasks",
	"To do",
	"Urgent",
]);

/**
 * The text to show for a CRM schema label. A wrong-sense seed label resolves to
 * its disambiguated translation; English (or a locale without that message)
 * keeps the label as typed.
 */
export function crmLabel(text: string, tl: LiteralMessage): string {
	const disambiguate = DISAMBIGUATED_SEED_LABELS[text];
	if (!disambiguate) {
		return text;
	}
	const [source, translated] = disambiguate(tl);
	return translated === source ? text : translated;
}

/** `"off"` unless the label is a seed label the DOM localizer may translate. */
export function crmLabelI18n(text: string): "off" | undefined {
	return LOCALIZABLE_SEED_LABELS.has(text) ? undefined : "off";
}

/** A CRM schema label (object name, select option) rendered as user data. */
export function CrmUserText({
	className,
	text,
	withTitle = false,
}: {
	className?: string;
	text: string;
	/** Also set the label as the element's tooltip (for truncated text). */
	withTitle?: boolean;
}) {
	const tl = useLiteralMessages();
	const label = crmLabel(text, tl);
	return (
		<span
			className={className}
			data-ryu-i18n={crmLabelI18n(text)}
			title={withTitle ? label : undefined}
		>
			{label}
		</span>
	);
}

/** The label as a bare string child, so `NativeSelectOption` does not look it
 *  up as UI copy (it translates plain string children literally). */
function CrmLabelString({ text }: { text: string }) {
	const tl = useLiteralMessages();
	return crmLabel(text, tl);
}

/** A select option whose text is a CRM schema label. A localizable seed label
 *  stays a plain string child, which the option translates as before. */
export function CrmSelectOption({
	label,
	value,
}: {
	label: string;
	value: string;
}) {
	const i18n = crmLabelI18n(label);
	return (
		<NativeSelectOption data-ryu-i18n={i18n} value={value}>
			{i18n ? <CrmLabelString text={label} /> : label}
		</NativeSelectOption>
	);
}
