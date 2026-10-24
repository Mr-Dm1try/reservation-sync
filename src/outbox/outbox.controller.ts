import { Controller, Get, Inject } from '@nestjs/common';
import { DB, Db } from '../db/db';

export type OutboxEntryView = {
  key: string;
  reservationId: string;
  kind: string;
  status: 'pending' | 'sent' | 'skipped';
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  sentAt: string | null;
};

/** Read side for the demo and tests (DECISIONS.md, section 6). Payload left out: it holds guest PII. */
@Controller('outbox')
export class OutboxController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(): Promise<OutboxEntryView[]> {
    const rows = await this.db.query<Record<string, any>>(
      `SELECT key, reservation_id, kind, status, attempts, last_error, next_attempt_at, sent_at
       FROM outbox ORDER BY created_at, key`,
    );
    return rows.map((r) => ({
      key: r.key,
      reservationId: r.reservation_id,
      kind: r.kind,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      nextAttemptAt: new Date(r.next_attempt_at).toISOString(),
      sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    }));
  }
}
