import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { relativeAge } from "./interface-renderer.ts";
import { QaAvatar, QaFacepile } from "./qa-avatar.tsx";
import { type QaQuestion, qaAbsoluteTime, qaNames } from "./qa-model.ts";

type ChunkTag = (chunks: ReactNode) => ReactNode;

/** A name in the byline: user content, so the page localizer leaves it alone. */
function nameTag(chunks: ReactNode): ReactNode {
	return (
		<span className="font-medium text-foreground" data-ryu-i18n="off">
			{chunks}
		</span>
	);
}

/** "You": the same weight as a name, but copy the catalog translates. */
function youTag(chunks: ReactNode): ReactNode {
	return <span className="font-medium text-foreground">{chunks}</span>;
}

/** The age in the byline, with the full time on hover. */
function timeTag(iso: string): ChunkTag {
	return (chunks) => (
		<time dateTime={iso} title={qaAbsoluteTime(iso)}>
			{chunks}
		</time>
	);
}

function toneTag(className: string): ChunkTag {
	return (chunks) => <span className={className}>{chunks}</span>;
}

/** One byline sentence, kept whole so it flows as a single run of text. */
function Sentence({ children }: { children: ReactNode }) {
	return <span className="min-w-0 truncate">{children}</span>;
}

/**
 * Who said the newest thing, in Quora's byline shape: faces, then one whole
 * sentence ("Ada answered 5m ago", "You asked 2h ago"), so every language
 * keeps its own word order. Failed and live runs say so in their status tone.
 */
export function QaByline({
	now,
	question,
}: {
	now: number;
	question: QaQuestion;
}) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const { answerers, byline, thread } = question;
	const listed = qaNames(answerers);
	const names = listed || tl("An agent");
	const ago = relativeAge(thread.updatedAt, now);
	const time = timeTag(thread.updatedAt);
	let faces: ReactNode = <QaFacepile agents={answerers} />;
	let text: ReactNode;
	switch (byline) {
		case "answered":
			text = (
				<Sentence>
					{tlRich(
						"<name>{names}</name> answered <time>{ago}</time>",
						{ ago, names },
						{ name: nameTag, time }
					)}
				</Sentence>
			);
			break;
		case "answering":
			text = (
				<Sentence>
					{tlRich(
						"<name>{names}</name> <live>is answering</live>",
						{ names },
						{ live: toneTag("text-status-success"), name: nameTag }
					)}
				</Sentence>
			);
			break;
		case "failed":
			text = (
				<>
					<Sentence>
						{tlRich(
							"<name>{names}</name>: <failed>run failed</failed>",
							{ names },
							{
								failed: toneTag("font-medium text-status-destructive"),
								name: nameTag,
							}
						)}
					</Sentence>
					<span aria-hidden="true">·</span>
					{time(ago)}
				</>
			);
			break;
		default: {
			faces = <QaAvatar agent={null} size={20} />;
			let after: ReactNode = null;
			if (byline !== "asked") {
				after = <span>{tl("No answers yet")}</span>;
			} else if (listed) {
				after = (
					<span className="truncate" data-ryu-i18n="off">
						{tl("Waiting on {names}", { names: listed })}
					</span>
				);
			}
			text = (
				<>
					<Sentence>
						{tlRich(
							"<you>You</you> asked <time>{ago}</time>",
							{ ago },
							{ time, you: youTag }
						)}
					</Sentence>
					{after ? (
						<>
							<span aria-hidden="true">·</span>
							{after}
						</>
					) : null}
				</>
			);
		}
	}
	return (
		<div className="flex h-6 min-w-0 items-center gap-2 text-muted-foreground text-sm">
			{faces}
			<span className="flex min-w-0 items-center gap-1 truncate">{text}</span>
		</div>
	);
}
