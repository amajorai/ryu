import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type BrowserAnnotation,
	BrowserAnnotationSurface,
	type BrowserContextResult,
	type BrowserElementContext,
	type BrowserRect,
} from "../../src/components/panels/BrowserAnnotationSurface.tsx";
import "../../src/index.css";

const viewport = { height: 900, scroll_x: 0, scroll_y: 0, width: 1440 };

const ctaTarget: BrowserElementContext = {
	attributes: { class: "button button-primary", type: "button" },
	computed_styles: {
		backgroundColor: "rgb(43, 93, 255)",
		borderRadius: "12px",
		color: "rgb(255, 255, 255)",
		fontSize: "16px",
	},
	component: "PricingHero",
	content_preview: "Start building",
	name: "Start building",
	rect: { height: 54, width: 210, x: 150, y: 550 },
	role: "button",
	selector: "main .hero-actions > button",
	tag: "button",
	text: "Start building",
	xpath: "/html/body/main/section[1]/div[2]/button[1]",
};

const existingAnnotation: BrowserAnnotation = {
	comment:
		"Give the hero more breathing room and make the primary action easier to spot.",
	created_at: "2026-08-19T00:00:00.000Z",
	id: "annotation-existing",
	kind: "area",
	rect: { height: 180, width: 720, x: 110, y: 225 },
	style: { background_color: "#eef2ff", padding: "24px" },
	targets: [ctaTarget],
};

const initialContext: BrowserContextResult = {
	annotations: [existingAnnotation],
	page: {
		id: "proof-tab",
		title: "Ryu Studio — build better together",
		url: "https://studio.example.test/landing",
	},
	snapshot: {
		elements: [
			{
				depth: 0,
				name: "Ryu Studio — build better together",
				ref: "ax-1",
				role: "document",
			},
			{ depth: 1, name: "Start building", ref: "ax-2", role: "button" },
		],
		snapshot_id: "snapshot-proof",
		tab: {
			id: "proof-tab",
			title: "Ryu Studio — build better together",
			url: "https://studio.example.test/landing",
		},
		truncated: false,
	},
	viewport,
};

const previewImage = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">
  <rect width="1440" height="900" fill="#f8fafc"/>
  <rect width="1440" height="76" fill="#ffffff"/>
  <path d="M0 76H1440" stroke="#e2e8f0"/>
  <circle cx="76" cy="38" r="18" fill="#2b5dff"/>
  <path d="M68 38h16M76 30v16" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <text x="112" y="45" fill="#0f172a" font-family="Inter,Arial,sans-serif" font-size="22" font-weight="700">Ryu Studio</text>
  <text x="1030" y="44" fill="#64748b" font-family="Inter,Arial,sans-serif" font-size="15">Product</text>
  <text x="1114" y="44" fill="#64748b" font-family="Inter,Arial,sans-serif" font-size="15">Templates</text>
  <rect x="1260" y="18" width="120" height="40" rx="10" fill="#0f172a"/>
  <text x="1282" y="44" fill="#fff" font-family="Inter,Arial,sans-serif" font-size="14" font-weight="600">Sign in</text>
  <rect x="110" y="168" width="1220" height="600" rx="28" fill="#ffffff"/>
  <text x="150" y="270" fill="#64748b" font-family="Inter,Arial,sans-serif" font-size="16" font-weight="600" letter-spacing="2">THE CALM WAY TO SHIP</text>
  <text x="150" y="340" fill="#0f172a" font-family="Inter,Arial,sans-serif" font-size="62" font-weight="750">Build the next</text>
  <text x="150" y="410" fill="#2b5dff" font-family="Inter,Arial,sans-serif" font-size="62" font-weight="750">great thing.</text>
  <text x="150" y="500" fill="#64748b" font-family="Inter,Arial,sans-serif" font-size="20">A focused workspace for turning ideas into useful products.</text>
  <rect x="150" y="550" width="210" height="54" rx="12" fill="#2b5dff"/>
  <text x="194" y="584" fill="#ffffff" font-family="Inter,Arial,sans-serif" font-size="16" font-weight="700">Start building</text>
  <rect x="380" y="550" width="148" height="54" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>
  <text x="412" y="584" fill="#334155" font-family="Inter,Arial,sans-serif" font-size="16" font-weight="600">See how it works</text>
  <rect x="790" y="258" width="440" height="350" rx="20" fill="#eef2ff"/>
  <rect x="830" y="300" width="360" height="20" rx="10" fill="#c7d2fe"/>
  <rect x="830" y="344" width="280" height="16" rx="8" fill="#dbeafe"/>
  <rect x="830" y="392" width="300" height="16" rx="8" fill="#dbeafe"/>
  <rect x="830" y="466" width="140" height="48" rx="12" fill="#ffffff"/>
  <text x="862" y="496" fill="#475569" font-family="Inter,Arial,sans-serif" font-size="14" font-weight="600">Preview</text>
  <text x="150" y="704" fill="#94a3b8" font-family="Inter,Arial,sans-serif" font-size="14">Live preview · 1440 × 900 · embedded browser context</text>
