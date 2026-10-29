// The Card Table's look settings (felt and deck), handed to the flat
// pieces drawn deep in the hand and the spread without threading props.

import { createContext, useContext } from "react";
import type { CardTableDeck, CardTableFelt } from "./card-table-palette.ts";

export interface CardTableLook {
	deck: CardTableDeck;
	felt: CardTableFelt;
}

export const CardTableLookContext = createContext<CardTableLook>({
	deck: "classic",
	felt: "classic",
});

/** The felt and deck the Card Table is drawn with (classic outside one). */
export function useCardTableLook(): CardTableLook {
	return useContext(CardTableLookContext);
}
