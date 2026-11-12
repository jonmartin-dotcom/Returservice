// Merkevare-konfigurasjon for Nesco sine tre nettbutikker (nesco.no,
// utroligsalven.no, decrusto.no). Alle tre deler NØYAKTIG samme backend
// (samme Ongoing goodsOwnerId, samme Bring-konto/kundenummer, samme lager) -
// det er KUN design (farger/logo/tekst) som skiller dem. Se prosjektnoten
// "Mal for ny returløsning per vareeier" for bakgrunnen til dette valget
// (nov. 2026): én app/ett Vercel-prosjekt med flere Custom Domains, i stedet
// for tre separate kode-kopier, nettopp for å unngå risikoen for at
// page.tsx/CSS drifter fra hverandre slik vi har sett for andre vareeiere.

export type BrandKey = "nesco" | "utroligsalven" | "decrusto";

export interface BrandLogo {
  /** "letter" = bokstav i en sirkel. "leaf" = Nesco sitt løv-ikon. */
  type: "letter" | "leaf";
  letter?: string;
  circleBg: string;
  circleFg: string;
}

export interface BrandConfig {
  key: BrandKey;
  /** Vises som liten uppercase-label over tittelen. Utelates hvis ikke satt
   *  (Utroligsalven sin designmal viser kun domenenavnet, ingen egen label). */
  headerLabel?: string;
  /** Hovedoverskrift ved siden av/under logoen. */
  headerTitle: string;
  /** Tittel i nettleserfanen (<title>). */
  pageTitle: string;
  logo: BrandLogo;
  colors: {
    background: string;
    surface: string;
    foreground: string;
    muted: string;
    border: string;
    accent: string;
    accentHover: string;
    radius?: string;
  };
  /** Full CSS font-family-verdi. Faller tilbake til system-fontstabelen i
   *  globals.css hvis ikke satt. */
  fontFamily?: string;
  buttonTextTransform?: "uppercase" | "none";
  /** Introtekst over de tre nummererte stegene på steg 1. */
  introText: string;
  /** Vurder om dette merket faktisk er bekreftet/godkjent av kunden ennå -
   *  kun til internt bruk/merknad, påvirker ikke funksjonalitet. */
  placeholderDesign?: boolean;
}

const nesco: BrandConfig = {
  key: "nesco",
  headerLabel: "NESCO",
  headerTitle: "Returservice",
  pageTitle: "Nesco Returservice",
  logo: { type: "leaf", circleBg: "#4f7a5c", circleFg: "#ffffff" },
  colors: {
    background: "#faf8f3",
    surface: "#ffffff",
    foreground: "#23302b",
    muted: "#6d7d73",
    border: "#e6e1d3",
    accent: "#4f7a5c",
    accentHover: "#3d6149",
    radius: "10px",
  },
  introText:
    "Vi har åpent kjøp og bytterett i henhold til angrerettloven. Varen(e) må være ubrukt og i original stand.",
};

// Fra designmanual mottatt 2026-11-12
// ("Profilmanual_utroligsalven-no_SpringNova_retur_y26_w36_1_korr.pdf"):
// knappefarge #e72929, ramme #ffe4cf, bakgrunn #fffdfb, tekst #000000,
// Open Sans (Regular/Semi Bold), ALL CAPS på knappetekst.
const utroligsalven: BrandConfig = {
  key: "utroligsalven",
  // Designmalen viser kun logo + domenenavn på én linje, ingen egen
  // uppercase-label over - derfor ingen headerLabel her.
  headerTitle: "utroligsalven.no",
  pageTitle: "utroligsalven.no - Returservice",
  logo: { type: "letter", letter: "u", circleBg: "#000000", circleFg: "#ffffff" },
  colors: {
    background: "#fffdfb",
    surface: "#ffffff",
    foreground: "#000000",
    muted: "#595959",
    border: "#ffe4cf",
    accent: "#e72929",
    accentHover: "#c42323",
    radius: "10px",
  },
  fontFamily: "'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  buttonTextTransform: "uppercase",
  introText:
    "Vi har 30 dagers åpent kjøp og bytterett. Varen(e) må være uåpnet og emballasjen må ikke være skadet.",
};

// IKKE bekreftet design ennå (venter på godkjenning av utroligsalven.no
// først, ifølge Jon 2026-11-12) - nøytral plassholderprofil inntil
// designmanual er klar. Bytt ut når Jon sender den.
const decrusto: BrandConfig = {
  key: "decrusto",
  headerLabel: "DECRUSTO",
  headerTitle: "Returservice",
  pageTitle: "Decrusto Returservice",
  logo: { type: "letter", letter: "d", circleBg: "#475569", circleFg: "#ffffff" },
  colors: {
    background: "#f8fafc",
    surface: "#ffffff",
    foreground: "#1e293b",
    muted: "#64748b",
    border: "#e2e8f0",
    accent: "#475569",
    accentHover: "#334155",
    radius: "10px",
  },
  introText:
    "Vi har åpent kjøp og bytterett i henhold til angrerettloven. Varen(e) må være ubrukt og i original stand.",
  placeholderDesign: true,
};

export const BRANDS: Record<BrandKey, BrandConfig> = {
  nesco,
  utroligsalven,
  decrusto,
};

/**
 * Gjenkjenner hvilket merke som skal vises ut fra host-headeren i
 * forespørselen. Faller tilbake til Nesco for alt som ikke eksplisitt
 * matcher (f.eks. *.vercel.app-forhåndsvisnings-URL-er, localhost under
 * utvikling, eller et domene som ennå ikke er lagt til i Vercel).
 */
export function resolveBrand(host: string | null | undefined): BrandConfig {
  const h = (host || "").toLowerCase().split(":")[0];
  if (h.includes("utroligsalven")) return BRANDS.utroligsalven;
  if (h.includes("decrusto")) return BRANDS.decrusto;
  if (h.includes("nesco")) return BRANDS.nesco;
  return BRANDS.nesco;
}

/** CSS custom properties (variabelnavnene brukt i globals.css/page.module.css). */
export function brandCssVars(brand: BrandConfig): Record<string, string> {
  return {
    "--background": brand.colors.background,
    "--surface": brand.colors.surface,
    "--foreground": brand.colors.foreground,
    "--muted": brand.colors.muted,
    "--border": brand.colors.border,
    "--accent": brand.colors.accent,
    "--accent-hover": brand.colors.accentHover,
    ...(brand.colors.radius ? { "--radius": brand.colors.radius } : {}),
    ...(brand.fontFamily ? { "--font-family": brand.fontFamily } : {}),
    "--button-text-transform": brand.buttonTextTransform || "none",
    "--logo-bg": brand.logo.circleBg,
    "--logo-fg": brand.logo.circleFg,
  };
}
