import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { AgentActivity } from "@ryu/ui/components/agents/agent-activity";
import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { memo, useMemo } from "react";
import { z } from "zod";
import { useToolComplete } from "../hooks/use-tool-complete.ts";
import type { SourceType } from "../icons/source-icons.tsx";
import type { StepState, TimelineStep } from "../types/timeline.ts";
import { nativeSdkSchemaAdmits } from "../utils/native-sdk-admission.ts";
import {
	type NativeSdkValue,
	nativeSdkObjectSchema,
} from "../utils/native-sdk-observation.ts";
import {
	mapToolInvocationToStep,
	mapToolStateToStepState,
} from "../utils/tool-adapters.ts";

export interface SearchResult {
	date: string;
	source: SourceType;
	title: string;
}

export interface SearchGroupRichProps {
	/**
	 * Human-readable result text, used when the tool returns prose/markdown
	 * rather than a structured list (the common ACP WebSearch case). Shown in the
	 * panel body and — when there are no titled `results` — keeps the row from
	 * falsely claiming "0 results".
	 */
	bodyText?: string;
	defaultOpen?: boolean;
	onStepComplete: (id: string) => void;
	results?: SearchResult[];
	stepStates: Record<string, StepState>;
	toolSteps: Extract<TimelineStep, { type: "tool-call" }>[];
}

/** Truthful completion label for a finished search. */
function searchCompleteLabel(
	count: number,
	hasBody: boolean,
	tl: LiteralMessage
): string {
	if (count > 0) {
		return tl("Found {resultCount} results", {
			resultCount: formatNumber(count),
		});
	}
	if (hasBody) {
		return "Search complete";
	}
	return "No results";
}

export function SearchGroupRich({
	toolSteps,
	stepStates,
	onStepComplete,
	results = [],
	bodyText = "",
	defaultOpen,
}: SearchGroupRichProps) {
	const tl = useLiteralMessages();
	const anyAnimating = toolSteps.some((s) => stepStates[s.id] === "animating");
	const searchQuery =
		toolSteps.find((s) => s.searchQuery)?.searchQuery ?? "searching…";
	const totalResults = results.length;
	const hasResults = totalResults > 0;
	const hasBody = !hasResults && bodyText.trim().length > 0;

	function CompleteTracker({
		step,
	}: {
		step: Extract<TimelineStep, { type: "tool-call" }>;
	}) {
		useToolComplete(stepStates[step.id] === "animating", step.duration, () =>
			onStepComplete(step.id)
		);
		return null;
	}

	const items = useMemo(
		() => [
			{
				id: toolSteps.map((s) => s.id).join("-") || "search",
				type: "search" as const,
				query: searchQuery,
				results: hasResults
					? results.map((r, i) => ({
							id: `${r.title}-${i}`,
							title: r.title,
							domain: r.date || String(r.source),
						}))
					: undefined,
				moreCount: undefined,
			},
			...(hasBody
				? [
						{
							id: "search-body",
							type: "text" as const,
							content: bodyText,
						},
					]
				: []),
		],
		[toolSteps, searchQuery, hasResults, results, hasBody, bodyText]
	);

	return (
		<>
			{toolSteps.map((step) => (
				<CompleteTracker key={step.id} step={step} />
			))}
			<AgentActivity
				activeLabel="Searching the web…"
				collapseOnComplete={false}
				contentType="search"
				defaultOpen={defaultOpen}
				items={items}
				status={anyAnimating ? "working" : "complete"}
				summary={searchCompleteLabel(totalResults, hasBody, tl)}
			/>
		</>
	);
}

export interface SearchToolProps {
	defaultOpen?: boolean;
	part: {
		id?: string;
		toolCallId?: string;
		type?: string;
		state?: string;
		input?: NativeSdkValue;
		args?: NativeSdkValue;
		output?: NativeSdkValue;
		result?: NativeSdkValue;
	};
	results?: SearchResult[];
}

/** These optional cells describe the existing native member reads, including
 * primitive boxing and nullish optional chaining; no envelope/array DTO is parsed.
 */
interface NativeSearchOutputObservation {
	output?: NativeSdkValue;
	results?: NativeSdkValue;
}

// Markdown link: `[title](https://…)`. Declared at module scope so it isn't
// rebuilt per render; consumed via `matchAll`, which uses its own iterator.
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const WWW_PREFIX_RE = /^www\./;

/**
 * Unwrap the payload shapes WebSearch actually arrives in: Core's
 * `{ status, output }` envelope, ACP content-block arrays (`[{type,text}]`),
 * and plain strings — flattening them all to human-readable text.
 */
