import { describe, expect, it } from "bun:test";
import {
	dialogProviderLabelTables,
	GATEWAY_PROVIDERS_RS,
	gatewayDialogTsx,
	gatewayProvidersRs,
	poolsEditorLabelEntries,
	rustBlock,
} from "./gateway-test-support.ts";

describe("the modality editor is wired into the routing card", () => {
	it("saves through withModalityMapping rather than its own literal", () => {
		expect(gatewayDialogTsx).toContain("withModalityMapping(cfg.routing,");
	});

	it("reads the map presence off the served config", () => {
		expect(gatewayDialogTsx).toContain(
			"routingViewIncludesModalityMap(config)"
		);
	});

	it("treats not-yet-loaded as a third state, not as not-served", () => {
		// `config` is null while the fetch is in flight AND whenever the gateway is
		// unreachable (the fetch effect returns early on `!reachable`). Folding
		// either into `served === false` would render the "this gateway does not
		// report its modality map" warning — an accusation that a healthy, current
		// node is about to drop a hand-written `[routing.modality_map]` — on every
		// dialog open. The ternary keeps the three states apart and the render site
		// drops the whole block for the null one.
		expect(gatewayDialogTsx).toContain(
			"config === null ? null : routingViewIncludesModalityMap(config)"
		);
		expect(gatewayDialogTsx).toContain(
			"{modalityMapServed === null ? null : ("
		);
	});

	it("offers the node's UNFILTERED provider list, not the ProviderKind subset", () => {
		// The crossed-unit defect this row set had to avoid. `RoutingCard` derives
		// `providers` as `configuredProviders.filter((p) => p in PROVIDER_LABELS)`,
		// and `PROVIDER_LABELS` is `Record<ProviderKind, string>` — a union that has
		// no `modal` / `replicate` / `fal`. Passing that filtered list here would
		// have shipped an editor that cannot select the providers it exists to
		// select. It must receive `configuredProviders` itself.
		const rows = gatewayDialogTsx.slice(
			gatewayDialogTsx.indexOf("<ModalityRoutingRows")
		);
		const usage = rows.slice(0, rows.indexOf("/>"));
		expect(usage).toContain("configuredProviders={configuredProviders}");
		expect(usage).not.toContain("configuredProviders={providers}");
	});

	it("labels every provider id the gateway registry can report", () => {
		// The ids come from the gateway's own registration-order test, so this fails
		// when a provider is added there and the desktop would render its raw id.
		const registryOrder = rustBlock(
			gatewayProvidersRs,
			GATEWAY_PROVIDERS_RS,
			"    fn every_configured_builtin_registers_in_deterministic_order"
		);
		// Ids may carry a hyphen (`openai-credits`), so the pattern must not stop
		// at `\w`: a hyphenated id the registry reports still needs a label.
		const ids = [...registryOrder.matchAll(/^\s{16}"([\w-]+)",$/gm)].map(
			(m) => m[1]
		);
		expect(ids).toContain("fal");
		expect(ids).toContain("replicate");
		expect(ids).toContain("modal");
		expect(ids).toContain("kiro");
		expect(ids).toContain("openai-credits");
		// `MODALITY_PROVIDER_LABELS` spreads `PROVIDER_LABELS` in, so the six
		// `ProviderKind` ids are covered by that spread and the literal only has to
		// name the rest: search the union of both literals.
		const labels = dialogProviderLabelTables();
		for (const id of ids) {
			expect({
				id,
				labelled: new RegExp(`^\\t+(?:${id}|"${id}"): "[^"]+",$`, "m").test(
					labels
				),
			}).toEqual({ id, labelled: true });
		}
		// Scope: this reads the builtin ids of the registration-order test only.
		// SDK-route ids (`genai-openai`, `genai-groq`, ...) are registered at
		// runtime from the `genai.accounts` map, so there is no closed list here to
		// check; the editors show them under their raw id (recorded as an open item
		// in docs/test-coverage-cloud-results/ultracode/gateway-donated-credits.md).
	});

	it("names the donated OpenAI credits provider apart from OpenAI, in the same words in both editors", () => {
		// `openai-credits` is a second OpenAI id with its own spend. A label that is
		// merely present would still pass if it were the raw id or a bare "OpenAI",
		// which erases the distinction the label exists to draw, so pin the text.
		const donated = "OpenAI (donated credits)";
		const modality = gatewayDialogTsx.match(
			/^\t+"openai-credits": "([^"]+)",$/m
		)?.[1];
		const pools = poolsEditorLabelEntries().find(
			([id]) => id === "openai-credits"
		)?.[1];
		expect({ modality, pools }).toEqual({ modality: donated, pools: donated });
	});

	it("keeps every provider label the Provider pools editor names identical to the dialog's", () => {
		// The pools editor keeps its own short table, so a label changed in the
		// dialog (or added to one table only) would drift apart silently.
		const dialogLabels = dialogProviderLabelTables();
		const entries = poolsEditorLabelEntries();
		expect(entries.length).toBeGreaterThan(0);
		for (const [id, label] of entries) {
			const dialog = new RegExp(
				`^\\t+(?:${id}|"${id}"): "([^"]+)",$`,
				"m"
			).exec(dialogLabels)?.[1];
			expect({ id, dialog }).toEqual({ id, dialog: label });
		}
	});
});

describe("the guardrails save is wired to a fresh read", () => {
	it("compares the guardrail sections before writing with the read's revision", () => {
		expect(gatewayDialogTsx).toContain(
			"sameGuardrailSections(config, current)"
		);
		expect(gatewayDialogTsx).toContain(
			"expectedRevision: current.configRevision ?? undefined"
		);
		expect(gatewayDialogTsx).toContain(
			"withRoutingDraftEdits(cfg.routing, config, draft)"
		);
	});
});
