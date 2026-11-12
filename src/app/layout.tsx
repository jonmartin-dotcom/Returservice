import type { Metadata } from "next";
import { headers } from "next/headers";
import { resolveBrand, brandCssVars } from "@/lib/brands";
import { BrandProvider } from "@/lib/brand-context";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const brand = resolveBrand(h.get("host"));
  return {
    title: brand.pageTitle,
    description: `Registrer en retur og få tilsendt fraktetikett eller QR-kode.`,
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const h = await headers();
  const brand = resolveBrand(h.get("host"));
  const cssVars = brandCssVars(brand);

  return (
    <html lang="no">
      <head>
        {/* Open Sans lastes alltid (billig, kun brukt når et merke faktisk
            setter --font-family til å bruke den - se brands.ts). Lastet som
            vanlig stilark i stedet for next/font, for å unngå avhengighet av
            nettverkstilgang under selve Vercel-buildet. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={cssVars as React.CSSProperties}>
        <BrandProvider brand={brand}>{children}</BrandProvider>
      </body>
    </html>
  );
}
