const PDFDocument = require('pdfkit');

const DEFAULT_PRIMARY = '#5046e4';
const MUTED   = '#6b7280';
const BORDER  = '#e5e7eb';
const DARK    = '#111827';

function formatMoney(amount, currency = 'KES') {
  const n = Number(amount) || 0;
  // Locale-aware formatting; pdfkit standard fonts handle ASCII fine
  return `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date) {
  if (!date) return '—';
  const d = new Date(date);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Validate a user-supplied hex so a corrupt value can't crash pdfkit's
// fillColor parser. Returns the color or the fallback.
function safeColor(hex, fallback) {
  return (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) ? hex : fallback;
}

// Fetch the logo into a Buffer before we start streaming the PDF.
// pdfkit's image() needs a buffer/path, not a URL or stream. We swallow
// any failure (timeout, 404, network) and just render without a logo —
// the rest of the document is far more important than the logo.
async function fetchLogoBuffer(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    // pdfkit only handles PNG and JPEG. SVG/WebP/etc. would throw.
    if (!ct.includes('png') && !ct.includes('jpeg') && !ct.includes('jpg')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Defensive size cap — bail on anything implausibly large (5MB)
    if (buf.length > 5 * 1024 * 1024) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Stream a PDF for an invoice or quote into the given response.
 * Caller is responsible for setting Content-Type / Disposition headers.
 *
 * Async because we may need to fetch the logo image into a buffer before
 * pdfkit can embed it — pdfkit doesn't accept URLs directly.
 *
 * @param {object} doc  — populated Document (mongoose doc or lean object)
 * @param {Writable} stream — e.g. Express res
 */
async function renderDocumentPdf(doc, stream) {
  // Resolve branding up front. Quotes always use the cyan accent regardless
  // of the org's brand color — invoices use the org color so the "pay" CTA
  // and total feel native.
  const isInvoice = doc.type === 'invoice';
  const orgBrand   = safeColor(doc.fromBrandColor, DEFAULT_PRIMARY);
  const titleColor = isInvoice ? orgBrand : '#0891b2';

  const logoBuffer = await fetchLogoBuffer(doc.fromLogoUrl);

  const pdf = new PDFDocument({ size: 'A4', margin: 50 });
  pdf.pipe(stream);

  const heading = isInvoice ? 'INVOICE' : 'QUOTE';

  // ── Header ────────────────────────────────────────────────────────────────
  // If the org has a logo, render it to the left of the business name and
  // shift the text right. Logo is constrained to a 60px box so a tall logo
  // doesn't push everything else down the page.
  let textX = 50;
  if (logoBuffer) {
    try {
      pdf.image(logoBuffer, 50, 45, { fit: [60, 60] });
      textX = 120;
    } catch {
      // Malformed image (rare — fetchLogoBuffer already filtered by content-type)
    }
  }

  pdf.fillColor(DARK).fontSize(24).font('Helvetica-Bold').text(doc.fromBusinessName || 'Business', textX, 50);
  pdf.fontSize(9).font('Helvetica').fillColor(MUTED);
  if (doc.fromEmail)   pdf.text(doc.fromEmail,   textX, undefined);
  if (doc.fromPhone)   pdf.text(doc.fromPhone,   textX, undefined);
  if (doc.fromAddress) pdf.text(doc.fromAddress, textX, undefined, { width: 220 });

  pdf.fontSize(28).font('Helvetica-Bold').fillColor(titleColor)
     .text(heading, 400, 50, { width: 145, align: 'right' });
  pdf.fontSize(10).font('Helvetica').fillColor(DARK)
     .text(doc.number, 400, 84, { width: 145, align: 'right' });

  // Status pill (top right, under number)
  const status = (doc.status || 'draft').toUpperCase();
  pdf.fontSize(8).fillColor(MUTED).text(status, 400, 100, { width: 145, align: 'right' });

  // ── Bill-to / Issue-Due block ─────────────────────────────────────────────
  let y = 140;
  pdf.fontSize(9).font('Helvetica-Bold').fillColor(MUTED).text('BILL TO', 50, y);
  pdf.fontSize(11).font('Helvetica-Bold').fillColor(DARK).text(doc.customerName || '', 50, y + 14);
  pdf.fontSize(9).font('Helvetica').fillColor(MUTED);
  let cy = y + 30;
  if (doc.customerCompany) { pdf.text(doc.customerCompany, 50, cy); cy += 12; }
  if (doc.customerEmail)   { pdf.text(doc.customerEmail,   50, cy); cy += 12; }
  if (doc.customerPhone)   { pdf.text(doc.customerPhone,   50, cy); cy += 12; }
  if (doc.customerAddress) { pdf.text(doc.customerAddress, 50, cy, { width: 240 }); }

  // Right column dates
  pdf.fontSize(9).font('Helvetica-Bold').fillColor(MUTED).text('ISSUE DATE', 380, y);
  pdf.fontSize(10).font('Helvetica').fillColor(DARK).text(formatDate(doc.issueDate), 380, y + 14);

  if (doc.dueDate) {
    pdf.fontSize(9).font('Helvetica-Bold').fillColor(MUTED)
       .text(isInvoice ? 'DUE DATE' : 'VALID UNTIL', 380, y + 36);
    pdf.fontSize(10).font('Helvetica').fillColor(DARK).text(formatDate(doc.dueDate), 380, y + 50);
  }

  // ── Items table ───────────────────────────────────────────────────────────
  const tableTop = Math.max(cy, y + 80) + 30;
  const cols = { description: 50, qty: 320, unit: 380, amount: 470 };
  const colWidths = { description: 260, qty: 50, unit: 80, amount: 75 };

  // Header row
  pdf.rect(50, tableTop - 5, 495, 24).fillColor('#f9fafb').fill();
  pdf.fontSize(9).font('Helvetica-Bold').fillColor(MUTED);
  pdf.text('DESCRIPTION', cols.description, tableTop + 3, { width: colWidths.description });
  pdf.text('QTY',         cols.qty,         tableTop + 3, { width: colWidths.qty,    align: 'right' });
  pdf.text('UNIT PRICE',  cols.unit,        tableTop + 3, { width: colWidths.unit,   align: 'right' });
  pdf.text('AMOUNT',      cols.amount,      tableTop + 3, { width: colWidths.amount, align: 'right' });

  // Rows
  let rowY = tableTop + 28;
  pdf.font('Helvetica').fontSize(10).fillColor(DARK);
  (doc.items || []).forEach((it) => {
    const descHeight = pdf.heightOfString(it.description || '', { width: colWidths.description });
    const rowH = Math.max(descHeight + 8, 22);

    pdf.fillColor(DARK).text(it.description || '', cols.description, rowY, { width: colWidths.description });
    pdf.text(String(it.quantity ?? 0), cols.qty, rowY, { width: colWidths.qty, align: 'right' });
    pdf.text(formatMoney(it.unitPrice, doc.currency), cols.unit, rowY, { width: colWidths.unit, align: 'right' });
    pdf.text(formatMoney(it.amount,    doc.currency), cols.amount, rowY, { width: colWidths.amount, align: 'right' });

    rowY += rowH;
    pdf.strokeColor(BORDER).lineWidth(0.5).moveTo(50, rowY - 4).lineTo(545, rowY - 4).stroke();
  });

  // ── Totals ────────────────────────────────────────────────────────────────
  let totalsY = rowY + 14;
  const labelX = 380;
  const valueX = 470;

  pdf.fontSize(10).font('Helvetica').fillColor(MUTED);
  pdf.text('Subtotal', labelX, totalsY, { width: 80, align: 'right' });
  pdf.fillColor(DARK).text(formatMoney(doc.subtotal, doc.currency), valueX, totalsY, { width: 75, align: 'right' });
  totalsY += 16;

  if ((doc.taxRate || 0) > 0) {
    pdf.fillColor(MUTED).text(`Tax (${doc.taxRate}%)`, labelX, totalsY, { width: 80, align: 'right' });
    pdf.fillColor(DARK).text(formatMoney(doc.taxAmount, doc.currency), valueX, totalsY, { width: 75, align: 'right' });
    totalsY += 16;
  }

  pdf.strokeColor(BORDER).lineWidth(1).moveTo(labelX, totalsY).lineTo(545, totalsY).stroke();
  totalsY += 8;

  pdf.fontSize(13).font('Helvetica-Bold').fillColor(titleColor)
     .text('TOTAL', labelX, totalsY, { width: 80, align: 'right' });
  pdf.fillColor(DARK).text(formatMoney(doc.total, doc.currency), valueX, totalsY, { width: 75, align: 'right' });

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (doc.notes) {
    pdf.fontSize(9).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', 50, totalsY + 50);
    pdf.fontSize(10).font('Helvetica').fillColor(DARK).text(doc.notes, 50, totalsY + 64, { width: 320 });
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  // Org-configured footer wins. Fall back to a sensible default per type.
  const defaultFooter = isInvoice
    ? `Thank you for your business · Reply to ${doc.fromEmail || ''} for questions`
    : `This quote is valid until ${formatDate(doc.dueDate) || 'further notice'}`;
  const footerText = (typeof doc.fromFooterText === 'string' && doc.fromFooterText.trim())
    ? doc.fromFooterText.trim()
    : defaultFooter;

  const footerY = pdf.page.height - 60;
  pdf.fontSize(8).font('Helvetica').fillColor(MUTED)
     .text(footerText, 50, footerY, { width: 495, align: 'center' });

  pdf.end();
}

module.exports = { renderDocumentPdf, formatMoney, formatDate };
