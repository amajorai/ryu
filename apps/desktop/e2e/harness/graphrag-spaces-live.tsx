import {
	type SpaceDocumentRow,
	type SpaceMatchRow,
	SpacesView,
} from "@ryu/blocks/desktop/spaces.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import {
	createSpace,
	deleteSpace,
	describeRetrievalModeChange,
	fetchDocuments,
	fetchSpaces,
	ingestDocument,
	type RetrievalMode,
	type RetrievalModeProgress,
	type Space,
	type SpaceDocument,
	type SpaceMatch,
	searchSpace,
	setSpaceRetrievalMode,
} from "../../src/lib/api/spaces.ts";
import "../../src/index.css";

const CORE_URL =
	import.meta.env.VITE_GRAPHRAG_CORE_URL ?? "http://127.0.0.1:17980";
const CORE_TOKEN = import.meta.env.VITE_GRAPHRAG_CORE_TOKEN ?? null;
const SPACE_NAME = "GraphRAG live proof";
const target: ApiTarget = { url: CORE_URL, token: CORE_TOKEN };
const VECTOR_DECOY_TOKENS = [
	"decoy2",
	"decoy17",
	"decoy22",
	"decoy31",
	"decoy39",
	"decoy147",
	"decoy161",
	"decoy169",
	"decoy172",
	"decoy194",
	"decoy244",
	"decoy253",
	"decoy266",
	"decoy301",
	"decoy309",
	"decoy363",
	"decoy374",
	"decoy381",
	"decoy389",
	"decoy392",
	"decoy424",
	"decoy442",
	"decoy451",
	"decoy459",
	"decoy507",
	"decoy510",
	"decoy521",
	"decoy529",
	"decoy554",
	"decoy565",
	"decoy590",
	"decoy598",
	"decoy604",
	"decoy613",
	"decoy662",
	"decoy671",
	"decoy679",
	"decoy684",
	"decoy693",
	"decoy734",
	"decoy741",
	"decoy749",
	"decoy752",
	"decoy846",
	"decoy873",
] as const;
const corpus = [
	{ title: "Alice and Acme", content: "Alice works at Acme." },
	{ title: "Acme location", content: "Acme is based in Paris." },
	{ title: "Paris landmark", content: "Paris has the Eiffel Tower." },
	...VECTOR_DECOY_TOKENS.map((token, index) => ({
		title: `Vector decoy ${index + 1}`,
		content: token,
	})),
];

function documentRow(document: SpaceDocument): SpaceDocumentRow {
	return {
		id: document.id,
		title: document.title,
		chunkCount: document.chunkCount,
		kind: document.kind,
		indexState: document.indexState ?? undefined,
		indexMessage: document.indexMessage ?? undefined,
		indexWarnings: document.indexWarnings,
	};
}

function matchRow(match: SpaceMatch): SpaceMatchRow {
	return { chunkId: match.chunkId, content: match.content };
}

