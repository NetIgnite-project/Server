<template>
	<div class="main-bg-color flex min-h-screen flex-col text-slate-100">
		<UMain class="flex-1">
			<div class="flex min-h-screen flex-col items-center justify-center px-4 py-10">
				<ImgAppLogo class="mb-8 h-8" />
				<div class="w-full max-w-2xl">
					<slot />
				</div>
			</div>
		</UMain>

		<UFooter class="bg-neutral-900">
			<div class="text-center text-sm text-slate-500">
				&copy; {{ new Date().getFullYear() }} LeiCraft_MC. All rights reserved.
			</div>
		</UFooter>
	</div>
</template>
