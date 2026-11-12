import { NextRequest, NextResponse } from "next/server";
import { lookupOrderByNumber, getArticlePackageInfo, createReturnOrder } from "@/lib/ongoing";
import { createReturnShipment } from "@/lib/bring";
import { env } from "@/lib/env";
import { RETURN_REASONS, type ReturnRequest, type ReturnRequestResult } from "@/lib/types";

// Ongoing sin faktiske enhet for lengde/bredde/høyde på artikler er IKKE
// bekreftet (samme svakhet som ble funnet og fikset for Puer Fons (Ny) og
// senere bygget inn fra start i Inneklimaeksperten/Coverly - se
// prosjektnotatet). Rullet ut hit nå i forbindelse med Bring-omleggingen:
// faller tilbake på standardmål/-vekt hvis det beregnede tallet er
// urealistisk stort, i stedet for å sende et feil tall til Bring.
const MAX_REASONABLE_DIMENSION_CM = 150;
const MAX_REASONABLE_WEIGHT_KG = 30;

function safeDimensionCm(valueM: number | undefined, fallbackCm: number): number {
  if (!valueM) return fallbackCm;
  const cm = valueM * 100;
  if (!Number.isFinite(cm) || cm <= 0 || cm > MAX_REASONABLE_DIMENSION_CM) {
    console.warn(
      `[api/return] Ignorerer urealistisk mål fra Ongoing (${cm} cm, rå verdi ${valueM} m) - bruker standardmål ${fallbackCm} cm i stedet.`
    );
    return fallbackCm;
  }
  return cm;
}

