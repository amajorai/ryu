/**
 * The "How to set this up" steps of the Integrations tab. Each step that links
 * out is one rich message with the link inside, so translators can move it.
 */
import { type RichTags, useRichLiteralMessages } from "@ryu/i18n/react";

/** The `<a>` tag of a setup step: an external link that opens in a new tab. */
function externalLink(href: string): RichTags {
	return {
		a: (chunks) => (
			<a
				className="underline hover:text-foreground"
				href={href}
				rel="noopener noreferrer"
				target="_blank"
			>
				{chunks}
			</a>
		),
	};
}

/** Getting a Hugging Face token for gated model downloads. */
export function HuggingFaceSetupSteps() {
	const tlRich = useRichLiteralMessages();
	return (
		<ol className="list-decimal space-y-1 ps-4 pb-1 text-muted-foreground text-xs">
			<li>
				{tlRich(
					"Create a token at <a>huggingface.co/settings/tokens</a>. A <code>read</code> token is enough.",
					{},
					{
						...externalLink("https://huggingface.co/settings/tokens"),
						code: (chunks) => <code>{chunks}</code>,
					}
				)}
			</li>
			<li>Paste it above and click Save.</li>
			<li>
				For each gated model, open its Hugging Face page and accept the model's
				terms first. A token alone does not unlock a gated download.
			</li>
		</ol>
	);
}

/** Getting an Artificial Analysis key for model stats. */
export function ArtificialAnalysisSetupSteps() {
	const tlRich = useRichLiteralMessages();
	return (
		<ol className="list-decimal space-y-1 ps-4 pb-1 text-muted-foreground text-xs">
			<li>
				{tlRich(
					"Create a free key at <a>artificialanalysis.ai/api-reference</a>.",
					{},
					externalLink("https://artificialanalysis.ai/api-reference")
				)}
			</li>
			<li>Paste it above and click Save.</li>
			<li>
				Stats appear on model detail pages in the catalog when a model matches
				an Artificial Analysis entry.
			</li>
		</ol>
	);
}

/** Connecting Composio apps and attaching them to agents. */
export function ComposioSetupSteps() {
	const tlRich = useRichLiteralMessages();
	return (
		<ol className="list-decimal space-y-1 ps-4 pb-1 text-muted-foreground text-xs">
			<li>
				{tlRich(
					"Open this device's settings → API keys and paste your Composio API key (create one at <a>platform.composio.dev</a>).",
					{},
					externalLink("https://platform.composio.dev")
				)}
			</li>
			<li>
				Go to Marketplace → Connections to connect the apps you want (Gmail,
				GitHub, …).
			</li>
			<li>
				Open an agent in the editor → Connections to attach connected toolkits,
				choosing all tools or specific ones.
			</li>
		</ol>
	);
}
