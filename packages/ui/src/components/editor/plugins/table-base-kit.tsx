import {
	BaseTableCellHeaderPlugin,
	BaseTableCellPlugin,
	BaseTablePlugin,
	BaseTableRowPlugin,
} from "@platejs/table";

import {
	TableCellElementStatic,
	TableCellHeaderElementStatic,
	TableElementStatic,
	TableRowElementStatic,
} from "@ryu/ui/components/editor/ui/table-node-static.tsx";

export const BaseTableKit = [
	BaseTablePlugin.withComponent(TableElementStatic),
	BaseTableRowPlugin.withComponent(TableRowElementStatic),
	BaseTableCellPlugin.withComponent(TableCellElementStatic),
	BaseTableCellHeaderPlugin.withComponent(TableCellHeaderElementStatic),
];
