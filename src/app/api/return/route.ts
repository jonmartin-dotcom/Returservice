import { NextRequest, NextResponse } from "next/server";
import { lookupOrderByNumber, getArticlePackageInfo, createReturnOrder } from "@/lib/ongoing";
import { createReturnShipment, fetchLabelForShipment } from "@/lib/webshipper";
import { env } from "@/lib/env";
import { RETURN_REASONS, type ReturnRequest, type ReturnRequestResult } from "@/lib/types";

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
        weightGrams: info?.weightKg ? info.weightKg * 1000 : env.defaultItemWeightGrams,
        lengthCm: info?.lengthM ? info.lengthM * 100 : env.defaultItemLengthCm,
        widthCm: info?.widthM ? info.widthM * 100 : env.defaultItemWidthCm,
        heightCm: info?.heightM ? info.heightM * 100 : env.defaultItemHeightCm,
      };
    });

    const returnOrderNumber = `RET-${body.orderNumber}-${Date.now().toString().slice(-6)}`;

    // 1) Opprett returforsendelse hos Webshipper - med riktig servicekode ut
    // fra om kunden valgte PDF-etikett eller QR-kode-retur. Dette er to
    // forskjellige Bring-produkter/servicekoder på samme Webshipper-konto.
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
        serviceCode:
          deliveryMethod === "QR" ? env.webshipperQrServiceCode : env.webshipperServiceCode,
      });
    } catch (err) {
      console.error("[api/return] Webshipper-feil:", err);
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
      trackingNumber: shipment.trackingNumber,
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

    const result: ReturnRequestResult = {
      success: true,
      returnOrderId: ongoingResult.returnOrderId,
      returnOrderNumber,
      trackingNumber: shipment.trackingNumber,
      deliveryMethod,
    };

    if (deliveryMethod === "QR") {
      // Ingen PDF å hente - Bring sender QR-koden direkte til kunden på
      // SMS og e-post. Returen er uansett registrert i Ongoing over.
    } else {
      // 3) Best-effort: hent PDF-etiketten (kort retry-budsjett, ikke kritisk).
      const label = await fetchLabelForShipment(shipment.shipmentId);
      result.labelPdfBase64 = label.labelPdfBase64;
      result.labelUrl = label.labelUrl;

      if (!label.labelPdfBase64 && !label.labelUrl) {
        result.warning =
          "Returen er registrert, men etiketten kunne ikke hentes akkurat nå. Du vil få den tilsendt på e-post.";
      }
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
