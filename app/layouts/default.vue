<template>
	<div class="main-bg-color flex min-h-screen flex-col text-slate-100">
		<LayoutHeader />

		<UMain class="flex-1">
			<slot />
		</UMain>

		<LayoutFooter />
	</div>
</template>
