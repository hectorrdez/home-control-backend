import "dotenv/config";
import nodemailer, { Transporter } from "nodemailer";
import ApiError from "../errors/ApiError";
import Logger from "./Logger";

/** SMTP mailer (EMAIL_* env). The transport is built lazily on first send. */
export default class Mailer {
  private transport?: Transporter;

  private getTransport(): Transporter {
    if (!this.transport) {
      const { EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE, EMAIL_USER, EMAIL_PASS } = process.env;
      if (!EMAIL_HOST) throw new ApiError("Email is not configured", 500, "email_not_configured");
      this.transport = nodemailer.createTransport({
        host: EMAIL_HOST,
        port: Number(EMAIL_PORT ?? 587),
        secure: EMAIL_SECURE === "true",
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
      });
    }
    return this.transport;
  }

  public async send(from: string, to: string, subject: string, html: string): Promise<void> {
    try {
      await this.getTransport().sendMail({ from, to, subject, html });
      Logger.write("Email sent", "Mailer");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      Logger.error(`Cannot send email: ${(error as Error).message}`, "Mailer");
      throw new ApiError("Cannot send email", 502, "email_send_failed");
    }
  }
}
