"use client";

import { useState } from "react";
import styles from "./page.module.css";
import type {
  OrderLookupResponse,
  ReturnReasonCode,
  ReturnRequestResult,
} from "@/lib/types";
import { RETURN_REASONS } from "@/lib/types";

type Step = "order" | "details" | "contact" | "done";

interface SelectedLine {
  orderLineId: number;
  articleNumber: string;
  name: string;
  maxQuantity: number;
  quantity: number;
  selected: boolean;
}

export default function ReturPage() {
  const [step, setStep] = useState<Step>("order");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [orderNumber, setOrderNumber] = useState("");
  const [order, setOrder] = useState<Extract<OrderLookupResponse, { found: true }> | null>(null);
  const [lines, setLines] = useState<SelectedLine[]>([]);
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode>("ANGRER_KJOP");
  const [message, setMessage] = useState("");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [street, setStreet] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");

  const [result, setResult] = useState<ReturnRequestResult | null>(null);

  async function handleLookupOrder(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/order/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber }),
      });
      const data: OrderLookupResponse = await res.json();
      if (!data.found) {
        setError(data.message);
        return;
      }
      setOrder(data);
      setLines(
        data.lines.map((l) => ({
          orderLineId: l.orderLineId,
          articleNumber: l.articleNumber,
          name: l.articleName,
          maxQuantity: l.orderedNumberOfItems - l.alreadyReturnedNumberOfItems,
          quantity: l.orderedNumberOfItems - l.alreadyReturnedNumberOfItems,
          selected: false,
        }))
      );
      setStep("details");
    } catch {
      setError("Noe gikk galt. Prøv igjen om litt.");
    } finally {
      setLoading(false);
    }
  }

  function handleDetailsNext(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const chosen = lines.filter((l) => l.selected);
    if (chosen.length === 0) {
      setError("Velg minst én vare du ønsker å returnere.");
      return;
    }
    for (const l of chosen) {
      if (l.quantity < 1 || l.quantity > l.maxQuantity) {
        setError(`Ugyldig antall for ${l.name}.`);
        return;
      }
    }
    setStep("contact");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const chosen = lines.filter((l) => l.selected);
      const res = await fetch("/api/return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderNumber,
          firstName,
          lastName,
          phone,
          email,
          reasonCode,
          message,
          lines: chosen.map((l) => ({
            orderLineId: l.orderLineId,
            articleNumber: l.articleNumber,
            quantity: l.quantity,
          })),
          address: { street, postalCode, city, countryCode: "NO" },
        }),
      });
      const data: ReturnRequestResult = await res.json();
      setResult(data);
      if (!data.success) {
        setError(data.error || "Noe gikk galt under registrering av returen.");
      } else {
        setStep("done");
      }
    } catch {
      setError("Noe gikk galt. Prøv igjen om litt.");
    } finally {
      setLoading(false);
    }
  }

  function downloadLabel() {
    if (!result?.labelPdfBase64) return;
    const byteChars = atob(result.labelPdfBase64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `returetikett-${result.returnOrderNumber || orderNumber}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logoSlot}>
          <div className={styles.logoPlaceholder}>LOGO</div>
          <h1 className={styles.title}>Returservice</h1>
        </div>

        {step === "order" && (
          <>
            <div className={styles.intro}>
              Vi har åpent kjøp og bytterett i henhold til angrerettloven. Varen(e) må
              være ubrukt og i original stand.
              <ol>
                <li>Fyll inn ordrenummeret ditt for å hente opp ordren.</li>
                <li>Velg hvilke varer du ønsker å returnere og oppgi årsak.</li>
                <li>Skriv ut fraktetiketten du får, og send pakken i retur.</li>
              </ol>
            </div>
            {error && <div className={styles.errorBox}>{error}</div>}
            <form onSubmit={handleLookupOrder}>
              <div className={styles.field}>
                <label htmlFor="orderNumber">Ordrenummer*</label>
                <input
                  id="orderNumber"
                  required
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  placeholder="f.eks. 100234"
                />
              </div>
              <div className={styles.actions} style={{ justifyContent: "flex-end" }}>
                <button type="submit" className={styles.primaryButton} disabled={loading}>
                  {loading ? "Henter ordre …" : "Finn ordre"}
                </button>
              </div>
            </form>
          </>
        )}

        {step === "details" && order && (
          <>
            <div className={styles.stepIndicator}>Steg 2 av 3</div>
            {error && <div className={styles.errorBox}>{error}</div>}
            <form onSubmit={handleDetailsNext}>
              <div className={styles.field}>
                <label>Velg varer som skal returneres</label>
                {lines.map((line, idx) => (
                  <div className={styles.lineRow} key={line.orderLineId}>
                    <input
                      type="checkbox"
                      checked={line.selected}
                      onChange={(e) => {
                        const next = [...lines];
                        next[idx] = { ...line, selected: e.target.checked };
                        setLines(next);
                      }}
                    />
                    <div className={styles.lineInfo}>
                      <div className={styles.name}>{line.name}</div>
                      <div className={styles.meta}>
                        Varenr. {line.articleNumber || "-"} · maks {line.maxQuantity} stk
                      </div>
                    </div>
                    <input
                      type="number"
                      className={styles.lineQty}
                      min={1}
                      max={line.maxQuantity}
                      value={line.quantity}
                      disabled={!line.selected}
                      onChange={(e) => {
                        const next = [...lines];
                        next[idx] = { ...line, quantity: Number(e.target.value) };
                        setLines(next);
                      }}
                    />
                  </div>
                ))}
              </div>

              <div className={styles.field}>
                <label>Returårsak*</label>
                <div className={styles.reasonGroup}>
                  {RETURN_REASONS.map((r) => (
                    <label className={styles.reasonOption} key={r.code}>
                      <input
                        type="radio"
                        name="reason"
                        checked={reasonCode === r.code}
                        onChange={() => setReasonCode(r.code)}
                      />
                      {r.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className={styles.field}>
                <label htmlFor="message">Melding (valgfritt)</label>
                <textarea
                  id="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Eventuell tilleggsinfo til kundeservice"
                />
              </div>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setStep("order")}
                >
                  Tilbake
                </button>
                <button type="submit" className={styles.primaryButton}>
                  Neste
                </button>
              </div>
            </form>
          </>
        )}

        {step === "contact" && (
          <>
            <div className={styles.stepIndicator}>Steg 3 av 3</div>
            {error && <div className={styles.errorBox}>{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className={styles.row2}>
                <div className={styles.field}>
                  <label htmlFor="firstName">Fornavn*</label>
                  <input
                    id="firstName"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="lastName">Etternavn*</label>
                  <input
                    id="lastName"
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>
              </div>
              <div className={styles.row2}>
                <div className={styles.field}>
                  <label htmlFor="phone">Telefon*</label>
                  <input
                    id="phone"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="email">E-post*</label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>
              <div className={styles.field}>
                <label htmlFor="street">Adresse (for henting/frakt av returen)*</label>
                <input
                  id="street"
                  required
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                />
              </div>
              <div className={styles.row3}>
                <div className={styles.field}>
                  <label htmlFor="city">Sted*</label>
                  <input
                    id="city"
                    required
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="postalCode">Postnr*</label>
                  <input
                    id="postalCode"
                    required
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setStep("details")}
                >
                  Tilbake
                </button>
                <button type="submit" className={styles.primaryButton} disabled={loading}>
                  {loading ? "Sender …" : "Send retur"}
                </button>
              </div>
            </form>
          </>
        )}

        {step === "done" && result?.success && (
          <div className={styles.successBox}>
            <h2>Returen er registrert</h2>
            <p>
              Referanse: {result.returnOrderNumber}
              {result.trackingNumber ? ` · Sporingsnr: ${result.trackingNumber}` : ""}
            </p>
            {result.labelPdfBase64 ? (
              <button className={styles.primaryButton} onClick={downloadLabel}>
                Last ned fraktetikett (PDF)
              </button>
            ) : result.labelUrl ? (
              <a className={styles.primaryButton} href={result.labelUrl} target="_blank" rel="noreferrer">
                Åpne fraktetikett
              </a>
            ) : (
              <p>Du vil motta fraktetiketten på e-post.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
