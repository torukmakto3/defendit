import type { Metadata } from "next";
import { JetBrains_Mono, Public_Sans, Sora } from "next/font/google";
import Link from "next/link";
import { AccountMenu } from "@/components/auth";
import { SiteFooter } from "@/components/site-footer";
import { ThemeToggle, themeBootScript } from "@/components/theme";
import { challengesEnabled } from "@/lib/challenge-tier";
import "./globals.css";

const display = Sora({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-display" });
const body = Public_Sans({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-mono" });

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className={`${display.variable} ${body.variable} ${mono.variable} flex min-h-screen flex-col antialiased`}>
        <header className="border-b-[1.5px] border-[var(--ink)] bg-[var(--card)]">
          <div className="shell flex flex-wrap items-center justify-between gap-3 py-3">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="brand text-lg font-bold text-[var(--ink)]">Defend It</span>
              <span className="mono hidden text-[11px] uppercase tracking-[0.1em] text-[var(--ink-2)] sm:inline">
                Rev B
              </span>
            </Link>
            <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--ink-2)]">
              <Link href="/learn" className="hover:text-[var(--blueprint)]">
                Learn
              </Link>
              {challengesEnabled() && (
                <Link href="/c/new" className="hover:text-[var(--blueprint)]">
                  Challenge
                </Link>
              )}
              <Link href="/request" className="hover:text-[var(--blueprint)]">
                Request
              </Link>
              <Link href="/dashboard" className="hover:text-[var(--blueprint)]">
                Dashboard
              </Link>
              <AccountMenu />
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
