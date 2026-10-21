ALTER TABLE `agents` ADD `ssh_keys` text;--> statement-breakpoint
ALTER TABLE `device_ssh_credentials` DROP COLUMN `auth_type`;--> statement-breakpoint
ALTER TABLE `device_ssh_credentials` DROP COLUMN `secret_encrypted`;--> statement-breakpoint
ALTER TABLE `device_ssh_credentials` DROP COLUMN `public_key`;