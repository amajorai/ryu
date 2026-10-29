import { cn } from "@ryu/ui/lib/utils.ts";
import { IconAt } from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";
import styles from "./elements-one.module.css";
import type { MentionItem } from "./types.ts";

const SAFE_MENTION_COLOR =
	/^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^()]{1,96}\)|[a-z]{1,24})$/i;

function safeMentionColor(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && SAFE_MENTION_COLOR.test(trimmed) ? trimmed : undefined;
}

interface MentionAccentStyle extends CSSProperties {
	"--mention-accent"?: string;
}

export interface MentionTokenProps {
	children: ReactNode;
	className?: string;
	item?: MentionItem;
}

/** The shared inline treatment for composer and transcript mentions. */
export function MentionToken({ children, className, item }: MentionTokenProps) {
	const accent = safeMentionColor(item?.accentColor);
	const hasAccent = Boolean(accent);
	const icon = item?.visualIcon ?? item?.icon;

	return (
		<span
			className={cn(
				styles.mention,
				"inline-flex max-w-full items-center gap-1 align-baseline font-medium leading-tight transition-colors",
				hasAccent ? styles.mentionAccent : "text-primary",
				className
			)}
			data-mention-token={item?.kind ?? "reference"}
			style={
				{
					"--mention-accent": accent,
				} satisfies MentionAccentStyle as MentionAccentStyle
			}
		>
			<span
				aria-hidden="true"
				className="inline-flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5"
			>
				{icon ?? <IconAt className="size-3.5" />}
			</span>
			<span className="min-w-0 truncate">{children}</span>
		</span>
	);
}
