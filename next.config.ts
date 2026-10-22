import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Defense links carry their token in the path, so never leak it via Referer.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // LiveKit signalling and media for voice interviews.
      "connect-src 'self' wss://*.livekit.cloud https://*.livekit.cloud",
      "media-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "pdf-parse", "mammoth", "@resvg/resvg-js"],
  poweredByHeader: false,
  // pdfjs loads its canvas polyfill via a dynamic require that file tracing misses.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/@napi-rs/**/*",
      "./node_modules/pdfjs-dist/legacy/build/**/*",
      "./node_modules/@resvg/**/*",
      "./assets/fonts/**/*",
    ],
    // Receipt and challenge cards read these fonts from disk on the node runtime.
    // The path is built at request time, so the tracer does not see the files.
    "/r/**/*": ["./assets/fonts/**/*"],
    "/c/**/*": ["./assets/fonts/**/*"],
    // Sample markdown lives outside the app directory. Trace it with the
    // demo route so a serverless bundle can still open the files.
    "/api/demo/start": ["./fixtures/demo/**/*"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Signed-in API responses must never be cached by a shared cache.
      // (The public stamp image sets its own long-lived cache header.)
      { source: "/api/((?!stamp/).*)", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

export default nextConfig;
