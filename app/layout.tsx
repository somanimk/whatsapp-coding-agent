import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "WhatsApp Coding Agent — Phase 1" };
export default function Layout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
