// PrintableReceipt — portal-mounted printable receipt body.
//
// Rendered conditionally by SaleScreen (and any other caller) once
// there's a sale to print. Portals itself to document.body so it sits
// as a direct child of <body>, NOT inside #root — the @media print
// CSS hides #root and shows the portal, leaving exactly the receipt
// on the printed page.
//
// On mount: triggers window.print() (synchronous in Chromium — blocks
// until the user dismisses the OS print dialog), logs the attempt to
// audit_log, then calls onDone() so the parent can unmount.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';
import {
  formatReceiptDate, logPrintAttempt,
  type ReceiptShop, type ReceiptData,
} from '../lib/printing';

interface Props {
  shop: ReceiptShop;
  data: ReceiptData;
  reprint?: boolean;
  onDone: () => void;
}

export default function PrintableReceipt({
  shop, data, reprint = false, onDone,
}: Props): JSX.Element {
  // Ensure we only print once even if React strict-mode double-fires
  // the effect or props change mid-print.
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    // One paint tick before triggering print so the portal content
    // is laid out before window.print captures the page.
    const t = setTimeout(() => {
      try {
        window.print();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('window.print failed:', err);
      }
      logPrintAttempt(
        reprint ? 'REPRINT_RECEIPT' : 'RECEIPT',
        data.saleId,
        {
          totalPesewas: data.totalPesewas,
          lineCount: data.lines.length,
          cashierName: data.cashierName,
          ...(data.customerName ? { customerName: data.customerName } : {}),
        },
      );
      onDone();
    }, 50);
    return () => clearTimeout(t);
  }, [data, reprint, onDone]);

  const tenderRows: JSX.Element[] = [];
  if (data.cashPaidPesewas > 0) tenderRows.push(
    <Row key="cash"   label="Cash"      value={`₵${formatMoney(data.cashPaidPesewas)}`} />,
  );
  if (data.momoPaidPesewas > 0) tenderRows.push(
    <Row key="momo"   label="MoMo"      value={`₵${formatMoney(data.momoPaidPesewas)}`} />,
  );
  if (data.bankPaidPesewas > 0) tenderRows.push(
    <Row key="bank"   label="Bank"      value={`₵${formatMoney(data.bankPaidPesewas)}`} />,
  );
  if (data.creditPesewas > 0) tenderRows.push(
    <Row key="credit" label="On credit" value={`₵${formatMoney(data.creditPesewas)}`} bold />,
  );
  if (data.changePesewas > 0) tenderRows.push(
    <Row key="change" label="Change due" value={`₵${formatMoney(data.changePesewas)}`} />,
  );

  return createPortal(
    <div className="print-portal">
      <div className="receipt-printable">
        <div className="receipt-header" style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{shop.shopName || 'Counter'}</div>
          {shop.shopSubtitle && <div style={{ fontSize: 11 }}>{shop.shopSubtitle}</div>}
          {shop.ownerPhone && <div style={{ fontSize: 11 }}>{shop.ownerPhone}</div>}
          {reprint && <div style={{ fontSize: 11, fontWeight: 700 }}>— REPRINT —</div>}
        </div>
        <Hr />
        <div style={{ fontSize: 11 }}>
          <Row label="Date"     value={formatReceiptDate(data.createdAtISO)} />
          <Row label="Cashier"  value={data.cashierName} />
          {data.customerName && <Row label="Customer" value={data.customerName} />}
          <Row label="Channel"  value={data.channel.replace('_', ' ')} />
        </div>
        <Hr />
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={i}>
                <td style={{ padding: '1px 0' }}>{l.productName}</td>
                <td style={{ padding: '1px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {l.quantity} × ₵{formatMoney(l.unitPricePesewas)}
                </td>
                <td style={{ padding: '1px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  ₵{formatMoney(l.unitPricePesewas * l.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Hr />
        <Row label="TOTAL" value={formatMoneyWithCurrency(data.totalPesewas)} bold large />
        <Hr />
        {tenderRows}
        <Hr />
        <div style={{ textAlign: 'center', fontSize: 11, paddingTop: 4 }}>Thank you!</div>
        <div style={{ textAlign: 'center', fontSize: 10 }}>{data.saleId}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---- internal layout primitives ------------------------------------------

function Row({
  label, value, bold = false, large = false,
}: { label: string; value: string; bold?: boolean; large?: boolean }): JSX.Element {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 4,
      fontWeight: bold ? 700 : 400,
      fontSize: large ? 14 : undefined,
    }}>
      <span>{label}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

function Hr(): JSX.Element {
  return <hr style={{ border: 0, borderTop: '1px dashed #000', margin: '4px 0' }} />;
}
