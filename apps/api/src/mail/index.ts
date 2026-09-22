import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import type { Logger } from "pino";

export interface Mail { to: string; subject: string; text: string; html?: string }
export interface Mailer { send(m: Mail): Promise<void> }

/** Keeps sent mail in memory — used by tests to read verification and reset links. */
export class MemoryMailer implements Mailer {
  readonly outbox: Mail[] = [];
  async send(m: Mail) { this.outbox.push(m); }
  last(to: string): Mail | undefined { return [...this.outbox].reverse().find((m) => m.to === to); }
}

/** Logs mail instead of sending it (development). */
export class LogMailer implements Mailer {
  constructor(private readonly log: Logger) {}
  async send(m: Mail) { this.log.info({ to: m.to, subject: m.subject, text: m.text }, "mail (not sent: MAIL_DRIVER=log)"); }
}

/** Writes each message to a JSON file (development and end-to-end tests). Refused in production because links carry tokens. */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  async send(m: Mail) { writeFileSync(join(this.dir, `${Date.now()}-${randomBytes(3).toString("hex")}.json`), JSON.stringify(m)); }
}

export class SmtpMailer implements Mailer {
  private readonly t;
  constructor(url: string, private readonly from: string) { this.t = nodemailer.createTransport(url); }
  async send(m: Mail) { await this.t.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html }); }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, body: string, cta: { label: string; url: string }): { html: string } {
  return {
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1c1b19"><h2 style="margin:0 0 12px">${esc(title)}</h2><p style="line-height:1.5">${body}</p><p><a href="${esc(cta.url)}" style="display:inline-block;padding:10px 16px;background:#1f5d50;color:#fff;border-radius:8px;text-decoration:none">${esc(cta.label)}</a></p><p style="color:#6b6963;font-size:13px">If the button doesn't work, copy this link into your browser:<br>${esc(cta.url)}</p></div>`,
  };
}

export const templates = {
  verifyEmail: (name: string, url: string): Omit<Mail, "to"> => ({
    subject: "Verify your email for Verinum",
    text: `Hi ${name || "there"},\n\nConfirm your email address to finish setting up your Verinum account:\n${url}\n\nThis link expires in 24 hours. If you didn't create an account, you can ignore this message.`,
    ...layout("Confirm your email", `Hi ${esc(name || "there")}, confirm your email address to finish setting up your account. The link expires in 24 hours.`, { label: "Confirm email", url }),
  }),
  resetPassword: (name: string, url: string): Omit<Mail, "to"> => ({
    subject: "Reset your Verinum password",
    text: `Hi ${name || "there"},\n\nUse this link to choose a new password:\n${url}\n\nIt expires in 1 hour. If you didn't ask for this, ignore this message — your password won't change.`,
    ...layout("Reset your password", `Hi ${esc(name || "there")}, use the button below to choose a new password. The link expires in one hour. If you didn't ask for this, you can ignore this message.`, { label: "Choose a new password", url }),
  }),
  invitation: (inviter: string, workspace: string, role: string, url: string): Omit<Mail, "to"> => ({
    subject: `${inviter} invited you to ${workspace} on Verinum`,
    text: `${inviter} invited you to join "${workspace}" as ${role}.\n\nAccept the invitation:\n${url}\n\nThe invitation expires in 7 days.`,
    ...layout(`Join ${workspace}`, `${esc(inviter)} invited you to join <b>${esc(workspace)}</b> as ${esc(role)}. The invitation expires in 7 days.`, { label: "Accept invitation", url }),
  }),
};
