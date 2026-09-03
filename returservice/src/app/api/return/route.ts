import { NextRequest, NextResponse } from "next/server";
import { lookupOrderByNumber, createReturnOrder } from "@/lib/ongoing";
import { createReturnLabel } from "@/lib/webshipper";
import { RETURN_REASONS, type ReturnRequest, type ReturnRequestResult } from "@/lib/types";

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

  // 1) Opprett returforsendelse hos Webshipper og hent fraktetikett.
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
  };
  return NextResponse.json(result);
}
