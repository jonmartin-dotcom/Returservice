import { NextRequest, NextResponse } from "next/server";
import { lookupOrderByNumber, createReturnOrder, getArticlePackageInfo } from "@/lib/ongoing";
import { createReturnShipment, fetchLabelForShipment, type PackageDimensions } from "@/lib/webshipper";
import { RETURN_REASONS, type ReturnRequest, type ReturnRequestResult } from "@/lib/types";
import { env } from "@/lib/env";

/**
 * Slår sammen vekt/mål for de valgte varelinjene til én samlet pakke som
 * sendes til Webshipper. Vekt summeres. For mål (som ikke kan summeres
 * direkte når flere ulike varer pakkes sammen) regner vi ut totalvolumet og
 * lager en "terning" med tilsvarende volum - en forenkling, men den sikrer
 * at pakken alltid får realistiske mål fremfor faste minstemål.
 * Varer uten registrerte mål i Ongoing faller tilbake på konfigurerte
 * standardmål (se .env.example).
 */
async function buildPackageDimensions(
  lines: { articleNumber: string; quantity: number }[]
): Promise<PackageDimensions> {
  const info = await getArticlePackageInfo(lines.map((l) => l.articleNumber));

  let totalWeightGrams = 0;
  let totalVolumeCm3 = 0;

  for (const line of lines) {
    const a = info.get(line.articleNumber);
    const weightGrams = a?.weightKg ? a.weightKg * 1000 : env.defaultItemWeightGrams;
    const lengthCm = a?.lengthM ? a.lengthM * 100 : env.defaultItemLengthCm;
    const widthCm = a?.widthM ? a.widthM * 100 : env.defaultItemWidthCm;
    const heightCm = a?.heightM ? a.heightM * 100 : env.defaultItemHeightCm;

    totalWeightGrams += weightGrams * line.quantity;
    totalVolumeCm3 += lengthCm * widthCm * heightCm * line.quantity;
  }

  const cubeSideCm = Math.max(5, Math.ceil(Math.cbrt(totalVolumeCm3)));

  return {
    weightGrams: Math.max(1, Math.round(totalWeightGrams)),
    lengthCm: cubeSideCm,
    widthCm: cubeSideCm,
    heightCm: cubeSideCm,
  };
}

function isValidReturnRequest(body: unknown): body is ReturnRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.orderNumber === "string" &&
    typeof b.firstName === "string" &&
    typeof b.lastName === "string" &&
    typeof b.phone === "string" &&
    typeof b.email === "string" &&
    typeof b.reasonCode === "string" &&
    Array.isArray(b.lines) &&
    b.lines.length > 0 &&
    typeof b.address === "object" &&
    b.address !== null
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  if (!isValidReturnRequest(body)) {
    const result: ReturnRequestResult = { success: false, error: "Skjemaet er ikke fullstendig utfylt." };
    return NextResponse.json(result, { status: 400 });
  }

  const reason = RETURN_REASONS.find((r) => r.code === body.reasonCode);
  if (!reason) {
    const result: ReturnRequestResult = { success: false, error: "Ugyldig returårsak." };
    return NextResponse.json(result, { status: 400 });
  }

  // Slå opp ordren på nytt server-side (ikke stol på det klienten sendte inn),
  // og valider at de valgte linjene faktisk finnes på ordren i riktig antall.
  const order = await lookupOrderByNumber(body.orderNumber);
  if (!order.found) {
    const result: ReturnRequestResult = {
      success: false,
      error: "Fant ikke ordren. Kontroller ordrenummeret og prøv igjen.",
    };
    return NextResponse.json(result, { status: 404 });
  }

  for (const selected of body.lines) {
    const line = order.lines.find((l) => l.orderLineId === selected.orderLineId);
    if (!line) {
      return NextResponse.json(
        { success: false, error: "En av de valgte varelinjene finnes ikke på ordren." } as ReturnRequestResult,
        { status: 400 }
      );
    }
    const maxReturnable = line.orderedNumberOfItems - line.alreadyReturnedNumberOfItems;
    if (selected.quantity <= 0 || selected.quantity > maxReturnable) {
      return NextResponse.json(
        {
          success: false,
          error: `Ugyldig antall for ${line.articleName}. Maks ${maxReturnable} kan returneres.`,
        } as ReturnRequestResult,
        { status: 400 }
      );
    }
  }

  // 1) Hent vekt/mål for varene som returneres fra Ongoing, og opprett
  //    selve returforsendelsen hos Webshipper (dette gir oss sporingsnummeret
  //    med det samme - vi venter IKKE på etikett-PDF-en her, se punkt 3).
  const packageDimensions = await buildPackageDimensions(body.lines);

  const shipment = await createReturnShipment({
    reference: body.orderNumber,
    customer: {
      name: `${body.firstName} ${body.lastName}`.trim(),
      street: body.address.street,
      postalCode: body.address.postalCode,
      city: body.address.city,
      countryCode: body.address.countryCode || "NO",
      email: body.email,
      phone: body.phone,
    },
    package: packageDimensions,
  });

  if (!shipment.success) {
    const result: ReturnRequestResult = {
      success: false,
      error: `Klarte ikke å opprette fraktetikett: ${shipment.errorMessage}`,
    };
    return NextResponse.json(result, { status: 502 });
  }

  // 2) Opprett returordre i Ongoing WMS med en gang, med sporingsnummeret fra
  //    forsendelsen. Dette gjøres FØR vi henter selve etikett-PDF-en, slik at
  //    returen uansett er trygt registrert i Ongoing selv om steg 3 under
  //    skulle bruke for lang tid eller feile.
  const returnOrderNumber = `${body.orderNumber}-retur1`;
  const comment = body.message
    ? `Årsak: ${reason.label}. Melding fra kunde: ${body.message}`
    : `Årsak: ${reason.label}.`;

  const ongoingResult = await createReturnOrder({
    orderId: order.orderId,
    returnOrderNumber,
    reasonCode: reason.code,
    reasonLabel: reason.label,
    comment,
    lines: body.lines,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl,
  });

  if (!ongoingResult.success) {
    const result: ReturnRequestResult = {
      success: false,
      error: `Fraktetikett ble opprettet, men returordren kunne ikke registreres i Ongoing WMS: ${ongoingResult.errorMessage}. Ta kontakt med kundeservice med referanse ${returnOrderNumber}.`,
      trackingNumber: shipment.trackingNumber,
    };
    return NextResponse.json(result, { status: 502 });
  }

  // 3) Returen er nå trygt registrert i Ongoing. Prøv å hente selve
  //    etikett-PDF-en (med et lite antall forsøk) - om den mot formodning
  //    ikke skulle være klar ennå, får kunden beskjed om å kontakte
  //    kundeservice i stedet for at hele returen står i fare.
  const label = await fetchLabelForShipment(shipment.shipmentId!);

  const result: ReturnRequestResult = {
    success: true,
    returnOrderId: ongoingResult.returnOrderId,
    returnOrderNumber,
    trackingNumber: shipment.trackingNumber,
    labelPdfBase64: label.base64PDF,
    labelUrl: shipment.trackingUrl,
    warning: !label.base64PDF
      ? "Returen er registrert og sporingsnummer er opprettet, men fraktetiketten kunne ikke hentes automatisk. Ta kontakt med kundeservice, så sender vi den til deg."
      : undefined,
  };
  return NextResponse.json(result);
}
