import type { Metadata } from "next";
import { Fraunces, Source_Sans_3 } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
});

const body = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Defend It",
  description:
    "Prove you understand your AI-assisted deliverable. Receivers get a signed score they can verify.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} antialiased`}>
        <header className="border-b border-[var(--line)]/70 bg-[color-mix(in_srgb,var(--paper)_70%,transparent)] backdrop-blur">
          <div className="shell flex items-center justify-between py-4">
            <Link href="/" className="brand text-xl text-[var(--moss)]">
              Defend It
            </Link>
            <nav className="flex items-center gap-4 text-sm text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
              <Link href="/request" className="hover:text-[var(--moss)]">
                Request
              </Link>
              <Link href="/dashboard" className="hover:text-[var(--moss)]">
                Dashboard
              </Link>
              <Link href="/admin" className="hover:text-[var(--moss)]">
                Admin
              </Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