function safeWeightGrams(valueKg: number | undefined, fallbackGrams: number): number {
  if (!valueKg) return fallbackGrams;
  const grams = valueKg * 1000;
  if (!Number.isFinite(grams) || grams <= 0 || valueKg > MAX_REASONABLE_WEIGHT_KG) {
    console.warn(
      `[api/return] Ignorerer urealistisk vekt fra Ongoing (${valueKg} kg) - bruker standardvekt ${fallbackGrams} g i stedet.`
    );
    return fallbackGrams;
  }
  return grams;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReturnRequest;
    const deliveryMethod = body.deliveryMethod === "QR" ? "QR" : "LABEL";

    if (
      !body?.orderNumber ||
      !body?.firstName ||
      !body?.lastName ||
      !body?.phone ||
      !body?.email ||
      !body?.reasonCode ||
      !body?.address?.street ||
      !body?.address?.postalCode ||
      !body?.address?.city ||
      !Array.isArray(body.lines) ||
      body.lines.length === 0
    ) {
      return NextResponse.json<ReturnRequestResult>(
        { success: false, error: "Mangler nødvendig informasjon i returforespørselen." },
        { status: 400 }
      );
    }

    // QR-kode-returen sendes direkte til kunden på SMS/e-post av Bring, og
    // kunden må derfor ha oppgitt begge deler - de er allerede påkrevd i
    // skjemaet, men vi sjekker eksplisitt siden det er kritisk for denne
    // leveringsmåten.
    if (deliveryMethod === "QR" && (!body.phone || !body.email)) {
      return NextResponse.json<ReturnRequestResult>(
        {
          success: false,
          error: "Mobilnummer og e-post må fylles ut for å sende QR-kode.",
        },
        { status: 400 }
      );
    }

    // Slå opp ordren på nytt for å finne riktig Ongoing orderId (kan ikke
    // trustes blindt fra klienten).
    const order = await lookupOrderByNumber(body.orderNumber);
    if (!order.found) {
      return NextResponse.json<ReturnRequestResult>(
        { success: false, error: "Fant ikke ordren i Ongoing. Prøv på nytt." },
        { status: 404 }
      );
    }

    const reason = RETURN_REASONS.find((r) => r.code === body.reasonCode);
    const reasonLabel = reason?.label || body.reasonCode;

    // Hent vekt/mål for varene som returneres, med fallback til standardmål.
    const articleNumbers = body.lines.map((l) => l.articleNumber);
    const packageInfoByArticle = await getArticlePackageInfo(articleNumbers);

    const shipmentItems = body.lines.map((line) => {
      const info = packageInfoByArticle.get(line.articleNumber);
      return {
        articleNumber: line.articleNumber,
        description: line.articleNumber,
        quantity: line.quantity,
        weightGrams: safeWeightGrams(info?.weightKg, env.defaultItemWeightGrams),
        lengthCm: safeDimensionCm(info?.lengthM, env.defaultItemLengthCm),
        widthCm: safeDimensionCm(info?.widthM, env.defaultItemWidthCm),
        heightCm: safeDimensionCm(info?.heightM, env.defaultItemHeightCm),
      };
    });

    const returnOrderNumber = `RET-${body.orderNumber}-${Date.now().toString().slice(-6)}`;

    // 1) Opprett returforsendelse direkte hos Bring - med riktig produktkode
    // ut fra om kunden valgte PDF-etikett (9300) eller QR-kode-retur (9350).
    let shipment;
    try {
      shipment = await createReturnShipment({
        fromAddress: {
          name: `${body.firstName} ${body.lastName}`,
          street: body.address.street,
          postalCode: body.address.postalCode,
          city: body.address.city,
          countryCode: body.address.countryCode || "NO",
          phone: body.phone,
          email: body.email,
        },
        items: shipmentItems,
        referenceText: returnOrderNumber,
        deliveryMethod,
      });
    } catch (err) {
      console.error("[api/return] Bring-feil:", err);
      return NextResponse.json<ReturnRequestResult>(
        {
          success: false,
          error:
            deliveryMethod === "QR"
              ? "Klarte ikke å opprette QR-returen. Vennligst prøv igjen om litt."
              : "Klarte ikke å opprette returetiketten. Vennligst prøv igjen om litt.",
        },
        { status: 502 }
      );
    }

    // 2) Opprett returordre i Ongoing - KRITISK, må ikke forsinkes av
    // etikett-henting (Vercel Hobby har kort kjøretidsgrense).
    const ongoingResult = await createReturnOrder({
      orderId: order.orderId,
      returnOrderNumber,
      reasonCode: body.reasonCode,
      reasonLabel,
      comment: body.message || "",
      lines: body.lines,
      trackingNumber: shipment.consignmentNumber,
    });

    if (!ongoingResult.success) {
      console.error("[api/return] Ongoing-feil:", ongoingResult.errorMessage);
      return NextResponse.json<ReturnRequestResult>(
        {
          success: false,
          error:
            "Returetiketten ble opprettet, men vi fikk ikke registrert returen i systemet vårt. Kontakt oss gjerne.",
        },
        { status: 502 }
      );
    }

    // Bring returnerer etikett/QR-kode direkte i bookingsvaret (synkront) -
    // ingen egen "hent etikett etterpå"-runde nødvendig slik det var med
    // Webshipper.
    const result: ReturnRequestResult = {
      success: true,
      returnOrderId: ongoingResult.returnOrderId,
      returnOrderNumber,
      trackingNumber: shipment.consignmentNumber,
      deliveryMethod,
      labelPdfBase64: shipment.labelPdfBase64,
      labelUrl: shipment.labelUrl,
      qrCodeLink: shipment.qrCodeLink,
      labelFreeCode: shipment.labelFreeCode,
    };

    if (deliveryMethod === "LABEL" && !shipment.labelPdfBase64 && !shipment.labelUrl) {
      result.warning =
        "Returen er registrert, men etiketten kunne ikke hentes akkurat nå. Du vil få den tilsendt på e-post.";
    }
    if (deliveryMethod === "QR" && !shipment.qrCodeLink && !shipment.labelFreeCode) {
      result.warning =
        "Returen er registrert, men QR-koden kunne ikke hentes akkurat nå. Du vil få den tilsendt på SMS/e-post fra Bring.";
    }

    return NextResponse.json<ReturnRequestResult>(result);
  } catch (err) {
    console.error("[api/return] uventet feil:", err);
    return NextResponse.json<ReturnRequestResult>(
      { success: false, error: "Noe gikk galt. Vennligst prøv igjen." },
      { status: 500 }
    );
  }
}