</svg>
`)}`;

function nextSelection(
	selections: BrowserRect[]
): BrowserContextResult["selection"] {
	const rect = selections.reduce<BrowserRect>(
		(current, selection) => ({
			height:
				Math.max(current.y + current.height, selection.y + selection.height) -
				current.y,
			width:
				Math.max(current.x + current.width, selection.x + selection.width) -
				current.x,
			x: Math.min(current.x, selection.x),
			y: Math.min(current.y, selection.y),
		}),
		selections[0] ?? { height: 0, width: 0, x: 0, y: 0 }
	);
	return {
		rect,
		targets: selections.map((selection, index) => ({
			...ctaTarget,
			name: index === 0 ? "Selected hero area" : "Secondary target",
			rect: selection,
			selector: index === 0 ? ctaTarget.selector : "main .hero-actions > a",
		})),
	};
}

function Story() {
	const [context, setContext] = useState(initialContext);
	const [isAnnotating, setIsAnnotating] = useState(true);

	const handleContext = async (selections: BrowserRect[]) => {
		const selection = nextSelection(selections);
		const next = { ...context, selection };
		setContext(next);
		return next;
	};

	const handleAnnotate = async (input: {
		comment: string;
		kind: BrowserAnnotation["kind"];
		rect: BrowserRect;
		selections?: BrowserRect[];
		style?: BrowserAnnotation["style"];
	}) => {
		const annotation: BrowserAnnotation = {
			...input,
			created_at: new Date().toISOString(),
			id: `annotation-${context.annotations.length + 1}`,
			targets: context.selection?.targets ?? [],
		};
		setContext((current) => ({
			...current,
			annotations: [...current.annotations, annotation],
			selection: undefined,
		}));
		return annotation;
	};

	return (
		<main className="min-h-screen bg-muted px-6 py-8 text-foreground">
			<div className="mx-auto flex h-[900px] max-w-[1220px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
				<header className="flex shrink-0 items-center justify-between border-border border-b px-5 py-4">
					<div>
						<p className="font-semibold text-foreground text-sm">
							Embedded browser
						</p>
						<p className="text-muted-foreground text-xs">
							{context.page.title} · context bridge connected
						</p>
					</div>
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<span className="size-2 rounded-full bg-success" />
						Live tab
					</div>
				</header>
				<div className="min-h-0 flex-1">
					<BrowserAnnotationSurface
						context={context}
						imageUrl={previewImage}
						isAnnotating={isAnnotating}
						onAnnotate={handleAnnotate}
						onAskRyu={() => undefined}
						onClearAnnotations={async () =>
							setContext((current) => ({ ...current, annotations: [] }))
						}
						onContext={handleContext}
						onDeleteAnnotation={async (id) =>
							setContext((current) => ({
								...current,
								annotations: current.annotations.filter(
									(annotation) => annotation.id !== id
								),
							}))
						}
						onToggleAnnotating={() => setIsAnnotating((current) => !current)}
					/>
				</div>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
