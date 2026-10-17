export function appUrl(path = ""): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  if (!path) return base;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
