<script setup lang="ts" generic="T extends Record<string, any>">
import type { TableColumn } from "@nuxt/ui";
import { getPaginationRowModel } from "@tanstack/table-core";
import type {
	CellContext,
	ColumnFiltersState,
	FilterFn,
	HeaderContext,
	Row,
} from "@tanstack/vue-table";
import { breakpointsTailwind, useBreakpoints } from "@vueuse/core";
import { isRef } from "vue";

// Cell slot props type (matches UTable's slot props)
type CellSlotProps = {
	row: Row<T>;
};

// Select option type for select filters
interface SelectOption {
	label: string;
	value: string | number | boolean | null;
	icon?: string;
	color?: string;
}

// Filter types
type FilterType = "text" | "number" | "date" | "select" | "multi-select" | "custom";

// Filter configuration type
interface FilterConfig {
	/** Column key to filter */
	column: keyof T;
	/** Filter type */
	type?: FilterType;
	/** Input placeholder */
	placeholder?: string;
	/** Input icon */
	icon?: string;
	/** Custom CSS class for the input */
	class?: string;
	/** Options for select/multi-select filters */
	options?: SelectOption[];
	/** Custom filter function */
	filterFn?: FilterFn<T>;
	/** Label for the filter (shown in multi-select badge) */
	label?: string;
}

// Props
interface Props {
	/** Table data */
	data: T[] | Ref<T[]>;
	/** Table columns configuration */
	columns: TableColumn<T>[];
	/** Loading state */
	loading?: boolean | Ref<boolean>;
	/** Filter configurations */
	filters?: FilterConfig[];
	/** Default page size */
	defaultPageSize?: number;
	/** Available page size options */
	pageSizeOptions?: number[];
	/** Show refresh button */
	showRefresh?: boolean;
	/** Show pagination */
	showPagination?: boolean;
	/** Show page size selector */
	showPageSizeSelector?: boolean;
	/** Empty state title */
	emptyTitle?: string;
	/** Empty state description */
	emptyDescription?: string;
	/** Empty state icon */
	emptyIcon?: string;
}

const props = withDefaults(defineProps<Props>(), {
	loading: false,
	filters: () => [],
	defaultPageSize: 10,
	pageSizeOptions: () => [10, 25, 50, 100],
	showRefresh: true,
	showPagination: true,
	showPageSizeSelector: true,
	emptyTitle: "No data",
	emptyDescription: "No items found.",
	emptyIcon: "i-lucide-database",
});

// Emits
const emit = defineEmits<{
	/** Emitted when refresh button is clicked */
	refresh: [];
	/** Emitted when a row is selected/clicked */
	"row-click": [row: T];
}>();

type DynamicHeaderSlots<T, K = keyof T> = Record<
	string,
	(props: HeaderContext<T, unknown>) => any
> &
	Record<`${K extends string ? K : never}-header`, (props: HeaderContext<T, unknown>) => any>;
type DynamicFooterSlots<T, K = keyof T> = Record<
	string,
	(props: HeaderContext<T, unknown>) => any
> &
	Record<`${K extends string ? K : never}-footer`, (props: HeaderContext<T, unknown>) => any>;
type DynamicCellSlots<T, K = keyof T> = Record<string, (props: CellContext<T, unknown>) => any> &
	Record<`${K extends string ? K : never}-cell`, (props: CellContext<T, unknown>) => any>;

type TableSlots = {
	/** Header left side content (before search) */
	"header-left"?: () => any;
	/** Header right side content (after refresh button) */
	"header-right"?: () => any;
	/** Custom empty state */
	empty?: () => any;
	/** Actions in the empty state */
	"empty-actions"?: () => any;
	/** Footer left side content */
	"footer-left"?: () => any;
	/** Footer right side content (replaces pagination) */
	"footer-right"?: () => any;
} & DynamicHeaderSlots<T> &
	DynamicFooterSlots<T> &
	DynamicCellSlots<T>;

// Slots with proper typing for type checking
defineSlots<TableSlots>();

// Use useSlots for dynamic slot access (avoids index signature issues)
const slots = useSlots();

// Table ref
const table = useTemplateRef("table");

// Filter configurations
const allFilters = computed<FilterConfig[]>(() => props.filters ?? []);

// Column filters state
const columnFilters = ref<ColumnFiltersState>([]);

// Drop filter state for columns that no longer have a filter. Unset filters stay out of the
// state: TanStack applies every entry in it, even an empty one.
watch(
	() => allFilters.value.map((f) => f.column as string),
	(filterColumns) => {
		columnFilters.value = columnFilters.value.filter((f) => filterColumns.includes(f.id));
	},
);

// Helper to get/set filter value for a specific column
function getFilterValue(column: string): any {
	const filter = allFilters.value.find((f) => f.column === column);
	const value = table.value?.tableApi?.getColumn(column)?.getFilterValue();
	// Return undefined for select types to show placeholder, empty string for text
	if (filter?.type === "select" || filter?.type === "multi-select") {
		return value ?? undefined;
	}
	return value ?? "";
}

