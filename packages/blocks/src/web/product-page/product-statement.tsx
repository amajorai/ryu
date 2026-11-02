"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { landingSectionClass } from "../landing-typography.ts";

// Western stops (and the Arabic question mark) need a following space; CJK
// full-width stops end a sentence on their own, so a translated statement
// still splits after its first one.
const LEAD_SENTENCE = /^(.+?(?:[.!?:؟](?=\s)|[。！？：]))(\s*.+)$/su;

/**
 * Splits a paragraph after its first sentence, so the lead can stand out. The
 * rest keeps the whitespace that followed the lead (none after a CJK stop).
 */
export function leadSentence(statement: string): [string, string] {
	const match = statement.match(LEAD_SENTENCE);
	return match ? [match[1] ?? statement, match[2] ?? ""] : [statement, ""];
}

/**
 * "What it is": one large paragraph, its first sentence in the foreground.
 * The statement is translated whole before it is split, so a catalog entry
 * for the full paragraph matches; the two halves are then the translation's.
 */
export function ProductStatement({ statement }: { statement: string }) {
	const tl = useLiteralMessages();
	const [lead, rest] = leadSentence(tl(statement));
	return (
		<section
			aria-labelledby="product-statement-heading"
			className={landingSectionClass}
			data-testid="product-statement"
		>
			<h2
				className="font-medium text-muted-foreground text-sm"
				id="product-statement-heading"
			>
				{tl("What it is")}
			</h2>
			<p className="mt-6 max-w-4xl text-balance font-heading font-medium text-2xl text-foreground leading-snug tracking-[-0.02em] md:text-3xl md:leading-snug">
				{lead}
				{rest ? <span className="text-muted-foreground">{rest}</span> : null}
			</p>
		</section>
	);
}
