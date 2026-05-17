// StocktakeScreen — cycle counting / inventory truth. Wave B.1.
//
// Three states:
//   1. No open session — show recent sessions, "Open session" button.
//   2. Open session — product search + counted-qty entry. Each
//      submitted line shows expected vs counted with the delta.
//      Lines table is live-editable until close.
//   3. Closed/Cancelled session — read-only review.
//
// Close is OWNER-only and writes STOCKTAKE_ADJUSTMENT
// stock_movements for every non-zero delta. Any |delta| > 10 units
// requires a supervisor PIN (SupervisorPinModal, purpose
// STOCKTAKE_LARGE_DELTA). The threshold and large-delta flow are in
// the service; the UI just surfaces the rejection.

import { useEffect, useState } from 'react';
import { useSession } from '../store/session';
import { counter } from '../lib/ipc';
import SupervisorPinModal from '../components/SupervisorPinModal';
import type {
  StocktakeEventRowDto, StocktakeLineRowDto, ProductSummary,
} from '../../shared/types/ipc';

interface Props { onBack: () => void }

export default function StocktakeScreen({ onBack }: Props): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwnerLike = role === 'OWNER' || role === 'FOUNDER';

  const [locationId, setLocationId] = useState<string | null>(null);
  const [events, setEvents] = useState<StocktakeEventRowDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<StocktakeLineRowDto[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [productPick, setProductPick] = useState('');
  const [countText, setCountText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinPrompt, setPinPrompt] = useState<{
    onApproved: (approvalId: string) => Promise<void>;
    reason: string;
    context: Record<string, unknown>;
  } | null>(null);

  async function refreshEvents() {
    if (!locationId) return;
    const r = await counter.stocktakeList({ locationId, limit: 30 });
    if (r.success) {
      setEvents(r.data.events);
      const open = r.data.events.find((e) => e.status === 'OPEN');
      if (open && !selectedId) setSelectedId(open.id);
    } else { setError(r.error); }
  }
  async function refreshLines() {
    if (!selectedId) { setLines([]); return; }
    const r = await counter.stocktakeLines({ stocktakeEventId: selectedId });
    if (r.success) setLines(r.data.lines);
  }

  useEffect(() => {
    (async () => {
      const d = await counter.deviceConfig();
      if (d.success && d.data.defaultLocationId) {
        setLocationId(d.data.defaultLocationId);
      }
      const p = await counter.listProducts();
      if (p.success) setProducts(p.data.products);
    })();
  }, []);
  useEffect(() => { void refreshEvents(); }, [locationId]);
  useEffect(() => { void refreshLines(); }, [selectedId]);

  const selected = events.find((e) => e.id === selectedId);
  const isOpen = selected?.status === 'OPEN';

  async function openSession() {
    if (!locationId) return;
    setBusy(true);
    const r = await counter.stocktakeOpen({ locationId });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setSelectedId(r.data.stocktakeEventId);
    await refreshEvents();
  }

  async function recordCount(productId: string, counted: number) {
    if (!selectedId) return;
    setError(null);
    const r = await counter.stocktakeRecord({
      stocktakeEventId: selectedId,
      productId,
      countedQty: counted,
    });
    if (!r.success) { setError(r.error); return; }
    setCountText('');
    setProductPick('');
    await refreshLines();
  }

  async function closeCore(supervisorApprovalId?: string) {
    if (!selectedId) return;
    setBusy(true);
    const r = await counter.stocktakeClose({
      stocktakeEventId: selectedId,
      supervisorApprovalId,
    });
    setBusy(false);
    if (!r.success) {
      // Large-delta gate: error message says a supervisor PIN is needed.
      if (/supervisor PIN/i.test(r.error)) {
        const big = lines.filter((l) => Math.abs(l.deltaQty) > 10);
        setPinPrompt({
          reason: `${big.length} product(s) have a delta over 10 units. A supervisor must approve closing this stocktake.`,
          context: { stocktakeEventId: selectedId, largeDeltaCount: big.length },
          onApproved: async (approvalId) => {
            setPinPrompt(null);
            await closeCore(approvalId);
          },
        });
        return;
      }
      setError(r.error); return;
    }
    window.alert(`Stocktake closed. ${r.data.adjustmentsWritten} adjustment(s) written, total |delta| ${r.data.totalAbsoluteDelta} units.`);
    await refreshEvents();
    await refreshLines();
  }

  async function cancelSession() {
    if (!selectedId) return;
    const reason = window.prompt('Cancel this stocktake — reason?');
    if (!reason || reason.trim().length < 3) return;
    const r = await counter.stocktakeCancel({ stocktakeEventId: selectedId, reason: reason.trim() });
    if (!r.success) { setError(r.error); return; }
    await refreshEvents();
    await refreshLines();
  }

  const productMatches = products.filter((p) => {
    if (!productPick.trim()) return false;
    const q = productPick.toLowerCase().trim();
    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
  }).slice(0, 6);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="flex items-baseline gap-4">
          <button onClick={onBack} className="text-text-tertiary hover:text-text-primary text-sm">← Home</button>
          <div className="text-xl font-semibold tracking-tight">Stocktake</div>
        </div>
        {!selected || selected.status !== 'OPEN' ? (
          isOwnerLike && (
            <button
              onClick={() => void openSession()}
              disabled={busy || events.some((e) => e.status === 'OPEN')}
              className="px-3 py-1.5 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50"
            >
              {busy ? 'Opening…' : '+ Open session'}
            </button>
          )
        ) : (
          isOwnerLike && (
            <div className="space-x-2">
              <button
                onClick={() => void cancelSession()}
                className="px-3 py-1.5 border border-danger text-danger text-sm hover:bg-danger hover:text-bg-deep"
              >Cancel</button>
              <button
                onClick={() => void closeCore()}
                disabled={busy || lines.length === 0}
                className="px-3 py-1.5 bg-warning text-bg-deep font-semibold text-sm disabled:opacity-50"
              >
                {busy ? 'Closing…' : 'Close session'}
              </button>
            </div>
          )
        )}
      </header>

      {error && (
        <div className="m-4 border border-danger bg-danger/10 text-danger px-3 py-2 text-sm rounded">
          {error}
        </div>
      )}

      <div className="flex-1 grid grid-cols-3 gap-4 p-4 overflow-hidden">
        {/* Left: session list */}
        <div className="overflow-auto space-y-1 border-r border-border pr-4">
          <div className="text-xs text-text-secondary uppercase tracking-wider mb-2">Sessions</div>
          {events.length === 0 ? (
            <div className="text-text-tertiary text-sm">No stocktake sessions yet.</div>
          ) : events.map((e) => (
            <button
              key={e.id}
              onClick={() => setSelectedId(e.id)}
              className={[
                'block w-full text-left px-3 py-2 border text-sm',
                selectedId === e.id ? 'border-accent bg-bg-elevated' : 'border-border hover:bg-bg-elevated',
              ].join(' ')}
            >
              <div className="flex items-baseline justify-between">
                <span>{new Date(e.openedAt).toLocaleDateString()}</span>
                <span className={[
                  'text-xs',
                  e.status === 'OPEN' ? 'text-accent'
                  : e.status === 'CLOSED' ? 'text-text-tertiary' : 'text-danger',
                ].join(' ')}>{e.status}</span>
              </div>
              <div className="text-xs text-text-tertiary font-mono tnum">
                {e.lineCount} line{e.lineCount === 1 ? '' : 's'} · |Δ| {e.totalAbsoluteDelta}
              </div>
            </button>
          ))}
        </div>

        {/* Right: lines + count entry */}
        <div className="col-span-2 overflow-auto space-y-3">
          {!selected ? (
            <div className="text-sm text-text-tertiary">Select or open a session.</div>
          ) : (
            <>
              <div className="text-xs text-text-tertiary">
                {selected.locationName} · opened {new Date(selected.openedAt).toLocaleString()}
                {selected.openedByName && ` by ${selected.openedByName}`}
              </div>

              {isOpen && (
                <div className="border border-border rounded p-3 space-y-2 bg-bg-elevated">
                  <div className="text-xs text-text-secondary uppercase tracking-wider">Record count</div>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        value={productPick}
                        onChange={(e) => setProductPick(e.target.value)}
                        placeholder="Search product…"
                        className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
                      />
                      {productMatches.length > 0 && (
                        <div className="absolute left-0 right-0 top-full mt-1 bg-bg-surface border border-border z-10 max-h-48 overflow-auto shadow">
                          {productMatches.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => {
                                const n = parseInt(countText, 10);
                                if (Number.isFinite(n) && n >= 0) {
                                  void recordCount(p.id, n);
                                } else {
                                  setError('Enter a counted quantity first.');
                                }
                              }}
                              className="block w-full text-left px-3 py-2 hover:bg-bg-elevated text-sm border-b border-border"
                            >
                              <div>{p.name}</div>
                              <div className="text-xs text-text-tertiary font-mono tnum">{p.sku}</div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <input
                      value={countText}
                      onChange={(e) => setCountText(e.target.value)}
                      placeholder="Counted qty"
                      inputMode="numeric"
                      className="w-32 bg-bg-deep border border-border px-3 py-2 text-sm font-mono tnum text-center"
                    />
                  </div>
                  <div className="text-xs text-text-tertiary">
                    Type the counted quantity, then click a matching product to record.
                    Re-recording the same product overwrites the previous count.
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs text-text-secondary uppercase tracking-wider mb-2">
                  Counted lines ({lines.length})
                </div>
                {lines.length === 0 ? (
                  <div className="text-sm text-text-tertiary">No counts recorded yet.</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                        <th className="text-left py-1">Product</th>
                        <th className="text-right py-1">Expected</th>
                        <th className="text-right py-1">Counted</th>
                        <th className="text-right py-1">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.id} className="border-t border-border">
                          <td className="py-1">{l.productName}</td>
                          <td className="py-1 text-right font-mono tnum">{l.expectedQty}</td>
                          <td className="py-1 text-right font-mono tnum">{l.countedQty}</td>
                          <td className={[
                            'py-1 text-right font-mono tnum',
                            l.deltaQty === 0 ? 'text-text-tertiary'
                            : l.deltaQty > 0 ? 'text-success'
                            : 'text-danger',
                          ].join(' ')}>
                            {l.deltaQty > 0 ? '+' : ''}{l.deltaQty}
                            {Math.abs(l.deltaQty) > 10 && <span className="text-xs ml-1">⚠</span>}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-t border-border bg-bg-elevated">
                        <td colSpan={3} className="py-1 text-right text-xs text-text-secondary uppercase tracking-wider">Total |Δ|</td>
                        <td className="py-1 text-right font-mono tnum">
                          {lines.reduce((s, l) => s + Math.abs(l.deltaQty), 0)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {pinPrompt && (
        <SupervisorPinModal
          purpose="STOCKTAKE_LARGE_DELTA"
          reason={pinPrompt.reason}
          context={pinPrompt.context}
          onClose={() => setPinPrompt(null)}
          onApproved={(resp) => { void pinPrompt.onApproved(resp.approvalId); }}
        />
      )}
    </div>
  );
}
