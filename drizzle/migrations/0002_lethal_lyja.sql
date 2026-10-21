CREATE TABLE `device_ssh_credentials` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`host` text,
	`port` integer DEFAULT 22 NOT NULL,
	`username` text NOT NULL,
	`auth_type` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`public_key` text,
	`os` text DEFAULT 'posix' NOT NULL,
	`sudo` integer DEFAULT true NOT NULL,
	`host_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
