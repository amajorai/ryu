// Spanish UI copy addresses the reader informally ("tú"): "Elige", "Vuelve a
// intentarlo", "Escribe". A formal "usted" form (an imperative such as
// "Elija" or "Escriba", or the pronoun itself) is a register slip.
import { expect, test } from "bun:test";
import es from "../locales/es.json" with { type: "json" };

/**
 * "usted", formal object-pronoun imperatives ("Complételos", "Inténtelo"),
 * and formal imperatives at the start of a sentence ("Elija un agente";
 * not the noun "Cierre de mes").
 */
const FORMAL =
	/\b(?:usted(?:es)?|Complételos|Complételo|Complétela|Vuelva a intentarlo|Inténtelo)\b|(?:^|[.!?:]\s+)(?:Elija|Escriba|Use|Seleccione|Haga clic|Introduzca|Ingrese|Pulse|Presione|Abra|Revise|Compruebe|Asegúrese|Espere|Intente|Inicie)\b/u;

/** Placeholder and tag tokens ({word}, <code>) are code, not Spanish. */
const formalText = (value: string) =>
	FORMAL.test(value.replace(/\{[^{}]*\}|<[^<>]*>/gu, "{}"));

test("Spanish UI copy uses the informal register", () => {
	const formal = Object.entries(es as Record<string, string>)
		.filter(([, value]) => formalText(value))
		.map(([source, value]) => `${source} → ${value}`);
	expect(formal).toEqual([]);
});

test("the guard recognizes formal forms and ignores nouns", () => {
	expect(formalText("Elija un agente compatible.")).toBe(true);
	expect(formalText("Elige un agente compatible.")).toBe(false);
	expect(formalText("No se completó. Vuelva a intentarlo.")).toBe(true);
	expect(formalText("No se completó. Vuelve a intentarlo.")).toBe(false);
	expect(formalText("Use <code>{x}</code> aquí. Complételos abajo.")).toBe(
		true
	);
	expect(formalText("Usa <code>{x}</code> aquí. Complétalos abajo.")).toBe(
		false
	);
	expect(formalText("Cierre de mes")).toBe(false);
});
