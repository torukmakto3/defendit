"use client";

import { useEffect } from "react";

function browserOptOut(): boolean {
  if (typeof navigator === "undefined") return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const win = window as Window & { doNotTrack?: string | null };
  if (nav.doNotTrack === "1" || win.doNotTrack === "1") return true;
  if (nav.globalPrivacyControl === true) return true;
  return false;
}

function sendBeacon(body: unknown) {
  void fetch("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    keepalive: true,
  }).catch(() => {});
}

let landingSent = false;

/** One anonymous landing count per page load. Skips DNT and Global Privacy Control. */
export function LandingBeacon() {
  useEffect(() => {
    if (landingSent || browserOptOut()) return;
    landingSent = true;
    const params = new URLSearchParams(window.location.search);
    const props: Record<string, string> = {};
    const source = params.get("utm_source");
    const campaign = params.get("utm_campaign");
    if (source) props.utm_source = source;
    if (campaign) props.utm_campaign = campaign;
    const body: { name: "landing_view"; referrer?: string; props?: Record<string, string> } = {
      name: "landing_view",
    };
    if (document.referrer) body.referrer = document.referrer;
    if (Object.keys(props).length > 0) body.props = props;
    sendBeacon(body);
  }, []);
  return null;
}

/** Receipt share or copy click. The receipt id is not sent. */
export function beaconReceiptShared(method: "share" | "copy") {
  if (browserOptOut()) return;
  sendBeacon({
    name: "receipt_shared",
    props: { method },
  });
}
