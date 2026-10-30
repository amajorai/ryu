import { useDataGridEffects } from "@ryu/ui/hooks/use-data-grid-effects.ts";
import { useDataGridFill } from "@ryu/ui/hooks/use-data-grid-fill.ts";
import { useDataGridHistory } from "@ryu/ui/hooks/use-data-grid-history.ts";
import { useDataGridKeyboard } from "@ryu/ui/hooks/use-data-grid-keyboard.ts";
import { useDataGridLayout } from "@ryu/ui/hooks/use-data-grid-layout.ts";
import type { UseDataGridProps } from "@ryu/ui/hooks/use-data-grid-model.ts";
import { useDataGridNavigation } from "@ryu/ui/hooks/use-data-grid-navigation.ts";
import { useDataGridPaste } from "@ryu/ui/hooks/use-data-grid-paste.ts";
import { useDataGridPointer } from "@ryu/ui/hooks/use-data-grid-pointer.ts";
import { useDataGridResult } from "@ryu/ui/hooks/use-data-grid-result.ts";
import { useDataGridSelection } from "@ryu/ui/hooks/use-data-grid-selection.ts";
import { useDataGridState } from "@ryu/ui/hooks/use-data-grid-state.ts";
import { useDataGridTable } from "@ryu/ui/hooks/use-data-grid-table.ts";
import { useDataGridVirtualizer } from "@ryu/ui/hooks/use-data-grid-virtualizer.ts";

function useDataGrid<TData>(props: UseDataGridProps<TData>) {
	const gridState = useDataGridState(props);
	const gridSelection = useDataGridSelection(gridState);
	const gridPaste = useDataGridPaste(gridSelection);
	const gridNavigation = useDataGridNavigation(gridPaste);
	const gridFill = useDataGridFill(gridNavigation);
	const gridHistory = useDataGridHistory(gridFill);
	const gridPointer = useDataGridPointer(gridHistory);
	const gridTable = useDataGridTable(gridPointer);
	const gridVirtualizer = useDataGridVirtualizer(gridTable);
	const gridKeyboard = useDataGridKeyboard(gridVirtualizer);
	const gridEffects = useDataGridEffects(gridKeyboard);
	const gridLayout = useDataGridLayout(gridEffects);
	return useDataGridResult(gridLayout);
}

export { type UseDataGridProps, useDataGrid };
