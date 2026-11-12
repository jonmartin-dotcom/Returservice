"use client";

// React-context som gjør merkevare-konfigurasjonen (bestemt server-side i
// layout.tsx ut fra host-headeren) tilgjengelig for klientkomponenter som
// page.tsx, uten å måtte sende den som prop gjennom hele komponenttreet.

import { createContext, useContext, type ReactNode } from "react";
import type { BrandConfig } from "./brands";
import { BRANDS } from "./brands";

const BrandContext = createContext<BrandConfig>(BRANDS.nesco);

export function BrandProvider({
  brand,
  children,
}: {
  brand: BrandConfig;
  children: ReactNode;
}) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandConfig {
  return useContext(BrandContext);
}
