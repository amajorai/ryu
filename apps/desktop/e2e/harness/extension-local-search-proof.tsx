import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type LocalSearchDocument,
	LocalSearchIndex,
	type LocalSearchSuggestion,
	toLocalSearchSuggestion,
} from "../../../../apps/extension/lib/local-search.ts";
import {
	SmartBar,
	type SmartBarSuggestion,
} from "../../../../packages/blocks/src/extension/smart-bar.tsx";
import "./extension-local-search-proof.css";
import styles from "./extension-local-search-proof.module.css";

const PROOF_DOCUMENTS: LocalSearchDocument[] = [
	{
		favorite: false,
		id: "conversation:rust-guide",
		kind: "conversation",
		searchText: "Rust browser extension guide Agent builder conversation",
		subtitle: "Agent builder",
		tags: ["conversation", "agent:builder"],
		title: "Rust browser extension guide",
		updatedAt: 30,
		url: "",
	},
	{
		favorite: false,
		id: "conversation:product-research",
		kind: "conversation",
		searchText: "Product research notes Agent researcher conversation",
		subtitle: "Agent researcher",
		tags: ["conversation", "agent:researcher"],
		title: "Product research notes",
		updatedAt: 20,
		url: "",
	},
	{
		favorite: false,
		id: "bookmark:rust-docs",
		kind: "bookmark",
		searchText: "Rust docs Development https://example.com/rust bookmark",
		subtitle: "Development",
		tags: ["bookmark", "folder:Development"],
		title: "Rust docs",
		updatedAt: 10,
		url: "https://example.com/rust",
	},
];

function LocalSearchProof() {
	const index = useMemo(() => new LocalSearchIndex(), []);
	const searchSequence = useRef(0);
	const [status, setStatus] = useState<"idle" | "loading" | "ready">("loading");
	const [suggestions, setSuggestions] = useState<LocalSearchSuggestion[]>([]);
	const [resultCount, setResultCount] = useState(0);
	const [facetSummary, setFacetSummary] = useState("none");
	const [selection, setSelection] = useState("No local result selected");

	useEffect(() => {
		void index.replace(PROOF_DOCUMENTS).then(() => setStatus("ready"));
	}, [index]);

	const onValueChange = useCallback(
		(value: string): void => {
			const sequence = searchSequence.current + 1;
			searchSequence.current = sequence;
			if (value.trim().length < 2) {
				setSuggestions([]);
				setResultCount(0);
				setFacetSummary("none");
				setStatus("idle");
				return;
			}
			setStatus("loading");
			void index
				.search({
					facets: { kind: { limit: 4, sort: "DESC" } },
					groupBy: { maxResult: 3, properties: ["kind"] },
					limit: 8,
					term: value.trim(),
					tolerance: 1,
				})
				.then((result) => {
					if (sequence !== searchSequence.current) {
						return;
					}
					setSuggestions(result.hits.map(toLocalSearchSuggestion));
					setResultCount(result.count);
					setFacetSummary(
						Object.entries(result.facets?.kind?.values ?? {})
							.map(([kind, count]) => `${kind}:${count}`)
							.join(" · ") || "none"
					);
					setStatus("ready");
				});
		},
		[index]
	);

	const onSelectSuggestion = useCallback(
		(suggestion: SmartBarSuggestion): void => {
			setSelection(`Selected: ${suggestion.title} (${suggestion.kind})`);
		},
		[]
	);

	return (
		<section
			className={styles.localSearchCard}
			data-testid="local-search-proof"
		>
			<div className={styles.localSearchHeading}>
				<div>
					<p className={styles.localSearchKicker}>Extension capability</p>
					<h2>Local search parity</h2>
				</div>
				<span className={styles.localSearchBadge}>Orama · metadata only</span>
			</div>
			<p className={styles.localSearchCopy}>
				Searches conversation titles and browser-bookmark metadata locally with
				fuzzy matching, field boosts, filters, facets, sorting, and grouped
				results.
			</p>
			<SmartBar
				embedded
				onExecute={() => setSelection("Route fallback selected")}
				onSelectSuggestion={onSelectSuggestion}
				onValueChange={onValueChange}
				suggestionStatus={status}
				suggestions={suggestions}
			/>
			<div
				aria-label="Local search metrics"
				className={styles.localSearchMetrics}
			>
				<span>
					<strong data-testid="local-search-count">{resultCount}</strong>{" "}
					matches
				</span>
				<span>
					<strong data-testid="local-search-facets">{facetSummary}</strong>{" "}
					facets
				</span>
			</div>
			<p
				className={styles.localSearchSelection}
				data-testid="local-search-selection"
			>
				{selection}
			</p>
		</section>
	);
}

function Proof() {
	return (
		<main className={styles.localSearchProofShell}>
			<header className={styles.localSearchProofHeader}>
				<p className={styles.localSearchKicker}>RYU · BROWSER EXTENSION</p>
				<h1>Search your Ryu library without leaving the tab</h1>
				<p>
					A rendered proof of the local Orama-backed projection and
					keyboard-first SmartBar result flow.
				</p>
			</header>
			<LocalSearchProof />
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
