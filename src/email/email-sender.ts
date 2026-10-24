export type EmailMessage = {
  /** Provider-side idempotency key; the outbox key, e.g. 'confirmation:{reservationId}'. */
  idempotencyKey: string;
  reservationId: string;
  to: string;
  subject: string;
  body: string;
};

export interface EmailSender {
  /** Resolves when the provider accepted the message; throws on failure (caller retries). */
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export class TransientEmailError extends Error {
  constructor(message = 'Simulated transient email provider failure') {
    super(message);
    this.name = 'TransientEmailError';
  }
}
