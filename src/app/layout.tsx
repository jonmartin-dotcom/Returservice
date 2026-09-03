import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nesco Returservice",
  description: "Registrer en retur hos Nesco og få tilsendt fraktetikett.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
