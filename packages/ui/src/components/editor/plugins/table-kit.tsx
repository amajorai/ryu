"use client";

import {
	TableCellHeaderPlugin,
	TableCellPlugin,
	TablePlugin,
	TableRowPlugin,
} from "@platejs/table/react";

import {
	TableCellElement,
	TableCellHeaderElement,
	TableElement,
	TableRowElement,
} from "@ryu/ui/components/editor/ui/table-node.tsx";

export const TableKit = [
	TablePlugin.withComponent(TableElement),
	TableRowPlugin.withComponent(TableRowElement),
	TableCellPlugin.withComponent(TableCellElement),
	TableCellHeaderPlugin.withComponent(TableCellHeaderElement),
];
