<script setup lang="ts">
interface Props {
	label: string;
	value: string | number;
	icon: string;
	iconColor?: "primary" | "amber" | "emerald" | "error" | "neutral";
	hint?: string;
	loading?: boolean;
}

withDefaults(defineProps<Props>(), {
	iconColor: "primary",
	hint: undefined,
	loading: false,
});

const iconColorClasses: Record<NonNullable<Props["iconColor"]>, string> = {
	primary: "text-primary-400",
	amber: "text-amber-400",
	emerald: "text-emerald-400",
	error: "text-red-400",
	neutral: "text-slate-400",
};
</script>

<template>
	<UCard class="border-slate-800 bg-slate-900/60">
		<div class="flex items-center gap-4">
			<div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-800">
				<UIcon :name="icon" :class="['text-xl', iconColorClasses[iconColor]]" />
			</div>
			<div class="min-w-0">
				<p class="text-2xl font-bold">{{ loading ? "…" : value }}</p>
				<p class="text-sm text-slate-400">{{ label }}</p>
				<p v-if="hint" class="text-xs text-slate-500">{{ hint }}</p>
			</div>
		</div>
	</UCard>
</template>
