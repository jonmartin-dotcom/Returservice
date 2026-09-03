import { NextRequest, NextResponse } from "next/server";
import { lookupOrderByNumber } from "@/lib/ongoing";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const orderNumber = body?.orderNumber?.toString().trim();

  if (!orderNumber) {
    return NextResponse.json(
      { found: false, reason: "ERROR", message: "Ordrenummer mangler." },
      { status: 400 }
    );
  }

  const result = await lookupOrderByNumber(orderNumber);
  return NextResponse.json(result);
}