function toOutputText(value: NativeSdkValue): string {
	if (value == null) {
		return "";
	}
	if (isNativeText(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(toOutputText).filter(Boolean).join("\n");
	}
	if (nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)) {
		const obj = value;
		if (isNativeText(obj.text)) {
			return obj.text;
		}
		if (obj.output !== undefined) {
			return toOutputText(obj.output);
		}
		if (obj.content !== undefined) {
			return toOutputText(obj.content);
		}
		if (isNativeText(obj.result)) {
			return obj.result;
		}
	}
	return "";
}

/** Pull `[title](url)` markdown links out of result prose as titled results. */
function parseLinkResults(text: string): SearchResult[] {
	const out: SearchResult[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(MD_LINK_RE)) {
		const title = match[1]?.trim();
		const url = match[2]?.trim();
		if (!(title && url) || seen.has(url)) {
			continue;
		}
		seen.add(url);
		let host = url;
		try {
			host = new URL(url).hostname.replace(WWW_PREFIX_RE, "");
		} catch {
			// Leave `host` as the raw URL if it doesn't parse.
		}
		out.push({ title, source: host, date: "" });
	}
	return out;
}

/** Only these opaque result cells are observed; raw SDK arrays/receivers and
 * unrelated fields remain unchanged. This is not a decoded full tool DTO. */
interface NativeSearchResultObservation {
	readonly date?: NativeSdkValue;
	readonly source?: NativeSdkValue;
	readonly title?: NativeSdkValue;
}
const nativeSearchResultObservationSchema =
	z.custom<NativeSearchResultObservation>(isNativeObjectLike);

function normalizeResults(value: NativeSdkValue): SearchResult[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const parsed = value
		.map((item: NativeSdkValue) => {
			if (!nativeSdkSchemaAdmits(nativeSearchResultObservationSchema, item)) {
				return null;
			}
			const source = item.source;
			const title = item.title;
			const date = item.date;
			// title is required; source and date are optional (ACP results may omit them)
			if (!isNativeText(title)) {
				return null;
			}
			return {
				source: isNativeText(source) ? source : "",
				title,
				date: isNativeText(date) ? date : "",
			};
		})
		.filter((item): item is SearchResult => Boolean(item));
	return parsed.length > 0 ? parsed : undefined;
}

export const SearchTool = memo(function SearchTool({
	part,
	results,
	defaultOpen,
}: SearchToolProps) {
	const step = mapToolInvocationToStep(part.toolCallId ?? part.id ?? "search", {
		toolName: part.type?.replace("tool-", "") || "WebSearch",
		args: part.input ?? part.args ?? {},
		state:
			part.state === "output-available"
				? "result"
				: part.state === "input-streaming"
					? "partial-call"
					: "call",
		result: part.output ?? part.result,
	});
	const stepState = mapToolStateToStepState(
		part.state === "output-available"
			? "result"
			: part.state === "input-streaming"
				? "partial-call"
				: "call"
	);
	const stepStates = { [step.id]: stepState };
	const noop = () => {};

	// Prefer a structured, titled result list when one is present (mock/native or
	// an agent's raw_output). Otherwise fall back to the prose the tool returned:
	// unwrap the real payload to text and lift any markdown links into results,
	// keeping whatever remains as the panel body. This is what fixes the old
	// "Found 0 results" for ACP WebSearch, whose output is text, not `{results}`.
	// SAFETY: the optional-chain reads below retain the opaque SDK receivers and
	// native nil/boxing semantics. Only the results/output cells are observed;
	// neither their presence nor a decoded object/array value is asserted.
	const structured =
		results ??
		normalizeResults(
			(part.output as NativeSearchOutputObservation | undefined)?.results
		) ??
		normalizeResults(
			(part.result as NativeSearchOutputObservation | undefined)?.results
		) ??
		normalizeResults(
			(
				(part.output as NativeSearchOutputObservation | undefined)?.output as
					| NativeSearchOutputObservation
					| undefined
			)?.results
		) ??
		normalizeResults(
			(
				(part.result as NativeSearchOutputObservation | undefined)?.output as
					| NativeSearchOutputObservation
					| undefined
			)?.results
		);
	const bodyText = structured ? "" : toOutputText(part.output ?? part.result);
	const linked = structured ?? (bodyText ? parseLinkResults(bodyText) : []);

	return (
		<SearchGroupRich
			bodyText={bodyText}
			defaultOpen={defaultOpen}
			onStepComplete={noop}
			results={linked}
			stepStates={stepStates}
			toolSteps={[step]}
		/>
	);
});
