/**
 * File clocks. `services.ts` uses these. A deployment can override them
 * with DOCUMENT_TTL_HOURS, RETENTION_DAYS, or MAX_UPLOAD_BYTES.
 * Empty values fall back to the defaults. The Number() parse matches the
 * previous expressions in services.ts.
 */

/** Hours before extracted text is deleted when a defense never finishes. */
export const DOCUMENT_TTL_HOURS_DEFAULT = 72;

/** Days before claims, answers, grades, the file name, and flashcards are deleted. */
export const RETENTION_DAYS_DEFAULT = 30;

/** Fallback upload size, in bytes. */
export const MAX_UPLOAD_BYTES_DEFAULT = 4 * 1024 * 1024;

export function documentTtlHours(): number {
  return Number(process.env.DOCUMENT_TTL_HOURS || DOCUMENT_TTL_HOURS_DEFAULT);
}

export function retentionDays(): number {
  return Number(process.env.RETENTION_DAYS || RETENTION_DAYS_DEFAULT);
}

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES_DEFAULT);
