<script setup lang="ts">
interface Props {
	title: string;
	description?: string;
	icon: string;
	tone?: "default" | "danger";
	flush?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	description: undefined,
	tone: "default",
	flush: false,
});

const toneClasses: Record<
	NonNullable<Props["tone"]>,
	{ card: string; header: string; iconTile: string; icon: string; title: string }
> = {
	default: {
		card: "border-slate-800 bg-slate-900/60",
		header: "border-slate-800",
		iconTile: "bg-primary/10",
		icon: "text-primary-400",
		title: "text-white",
	},
	danger: {
		card: "border-red-900/50 bg-red-950/20",
		header: "border-red-900/50",
		iconTile: "bg-red-500/10",
		icon: "text-red-400",
		title: "text-red-400",
	},
};

const classes = computed(() => toneClasses[props.tone]);
</script>

<template>
	<div :class="['overflow-hidden rounded-xl border', classes.card, 'backdrop-blur-sm']">
		<div
			:class="[
				'flex flex-wrap items-center justify-between gap-3 border-b',
				classes.header,
				'px-6 py-4',
			]"
		>
			<div class="flex items-center gap-3">
				<div
					:class="['flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', classes.iconTile]"
				>
					<UIcon :name="icon" :class="['h-5 w-5', classes.icon]" />
				</div>
				<div>
					<h3 :class="['font-medium', classes.title]">{{ title }}</h3>
					<p v-if="description" class="text-sm text-slate-400">{{ description }}</p>
				</div>
			</div>

			<div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
				<slot name="actions"></slot>
			</div>
		</div>

		<div :class="{ 'p-6': !flush }">
			<slot></slot>
		</div>
	</div>
</template>
