<template>
	<NuxtLoadingIndicator color="var(--ui-primary)" position="top" />

	<div class="main-bg-color flex min-h-screen flex-col text-slate-100">
		<LayoutHeader />

		<UMain class="relative flex-1">
			<div
				class="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-primary/5 to-transparent"
			></div>
			<div class="flex min-h-[calc(100vh-80px)] items-center justify-center p-4">
				<UPageCard class="w-full max-w-md border-slate-800">
					<slot />
				</UPageCard>
			</div>
		</UMain>

		<LayoutFooter />
	</div>
</template>