function setFilterValue(column: string, value: any) {
	const filter = allFilters.value.find((f) => f.column === column);
	if (filter?.type === "multi-select") {
		table.value?.tableApi?.getColumn(column)?.setFilterValue(value?.length ? value : undefined);
	} else {
		table.value?.tableApi?.getColumn(column)?.setFilterValue(value ?? undefined);
	}
}

// Get select items for a filter
function getSelectItems(filter: FilterConfig) {
	if (!filter.options) return [];
	return filter.options.map((opt) => ({
		label: opt.label,
		value: opt.value as string | number,
	}));
}

// Get multi-select items for a filter
function getMultiSelectItems(filter: FilterConfig) {
	if (!filter.options) return [];
	return filter.options.map((opt) => ({
		label: opt.label,
		value: opt.value,
	}));
}

// Enhanced columns with custom filter functions
const enhancedColumns = computed<TableColumn<T>[]>(() => {
	return props.columns.map((col) => {
		const accessorKey = (col as any).accessorKey || (col as any).id;
		const filter = allFilters.value.find((f) => f.column === accessorKey);

		if (!filter) return col;

		// Explicit filter function per type; TanStack's "auto" picks one from the first row's value
		let filterFn: FilterFn<T> | undefined;

		if (filter.filterFn) {
			filterFn = filter.filterFn;
		} else if (!filter.type || filter.type === "text") {
			filterFn = (row, columnId, filterValue) => {
				if (filterValue == null || filterValue === "") return true;
				const cellValue = String(row.getValue(columnId) ?? "").toLowerCase();
				return cellValue.includes(String(filterValue).toLowerCase());
			};
		} else if (filter.type === "number") {
			filterFn = (row, columnId, filterValue) => {
				if (filterValue == null || filterValue === "") return true;
				const cellValue = row.getValue(columnId);
				return cellValue != null && Number(cellValue) === Number(filterValue);
			};
		} else if (filter.type === "select") {
			filterFn = (row, columnId, filterValue) => {
				if (filterValue == null || filterValue === "") return true;
				return row.getValue(columnId) === filterValue;
			};
		} else if (filter.type === "multi-select") {
			filterFn = (row, columnId, filterValue) => {
				if (!filterValue || !Array.isArray(filterValue) || filterValue.length === 0) return true;
				const cellValue = row.getValue(columnId);
				return filterValue.includes(cellValue);
			};
		} else if (filter.type === "date") {
			filterFn = (row, columnId, filterValue) => {
				if (!filterValue || !filterValue.start || !filterValue.end) return true;
				const cellValue = row.getValue(columnId) as string | number;
				const cellDate = new Date(cellValue);
				const startDate = new Date(filterValue.start);
				const endDate = new Date(filterValue.end);
				// Normalize time for comparison
				cellDate.setHours(0, 0, 0, 0);
				startDate.setHours(0, 0, 0, 0);
				endDate.setHours(0, 0, 0, 0);
				return cellDate >= startDate && cellDate <= endDate;
			};
		}

		if (filterFn) {
			return {
				...col,
				filterFn,
			} as TableColumn<T>;
		}

		return col;
	});
});

// Pagination state
const pagination = ref({
	pageIndex: 0,
	pageSize: props.defaultPageSize,
});

// Page size select items
const pageSizeItems = computed(() =>
	props.pageSizeOptions.map((size) => ({
		label: String(size),
		value: size,
	})),
);

const breakpoints = useBreakpoints(breakpointsTailwind);
const isMobile = breakpoints.smaller("sm");

// Handle page size change
function handlePageSizeChange(value: number) {
	table.value?.tableApi?.setPageSize(value);
}

// Handle refresh
function handleRefresh() {
	emit("refresh");
}

// Expose table ref and API for parent component access
defineExpose({
	table,
	tableApi: computed(() => table.value?.tableApi),
});
</script>

