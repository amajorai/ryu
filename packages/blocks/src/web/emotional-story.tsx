import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { DownloadMenu } from "./download-menu.tsx";
import {
	AuditSafetyMock,
	ChatbotOnlyMock,
	DemoDeathMock,
	GovernedAgentMock,
	InstallLocalMock,
	SevenMinuteMock,
	StillRunningMock,
} from "./emotional-story-mockups.tsx";
import {
	BentoCard,
	BentoGrid,
	type BentoItem,
	SectionTitle,
} from "./sections.tsx";

const THREE_PATHS: BentoItem[] = [
	{
		title: "Left behind",
		description: "Catch up without a platform team.",
		visual: <ChatbotOnlyMock />,
	},
	{
		title: "Quiet dread",
		description: "Your agent won't be the leak.",
		visual: <AuditSafetyMock />,
	},
	{
		title: "You know the moment",
		description: "Demo great. Review kills it.",
		visual: <DemoDeathMock />,
	},
];

const RYU_PATH_ITEMS: BentoItem[] = [
	{
		title: "Yours",
		description: "Local. One click. No keys.",
		visual: <InstallLocalMock />,
	},
	{
		title: "Now imagine the opposite",
		description: "Logged. Redacted. Capped. Still running.",
		span: "md:col-span-2",
		visual: <GovernedAgentMock />,
	},
	{
		title: "Real work in 7 minutes",
		description: "Not another chatbot thread.",
		span: "md:col-span-2",
		visual: <SevenMinuteMock />,
		action: <DownloadMenu />,
	},
	{
		title: "Be the one who got it right",
		description: "Works with everything. Locked to nothing.",
		visual: <StillRunningMock />,
		action: (
			<Link
				className={cn(buttonVariants({ variant: "ghost" }), "inline-flex")}
				href="https://cal.com/jiaweing/ryu-demo"
				rel="noopener noreferrer"
				target="_blank"
			>
				Book a demo
			</Link>
		),
	},
];

export default function EmotionalStory() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-6xl">
				<div className="mb-10 max-w-2xl">
					<SectionTitle title="Everyone else is shipping agents. You are still on ChatGPT." />
				</div>

				<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
					{THREE_PATHS.map((item) => (
						<BentoCard item={item} key={item.title} />
					))}
				</div>

				<div className="mt-12 md:mt-16">
					<p className="mb-6 font-medium text-foreground text-sm">
						The path Ryu is built for
					</p>
					<BentoGrid items={RYU_PATH_ITEMS} />
				</div>
			</div>
		</section>
	);
}
