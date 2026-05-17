// PrintableStatement — portal-mounted printable customer-statement
// body. Same mechanism as PrintableReceipt; different content.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatMoney } from '../../shared/lib/money';
import {
  formatReceiptDate, logPrintAttempt,
  type ReceiptShop, type StatementData,
} from '../lib/printing';

interface Props {
  shop: ReceiptShop;
  data: StatementData;
  onDone: () => void;
}

export default function PrintableStatement({
  shop, data, onDone,
}: Props): JSX.Element {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    const t = setTimeout(() => {
      try {
        window.print();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('window.print failed:', err);
      }
      logPrintAttempt('STATEMENT', data.customer.customerId, {
        currentBalancePesewas: data.customer.currentBalancePesewas,
        openInvoiceCount: data.openInvoices.length,
        asOfISO: data.asOfISO,
      });
      onDone();
    }, 50);
    return () => clearTimeout(t);
  }, [data, onDone]);

  return createPortal(
    <div className="print-portal">
      <div className="receipt-printable">
        <div className="receipt-header" style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{shop.shopName || 'Counter'}</div>
          {shop.shopSubtitle && <div style={{ fontSize: 11 }}>{shop.shopSubtitle}</div>}
          {shop.ownerPhone && <div style={{ fontSize: 11 }}>{shop.ownerPhone}</div>}
        </div>
        <Hr />
        <div style={{ textAlign: 'center', fontWeight: 700 }}>CUSTOMER STATEMENT</div>
        <div style={{ textAlign: 'center', fontSize: 10 }}>As of {formatReceiptDate(data.asOfISO)}</div>
        <Hr />
        <div style={{ fontWeight: 700 }}>{data.customer.displayName}</div>
        <div style={{ fontSize: 11 }}>{data.customer.phone}</div>
        {data.customer.blocked && (
          <div style={{ fontWeight: 700, fontSize: 11 }}>ACCOUNT BLOCKED</div>
        )}
        <Hr />
        <Row label="Credit limit"   value={`₵${formatMoney(data.customer.creditLimitPesewas)}`} />
        <Row label="Currently owed" value={`₵${formatMoney(data.customer.currentBalancePesewas)}`} bold />
        <Hr />
        <div style={{ fontWeight: 700 }}>Open invoices</div>
        {data.openInvoices.length === 0 ? (
          <div style={{ fontSize: 11 }}>No open invoices.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {data.openInvoices.map((inv) => (
                <tr key={inv.saleId}>
                  <td style={{ padding: '1px 0' }}>
                    {formatReceiptDate(inv.createdAtISO)}<br />
                    <span style={{ fontSize: 10 }}>{inv.saleId}</span>
                  </td>
                  <td style={{ padding: '1px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    ₵{formatMoney(inv.remainingPesewas)}<br />
                    <span style={{ fontSize: 10 }}>of ₵{formatMoney(inv.totalPesewas)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Hr />
        <div style={{ fontWeight: 700 }}>Recent payments</div>
        {data.recentPayments.length === 0 ? (
          <div style={{ fontSize: 11 }}>No recent payments.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {data.recentPayments.map((p) => (
                <tr key={p.paymentId}>
                  <td style={{ padding: '1px 0' }}>
                    {formatReceiptDate(p.createdAtISO)}<br />
                    <span style={{ fontSize: 10 }}>{p.paymentMethod}</span>
                  </td>
                  <td style={{ padding: '1px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    ₵{formatMoney(p.amountPesewas)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Hr />
        <div style={{ textAlign: 'center', fontSize: 10 }}>Please settle outstanding balance.</div>
      </div>
    </div>,
    document.body,
  );
}

function Row({
  label, value, bold = false,
}: { label: string; value: string; bold?: boolean }): JSX.Element {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 4,
      fontWeight: bold ? 700 : 400,
    }}>
      <span>{label}</span>
      <span style={{ whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

function Hr(): JSX.Element {
  return <hr style={{ border: 0, borderTop: '1px dashed #000', margin: '4px 0' }} />;
}