<template>
	<UCard class="border-slate-800 bg-slate-900/60">
		<template #header>
			<div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
				<!-- Filters Section -->
				<div class="flex flex-col gap-2 w-full sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
					<slot name="header-left" />
					
					<!-- Render all filters based on type -->
					<template v-for="filter in allFilters" :key="filter.column">
						<!-- Text Input Filter (default) -->
						<UInput
							v-if="!filter.type || filter.type === 'text'"
							:model-value="getFilterValue(filter.column as string) as string"
							:class="filter.class || 'w-full sm:w-auto sm:max-w-sm sm:min-w-48'"
							:icon="filter.icon || 'i-lucide-search'"
							:placeholder="filter.placeholder || 'Search...'"
							@update:model-value="(val: string) => setFilterValue(filter.column as string, val)"
						/>

						<!-- Number Input Filter -->
						<UInput
							v-else-if="filter.type === 'number'"
							type="number"
							:model-value="getFilterValue(filter.column as string) as string"
							:class="filter.class || 'w-full sm:w-auto sm:max-w-32 sm:min-w-24'"
							:icon="filter.icon || 'i-lucide-hash'"
							:placeholder="filter.placeholder || 'Number...'"
							@update:model-value="(val: string) => setFilterValue(filter.column as string, val)"
						/>

						<!-- Date Picker Filter -->
						<FormDateRangePicker
							v-else-if="filter.type === 'date'"
							:model-value="getFilterValue(filter.column as string) as any"
							:class="filter.class || 'w-full sm:w-auto sm:min-w-40'"
							:icon="filter.icon || 'i-lucide-calendar'"
							@update:model-value="(val: any) => setFilterValue(filter.column as string, val)"
						/>

						<!-- Select Filter -->
						<USelectMenu
							v-else-if="filter.type === 'select'"
							:model-value="getFilterValue(filter.column as string)"
							:items="getSelectItems(filter)"
							value-key="value"
							:class="filter.class || 'w-full sm:w-auto sm:min-w-40'"
							:placeholder="filter.placeholder || 'All'"
							@update:model-value="(val: any) => setFilterValue(filter.column as string, val)"
						>
							<template #leading>
								<UIcon v-if="filter.icon" :name="filter.icon" class="size-4 text-muted" />
							</template>
						</USelectMenu>

						<!-- Multi-Select Filter -->
						<USelectMenu
							v-else-if="filter.type === 'multi-select'"
							:model-value="(getFilterValue(filter.column as string) as any[]) || []"
							:items="getMultiSelectItems(filter)"
							value-key="value"
							multiple
							:class="filter.class || 'w-full sm:w-auto sm:min-w-48'"
							:placeholder="filter.placeholder || 'Select...'"
							@update:model-value="(val: any) => setFilterValue(filter.column as string, val)"
						>
							<template #leading>
								<UIcon v-if="filter.icon" :name="filter.icon" class="size-4 text-muted" />
							</template>
						</USelectMenu>
					</template>
				</div>
				
				<!-- Actions Section -->
				<div class="flex items-center gap-2 sm:gap-3 justify-end">
					<UButton
						v-if="showRefresh"
						icon="i-lucide-refresh-cw"
						color="neutral"
						variant="subtle"
						class="sm:hidden"
						@click="handleRefresh"
					/>
					<UButton
						v-if="showRefresh"
						label="Refresh"
						icon="i-lucide-refresh-cw"
						color="neutral"
						variant="subtle"
						class="hidden sm:inline-flex"
						@click="handleRefresh"
					/>

					<slot name="header-right" />
				</div>
			</div>
		</template>

		<!-- Loading State -->
		<div v-if="isRef(loading) ? loading.value : loading" class="flex items-center justify-center py-12">
			<UIcon name="i-lucide-loader-2" class="animate-spin text-3xl text-slate-400" />
		</div>

		<!-- Table -->
		<UTable
			v-else-if="(isRef(data) ? data.value : data)?.length"
			ref="table"
			:data="isRef(data) ? data.value : data"
			:columns="enhancedColumns"
			v-model:column-filters="columnFilters"
			v-model:pagination="pagination"
			:pagination-options="{
				getPaginationRowModel: getPaginationRowModel()
			}"
		>
			<!-- Pass through all cell slots dynamically -->
			<template v-for="(_, slotName) in slots" :key="slotName" #[slotName]="slotProps">
				<slot :name="(slotName as keyof TableSlots)" v-bind="slotProps || {}" />
			</template>
		</UTable>

		<!-- Empty State -->
		<template v-else>
			<slot name="empty">
				<UEmpty
					:icon="emptyIcon"
					:title="emptyTitle"
					:description="emptyDescription"
					variant="naked"
				>
					<template v-if="slots['empty-actions']" #actions>
						<slot name="empty-actions" />
					</template>
				</UEmpty>
			</slot>
		</template>

		<template v-if="!(isRef(loading) ? loading.value : loading) && (isRef(data) ? data.value : data)?.length && (showPagination || showPageSizeSelector)" #footer>
			<div class="flex items-center gap-3" :class="showPageSizeSelector && !isMobile ? 'justify-between' : 'justify-center'">
				<div v-if="showPageSizeSelector && !isMobile" class="flex items-center gap-3 text-sm text-muted">
					<slot name="footer-left">
						<!-- Hide page size selector on mobile -->
						<USelect
							:items="pageSizeItems"
							size="md"
							class="min-w-18"
							:default-value="defaultPageSize"
							@update:model-value="handlePageSizeChange"
						/>
					</slot>
				</div>

				<div class="flex items-center">
					<slot name="footer-right">
						<!-- Mobile Pagination (fewer siblings, show edges) -->
						<UPagination
							v-if="showPagination"
							:default-page="(table?.tableApi?.getState().pagination.pageIndex || 0) + 1"
							:items-per-page="table?.tableApi?.getState().pagination.pageSize"
							:total="table?.tableApi?.getFilteredRowModel().rows.length"
							:sibling-count="isMobile ? 0 : 2"
							:show-edges="true"
							@update:page="(p: number) => table?.tableApi?.setPageIndex(p - 1)"
						/>
					</slot>
				</div>
			</div>
		</template>
	</UCard>
</template>

