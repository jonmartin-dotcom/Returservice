import { NextRequest, NextResponse } from "next/server";
import { lookupOrderByNumber, createReturnOrder, getArticlePackageInfo } from "@/lib/ongoing";
import { createReturnLabel, type PackageDimensions } from "@/lib/webshipper";
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
  //    returforsendelse hos Webshipper for å hente fraktetikett.
  const packageDimensions = await buildPackageDimensions(body.lines);

  const label = await createReturnLabel({
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

  if (!label.success) {
    const result: ReturnRequestResult = {
      success: false,
      error: `Klarte ikke å opprette fraktetikett: ${label.errorMessage}`,
    };
    return NextResponse.json(result, { status: 502 });
  }

  // 2) Opprett returordre i Ongoing WMS, med sporingsnummeret fra etiketten.
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
    trackingNumber: label.trackingNumber,
    trackingUrl: label.trackingUrl,
  });

  if (!ongoingResult.success) {
    // Etiketten er allerede generert på dette tidspunktet. Vi returnerer den likevel
    // til kunden (så de ikke blir stående uten etikett), men flagger feilen tydelig
    // slik at dere kan følge opp returordren manuelt i Ongoing.
    const result: ReturnRequestResult = {
      success: false,
      error: `Fraktetikett ble opprettet, men returordren kunne ikke registreres i Ongoing WMS: ${ongoingResult.errorMessage}. Ta kontakt med kundeservice med referanse ${returnOrderNumber}.`,
      trackingNumber: label.trackingNumber,
      labelPdfBase64: label.labelPdfBase64,
    };
    return NextResponse.json(result, { status: 502 });
  }

  const result: ReturnRequestResult = {
    success: true,
    returnOrderId: ongoingResult.returnOrderId,
    returnOrderNumber,
    trackingNumber: label.trackingNumber,
    labelPdfBase64: label.labelPdfBase64,
    labelUrl: label.trackingUrl,
    warning: !label.labelPdfBase64
      ? "Returen er registrert og sporingsnummer er opprettet, men fraktetiketten kunne ikke hentes automatisk. Ta kontakt med kundeservice for å få tilsendt etiketten."
      : undefined,
  };
  return NextResponse.json(result);
}
