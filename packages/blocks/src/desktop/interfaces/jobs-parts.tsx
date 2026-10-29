import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { User } from "lucide-react";
import { BoardAvatar, type BoardAvatarSize } from "./board-avatar.tsx";
import {
	COMPANY_TONE_COUNT,
	companyInitial,
	companyTone,
	JOB_STATUS_LABELS,
	type JobCompany,
	type JobStatus,
} from "./jobs-model.ts";

/**
 * Logo tiles from the theme. Themes keep one accent hue, so tiles tell
 * companies apart by treatment rather than by hue: a soft tint, solid brand,
 * solid ink, an outlined tile and a muted one. Status colors (success,
 * warning, destructive) stay reserved for status.
 */
const TONES: readonly string[] = [
	"bg-primary/15 text-primary",
	"bg-foreground text-background",
	"bg-primary text-primary-foreground",
	"bg-background text-foreground ring-1 ring-border ring-inset",
	"bg-accent text-accent-foreground ring-1 ring-border ring-inset",
];

export type CompanyLogoSize = 20 | 32 | 40 | 48;

const LOGO_SIZE: Record<CompanyLogoSize, string> = {
	20: "size-5 rounded text-[10px]",
	32: "size-8 rounded-md text-sm",
	40: "size-10 rounded-md text-base",
	48: "size-12 rounded-lg text-lg",
};

const LOGO_ICON: Record<CompanyLogoSize, string> = {
	20: "size-3",
	32: "size-4",
	40: "size-5",
	48: "size-6",
};

/**
 * A company's logo tile: its initial on a stable tint. Personal jobs get a
 * person glyph on the muted surface. Decorative; the company name is always
 * printed beside it.
 */
export function CompanyLogo({
	className,
	company,
	size,
}: {
	className?: string;
	company: JobCompany;
	size: CompanyLogoSize;
}) {
	if (company.kind === "personal") {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"flex shrink-0 items-center justify-center bg-muted text-muted-foreground ring-1 ring-border ring-inset",
					LOGO_SIZE[size],
					className
				)}
			>
				<User className={LOGO_ICON[size]} strokeWidth={2} />
			</span>
		);
	}
	const tone = TONES[companyTone(company.id) % COMPANY_TONE_COUNT];
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 select-none items-center justify-center font-semibold leading-none",
				LOGO_SIZE[size],
				tone,
				className
			)}
		>
			{companyInitial(company.name)}
		</span>
	);
}

const DOT: Record<JobStatus, string> = {
	closed: "bg-muted-foreground/50",
	"in-progress": "bg-success",
	"on-hold": "bg-warning",
	open: "border border-muted-foreground",
	review: "bg-primary",
};

const LABEL: Record<JobStatus, string> = {
	closed: "text-muted-foreground",
	"in-progress": "text-foreground",
	"on-hold": "text-foreground",
	open: "text-foreground",
	review: "text-primary",
};

/**
 * The hiring-vocabulary status as a dot and a word, like LinkedIn's colored
 * meta text. Review, the job waiting on you, is always a tinted pill, so it
 * stays distinct by shape even in themes whose brand color equals the
 * "In progress" success color.
 */
export function JobStatusPill({
	className,
	status,
}: {
	className?: string;
	status: JobStatus;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap font-medium text-[13px] leading-none",
				LABEL[status],
				status === "review" && "rounded-full bg-primary/12 px-2",
				className
			)}
			data-status={status}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 shrink-0 rounded-full", DOT[status])}
			/>
			{JOB_STATUS_LABELS[status]}
		</span>
	);
}

/** Avatar plus name for the freelancer assigned to a job. */
export function FreelancerChip({
	agent,
	className,
	extra = 0,
	size = 20,
}: {
	agent: InterfaceAgent | undefined;
	className?: string;
	extra?: number;
	size?: BoardAvatarSize;
}) {
	const tl = useLiteralMessages();
	if (!agent) {
		return (
			<span className={cn("text-muted-foreground text-sm", className)}>
				No freelancer hired
			</span>
		);
	}
	return (
		<span className={cn("flex min-w-0 items-center gap-2", className)}>
			<BoardAvatar agent={agent} name={agent.name} size={size} />
			<span className="truncate text-foreground text-sm">
				{agent.name}
				{extra > 0 ? (
					<span className="text-muted-foreground">
						{` ${tl("and {extra} more", { extra: String(extra) })}`}
					</span>
				) : null}
			</span>
		</span>
	);
}

/** A small uppercase-free section label, shared by the rail and detail. */
export function JobsSectionLabel({
	children,
	className,
	id,
}: {
	children: string;
	className?: string;
	id?: string;
}) {
	return (
		<h3
			className={cn(
				"font-medium font-sans text-muted-foreground text-xs",
				className
			)}
			id={id}
		>
			{children}
		</h3>
	);
}

const PROFILE_SIZE = {
	40: "size-10",
	48: "size-12",
	64: "size-16",
} as const;

const PRESENCE_SIZE = {
	40: "size-2.5 ring-2",
	48: "size-3 ring-2",
	64: "size-3.5 ring-[3px]",
} as const;

/**
 * A freelancer's profile picture at list and profile sizes, with a presence
 * dot while they are working (the marketplace "online now" convention).
 * Decorative: the name is always printed next to it.
 */
export function FreelancerAvatar({
	agent,
	size,
	surface = "ring-background",
}: {
	agent: InterfaceAgent;
	size: keyof typeof PROFILE_SIZE;
	/** Ring color matching the surface behind the avatar. */
	surface?: string;
}) {
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<span aria-hidden="true" className="relative shrink-0">
			<Avatar className={PROFILE_SIZE[size]}>
				{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
				<AvatarFallback
					appearance="artwork"
					className="overflow-hidden bg-muted"
				>
					<DitherAvatar animate={false} className="size-full" name={seed} />
				</AvatarFallback>
			</Avatar>
			{agent.status === "working" ? (
				<span
					className={cn(
						"absolute right-0 bottom-0 rounded-full bg-success",
						PRESENCE_SIZE[size],
						surface
					)}
				/>
			) : null}
		</span>
	);
}

/** "Working on a job" or "Available", in words, beside the presence dot. */
export function availabilityLabel(agent: InterfaceAgent): string {
	return agent.status === "working" ? "Working now" : "Available";
}
