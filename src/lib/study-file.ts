/**
 * Copy and routing for studying after the extracted file text is gone.
 * Safe to import from client components: no database or model calls.
 */

/** Post-defense recovery. The raw file is not kept, so the creator uploads the same bytes. */
export const STUDY_FILE_DELETED =
  "The file was deleted after your defense. Upload it again to study.";

/** The 72-hour text timer passed before a defense. A new upload is still allowed. */
export const STUDY_TEXT_EXPIRED = "The extracted text expired. Upload the file again to study.";

export function studyFileMissingMessage(status: string): string {
  return status === "defended" ? STUDY_FILE_DELETED : STUDY_TEXT_EXPIRED;
}

export function isStudyFileMissing(message: string | null | undefined): boolean {
  return message === STUDY_FILE_DELETED || message === STUDY_TEXT_EXPIRED;
}
