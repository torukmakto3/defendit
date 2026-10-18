/** Thrown by services; routes map it to a status without leaking internals. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
