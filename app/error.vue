<script setup lang="ts">
import type { NuxtError } from "#app";

defineProps<{
	error: NuxtError;
}>();
</script>

<template>
	<div class="main-bg-color flex min-h-screen flex-col text-slate-100">
		<LayoutHeader />

		<UMain class="flex-1">
			<UError :error="error" />
		</UMain>

		<LayoutFooter />
	</div>
</template>
