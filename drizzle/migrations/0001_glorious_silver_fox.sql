CREATE TABLE `firmware_releases` (
	`version` text PRIMARY KEY NOT NULL,
	`prerelease` integer NOT NULL,
	`published_at` integer NOT NULL,
	`release_url` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`manifest` text NOT NULL,
	`signature_verified` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
