import {
	type I18nHostSnapshot,
	I18nRuntime,
	type LanguagePack,
	messageIdForLiteral,
} from "@ryu/i18n";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
const remote = new URLSearchParams(location.search).has("host");
let calls = 0;
let visitedTextNodes = 0;
let stableVisits = 0;
const visit = (node: Node) => {
	if (node.nodeType !== 3) {
		return;
	}
	visitedTextNodes += 1;
	if (node.textContent?.startsWith("Stable label")) {
		stableVisits += 1;
	}
};
const createWalker = document.createTreeWalker.bind(document);
document.createTreeWalker = (
	...args: Parameters<Document["createTreeWalker"]>
) => {
	const walker = createWalker(...args);
	visit(args[0]);
	const next = walker.nextNode.bind(walker);
	walker.nextNode = () => {
		const node = next();
		if (node) {
			visit(node);
		}
		return node;
	};
	return walker;
};
const translate = I18nRuntime.prototype.translate;
I18nRuntime.prototype.translate = function (
	this: I18nRuntime,
	...args: Parameters<I18nRuntime["translate"]>
) {
	calls += 1;
	return translate.apply(this, args);
};
let hostChange: (snapshot: I18nHostSnapshot) => void = () => {};
const remoteCalls: ((value: string) => void)[] = [];
const snapshot = (id: string, version = "1"): I18nHostSnapshot => ({
	packId: id,
	packName: id,
	packVersion: version,
	locale: "en",
	direction: "ltr",
});
if (remote) {
	Reflect.set(window, "ryu", {
		i18n: {
			get: async () => snapshot("remote-a"),
			subscribe: (options: { onChange: typeof hostChange }) => {
				hostChange = options.onChange;
				return { dispose: () => {} };
			},
			translate: (input: { defaultMessage: string }) =>
				input.defaultMessage === "Alpha label"
					? new Promise<string>((resolve) => remoteCalls.push(resolve))
					: Promise.resolve(input.defaultMessage),
		},
	});
}
const localizerProof = {
	reset: () => {
		calls = 0;
		visitedTextNodes = 0;
		stableVisits = 0;
	},
	calls: () => calls,
	visitedTextNodes: () => visitedTextNodes,
	stableVisits: () => stableVisits,
	remoteCount: () => remoteCalls.length,
	changeHost: (id: string, version = "1") => hostChange(snapshot(id, version)),
	resolveRemote: (index: number, value: string) => remoteCalls[index](value),
};
Reflect.set(window, "localizerProof", localizerProof);
export type LocalizerProof = typeof localizerProof;
declare global {
	interface Window {
		localizerProof: LocalizerProof;
	}
}
const pack = (revision: number): LanguagePack => ({
	schemaVersion: 1,
	id: "test-pack",
	name: "Fixture voice",
	version: `${revision}.0.0`,
	locale: "en",
	baseLocale: "en",
	direction: "ltr",
	enabled: true,
	messages: {
		[messageIdForLiteral("Alpha label")]:
			revision === 1 ? "Translated alpha" : "Updated alpha",
		[messageIdForLiteral("Beta label")]: "Translated beta",
	},
});
function SourceLanguage() {
	const i18n = useI18n();
	return (
		<button onClick={() => i18n.selectPack(null)} type="button">
			Use source language
		</button>
	);
}
function Story() {
	const [revision, setRevision] = useState(1);
	const [temporary, setTemporary] = useState(true);
	return (
		<I18nProvider
			initialLocale="en"
			initialPackId={remote ? null : "test-pack"}
			packs={remote ? [] : [pack(revision)]}
		>
			<main className="min-h-screen bg-background p-8 text-foreground">
				<div className="mb-6 flex flex-wrap gap-4" data-ryu-i18n="off">
					<button
						onClick={() => {
							document.getElementById("primary")!.firstChild!.textContent =
								"Beta label";
						}}
						type="button"
					>
						Change literal
					</button>
					<button
						onClick={() =>
							document
								.getElementById("attribute")!
								.setAttribute("title", "Beta label")
						}
						type="button"
					>
						Change attribute
					</button>
					<button
						onClick={() => {
							const button = document.createElement("button");
							button.textContent = "Alpha label";
							button.title = "Beta label";
							document.getElementById("dynamic")!.append(button);
						}}
						type="button"
					>
						Add subtree
					</button>
					<button
						onClick={() =>
							document
								.getElementById("excluded")!
								.removeAttribute("data-ryu-i18n")
						}
						type="button"
					>
						Remove opt out
					</button>
					<button onClick={() => setRevision(2)} type="button">
						Update pack
					</button>
					<SourceLanguage />
					<button onClick={() => setTemporary(false)} type="button">
						Remove temporary node
					</button>
				</div>
				<section className="space-y-4 rounded-2xl border p-6">
					<p id="primary">Alpha label</p>
					{remote ? null : (
						<>
							<button id="attribute" title="Alpha label" type="button">
								Alpha label
							</button>
							<div id="dynamic" />
							<section data-ryu-i18n="off" id="excluded">
								<p>Alpha label</p>
							</section>
							<div contentEditable suppressContentEditableWarning>
								Beta label
							</div>
							{temporary ? <p key="temporary">Temporary label</p> : null}
							{Array.from({ length: 200 }, (_, index) => (
								<p key={index}>Stable label {index}</p>
							))}
						</>
					)}
				</section>
			</main>
		</I18nProvider>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
