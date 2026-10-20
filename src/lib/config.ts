/**
 * Public base URL for links in emails, receipts, QR codes, and the Google
 * redirect URI. `APP_URL` wins when both it and `NEXT_PUBLIC_APP_URL` are set.
 */
export function appUrl(path = ""): string {
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
  const base = (
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (vercelHost ? `https://${vercelHost}` : "http://localhost:3000")
  ).replace(/\/$/, "");
  if (!path) return base;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
