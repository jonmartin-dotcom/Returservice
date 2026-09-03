// MIDLERTIDIG DEBUG-RUTE: viser det helt rå svaret fra Ongoing for en gitt
// ordre, formatert og lesbart rett i nettleseren - slik at vi slipper å lete
// i Vercel-loggene (som kutter av lange linjer).
//
// Bruk: åpne https://<deres-domene>/api/debug/order-lookup?orderNumber=XXXX
// i nettleseren.
//
// VIKTIG: Denne ruten bør slettes (denne filen + funksjonen
// getRawOrderForDebug i src/lib/ongoing.ts) når feltnavnene for
// telefon/e-post er bekreftet og lagt inn riktig, siden den viser rå
// ordredata uten noen tilgangskontroll.

import { NextRequest, NextResponse } from "next/server";
import { getRawOrderForDebug } from "@/lib/ongoing";

export async function GET(req: NextRequest) {
  const orderNumber = req.nextUrl.searchParams.get("orderNumber");
  if (!orderNumber) {
    return NextResponse.json(
      { error: "Legg til ?orderNumber=XXXX i URL-en." },
      { status: 400 }
    );
  }

  try {
    const raw = await getRawOrderForDebug(orderNumber);
    return new NextResponse(JSON.stringify(raw, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Klarte ikke å hente ordren: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