function LiveGraphRagProof() {
	const [space, setSpace] = useState<Space | null>(null);
	const [documents, setDocuments] = useState<SpaceDocument[]>([]);
	const [loading, setLoading] = useState(true);
	const [fatalError, setFatalError] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SpaceMatch[] | null>(null);
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [retrievalBusy, setRetrievalBusy] = useState(false);
	const [retrievalError, setRetrievalError] = useState<string | null>(null);
	const [retrievalNotice, setRetrievalNotice] = useState<string | null>(null);
	const [retrievalProgress, setRetrievalProgress] =
		useState<RetrievalModeProgress | null>(null);

	const loadSpace = useCallback(async (spaceId: string): Promise<Space> => {
		const refreshed = (await fetchSpaces(target)).find(
			(candidate) => candidate.id === spaceId
		);
		if (!refreshed) {
			throw new Error("The seeded GraphRAG space disappeared from Core.");
		}
		setSpace(refreshed);
		return refreshed;
	}, []);

	useEffect(() => {
		let active = true;
		const bootstrap = async () => {
			try {
				const existing = (await fetchSpaces(target)).filter(
					(candidate) => candidate.name === SPACE_NAME && !candidate.system
				);
				for (const stale of existing) {
					await deleteSpace(target, stale.id);
				}
				const created = await createSpace(
					target,
					SPACE_NAME,
					"A deterministic live-Core GraphRAG traversal proof.",
					"vector"
				);
				for (const document of corpus) {
					await ingestDocument(
						target,
						created.id,
						document.title,
						document.content
					);
				}
				const [seededSpace, seededDocuments] = await Promise.all([
					fetchSpaces(target).then((spaces) =>
						spaces.find((candidate) => candidate.id === created.id)
					),
					fetchDocuments(target, created.id),
				]);
				if (!seededSpace) {
					throw new Error("Core did not return the newly seeded space.");
				}
				if (active) {
					setSpace(seededSpace);
					setDocuments(seededDocuments);
				}
			} catch (error) {
				if (active) {
					setFatalError(
						error instanceof Error ? error.message : "GraphRAG setup failed."
					);
				}
			} finally {
				if (active) {
					setLoading(false);
				}
			}
		};
		bootstrap().catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);

	const handleRetrievalModeChange = useCallback(
		async (mode: RetrievalMode) => {
			if (!space || retrievalBusy || space.retrievalMode === mode) {
				return;
			}
			setRetrievalBusy(true);
			setRetrievalError(null);
			setRetrievalNotice(null);
			setRetrievalProgress(null);
			try {
				const change = await setSpaceRetrievalMode(target, space.id, mode, {
					onProgress: setRetrievalProgress,
				});
				await loadSpace(space.id);
				setRetrievalNotice(describeRetrievalModeChange(change));
			} catch (error) {
				setRetrievalError(
					error instanceof Error
						? error.message
						: "The retrieval rebuild failed."
				);
			} finally {
				setRetrievalBusy(false);
			}
		},
		[loadSpace, retrievalBusy, space]
	);

	const handleSearch = useCallback(async () => {
		if (!(space && searchQuery.trim())) {
			return;
		}
		setSearchBusy(true);
		setSearchError(null);
		try {
			setSearchResults(
				await searchSpace(target, space.id, searchQuery.trim(), 10)
			);
		} catch (error) {
			setSearchError(
				error instanceof Error ? error.message : "The GraphRAG search failed."
			);
		} finally {
			setSearchBusy(false);
		}
	}, [searchQuery, space]);

	const detail = useMemo(() => {
		if (!space) {
			return null;
		}
		return {
			space,
			documents: documents.map(documentRow),
			searchQuery,
			searchResults: searchResults?.map(matchRow) ?? null,
			searchBusy,
			searchError,
			onSearchQueryChange: setSearchQuery,
			onSearchSubmit: handleSearch,
			onRetrievalModeChange: handleRetrievalModeChange,
			retrievalModeBusy: retrievalBusy,
			retrievalModeError: retrievalError,
			retrievalModeNotice: retrievalNotice,
			retrievalModeProgress: retrievalProgress,
		};
	}, [
		documents,
		handleRetrievalModeChange,
		handleSearch,
		retrievalBusy,
		retrievalError,
		retrievalNotice,
		retrievalProgress,
		searchBusy,
		searchError,
		searchQuery,
		searchResults,
		space,
	]);

	return (
		<main className="flex h-screen flex-col bg-background text-foreground">
			<header className="flex items-center justify-between border-b px-5 py-3">
				<div>
					<h1 className="font-semibold text-base">GraphRAG live Core proof</h1>
					<p className="text-muted-foreground text-xs">
						Real desktop API · isolated Core · deterministic embeddings
					</p>
				</div>
				<div className="flex items-center gap-2">
					{retrievalProgress?.state === "completed" ? (
						<Badge variant="outline">
							Connected graph ready · {retrievalProgress.processedChunks}/
							{retrievalProgress.totalChunks} chunks
						</Badge>
					) : null}
					<Badge variant={fatalError ? "destructive" : "secondary"}>
						{fatalError
							? "Core proof failed"
							: loading
								? "Seeding live Core…"
								: `Live Core seeded ${documents.length} documents`}
					</Badge>
				</div>
			</header>
			{fatalError ? (
				<div className="m-5 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-destructive text-sm">
					{fatalError}
				</div>
			) : (
				<div className="min-h-0 flex-1">
					<SpacesView
						detail={detail}
						loading={loading}
						spaces={space ? [space] : []}
					/>
				</div>
			)}
			<output
				className="sr-only"
				data-space-id={space?.id}
				data-testid="live-space-id"
			>
				{space?.id ?? ""}
			</output>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<LiveGraphRagProof />);
