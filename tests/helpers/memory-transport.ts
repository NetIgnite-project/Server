import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import type MailMessage from "nodemailer/lib/mailer/mail-message";
import type { CapturedEmail } from "../../server/lib/api/utils/email";

/**
 * Build an in-memory nodemailer transport that captures every sent email
 * into the provided array instead of delivering it over SMTP.
 *
 * Usage:
 *   const emails: CapturedEmail[] = [];
 *   const transport = createMemoryTransport(emails);
 *   EmailService.init(transport);
 */
export function createMemoryTransport(capture: CapturedEmail[]): Transporter {
	return nodemailer.createTransport({
		name: "memory",
		version: "1.0.0",
		send: (mail: MailMessage, callback: (err: Error | null, info: any) => void) => {
			capture.push({
				from: (mail.data.from as string) ?? "",
				to: (Array.isArray(mail.data.to) ? mail.data.to.join(", ") : (mail.data.to ?? "")) as string,
				subject: (mail.data.subject as string) ?? "",
				html: (mail.data.html as string) ?? "",
				text: (mail.data.text as string) ?? "",
			});
			callback(null, {
				messageId: `mock-${Date.now()}@memory`,
				envelope: { from: mail.data.from as string, to: [mail.data.to as string].flat() },
				accepted: [mail.data.to as string].flat(),
				rejected: [],
				pending: [],
				response: "250 OK (memory)",
			});
		},
	} as any);
}
