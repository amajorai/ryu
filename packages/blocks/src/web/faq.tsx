import {
	BouncyAccordion,
	type BouncyAccordionItem,
} from "@ryu/ui/components/bouncy-accordion";

import { SectionTitle } from "./section-title.tsx";

export interface FAQItem {
	content: string | string[];
	id: string;
	title: string;
}

export const GENERAL_FAQ_ITEMS: FAQItem[] = [
	{
		id: "1",
		title: "What does Ryu do for a startup?",
		content: [
			"We take one workflow your team already runs with AI and make the context, access, review points, and cost visible around it.",
			"Your team spends less time checking and copying, while every important task leaves a record of what happened.",
		],
	},
	{
		id: "2",
		title: "Can we keep using ChatGPT or Claude?",
		content: [
			"Yes. Ryu works with the AI your team already uses, including ChatGPT and Claude. You do not need to replace a tool people already know.",
			"Ryu adds the context controls, review points, and record around the work so the output is easier to trust.",
		],
	},
	{
		id: "3",
		title: "Can our company data leave?",
		content: [
			"Not unless you choose that. Ryu can run on your own machines, so the work can stay inside your company boundary.",
			"If a workflow uses an outside model, you can see which path it took and apply the access rules you set.",
		],
	},
	{
		id: "4",
		title: "How do we know if an answer is safe to use?",
		content: [
			"Every important task keeps a readable record of the source it used, what it produced, what changed, who reviewed it, and what it cost.",
			"Your team can see the evidence before it sends, publishes, or updates anything important.",
		],
	},
	{
		id: "5",
		title: "Can AI reach the files and systems we use?",
		content: [
			"Yes, with access you choose. Ryu can connect the approved files and systems a workflow needs instead of asking someone to copy context between tools.",
			"Permissions stay explicit, and the record shows what the work touched.",
		],
	},
	{
		id: "6",
		title: "What happens when our rules change?",
		content: [
			"You update the rule in one place and new work uses the current version. Older versions stay available, so you can see what was true when an answer was made.",
			"Corrections your reviewers make are kept too, so the work becomes more consistent over time.",
		],
	},
	{
		id: "7",
		title: "What does it cost, and can the bill run away from us?",
		content: [
			"Managed AI plans start at $49 per person per month. A Major Pass is $20/month for supported paid Marketplace apps.",
			"Routine work can run on your own machines, so expensive model calls are used only when a job genuinely needs one.",
		],
	},
	{
		id: "8",
		title: "Do we need someone technical on staff?",
		content: [
			"No. We set up the first workflow with you and keep the rules, access, and cost controls in place. If you would rather not host it, we can run it for you under the same limits.",
		],
	},
	{
		id: "9",
		title: "Who is Ryu for?",
		content: [
			"Startups that already use AI but still pay people to check, copy, and clean up the result — especially when company data or customer commitments are involved.",
			"If the answer needs context, a review point, and a cost you can explain, Ryu is built for that work.",
		],
	},
	{
		id: "10",
		title: "Which AI models does Ryu support?",
		content: [
			"OpenAI, Anthropic, Gemini, local models via Ollama or compatible runtimes, and supported provider models. Switching models does not change how your workflow is set up.",
		],
	},
	{
		id: "11",
		title: "Is Ryu open source?",
		content: [
			"Ryu follows an open-core model. The core and gateway are self-hostable, while the desktop app, managed cloud and business features are commercial. You keep the option to leave.",
		],
	},
];

interface FAQProps {
	items?: FAQItem[];
}

function faqAnswer(content: FAQItem["content"]) {
	const paragraphs = Array.isArray(content) ? content : [content];

	return (
		<div className="space-y-3">
			{paragraphs.map((paragraph, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static content
				<p key={index}>{paragraph}</p>
			))}
		</div>
	);
}

export default function FAQ({ items = GENERAL_FAQ_ITEMS }: FAQProps) {
	const accordionItems: BouncyAccordionItem[] = items.map((item) => ({
		id: item.id,
		title: item.title,
		description: faqAnswer(item.content),
	}));

	return (
		<div className="container mx-auto px-4 py-16">
			<div className="mx-auto flex max-w-2xl flex-col gap-4">
				<div>
					<SectionTitle size="compact" title="Frequently Asked Questions" />
				</div>

				<BouncyAccordion
					classNames={{
						// Keep the card look the Base UI version had; the bouncy rows
						// animate their own radii, so no rounding class here.
						item: "border-none bg-muted/50 dark:bg-white/5",
						trigger: "px-4 py-3",
						title: "font-medium text-[15px] leading-6",
						description: "px-1 text-[15px] text-muted-foreground",
					}}
					items={accordionItems}
				/>
			</div>
		</div>
	);
}
