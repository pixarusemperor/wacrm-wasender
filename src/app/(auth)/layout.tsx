import type { Metadata } from "next";
import type { ReactNode } from "react";

// The auth pages create a Supabase client from runtime env vars. Keep
// them server-rendered on demand instead of statically prerendered at
// build time, so `next build` works even when NEXT_PUBLIC_* vars are
// empty (e.g. a generic Docker build without build args). The real
// values are read at request time.
export const dynamic = "force-dynamic";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return children;
}
