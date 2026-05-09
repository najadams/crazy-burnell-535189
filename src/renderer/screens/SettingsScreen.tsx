// SettingsScreen — tabbed: Loyalty | Workers | Products | Customers | Backup.
// All gated by simply being logged in; OWNER-only writes are enforced
// per-action by the IPC handlers + UI button states.

import { useState } from 'react';
import SettingsLoyalty from '../components/SettingsLoyalty';
import SettingsWorkers from '../components/SettingsWorkers';
import SettingsProducts from '../components/SettingsProducts';
import SettingsCustomers from '../components/SettingsCustomers';
import SettingsBackup from '../components/SettingsBackup';

interface Props { onBack: () => void }
type Tab = 'loyalty' | 'workers' | 'products' | 'customers' | 'backup';

export default function SettingsScreen({ onBack }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('loyalty');

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-baseline justify-between px-6 py-4 border-b border-border bg-bg-surface">
        <div className="flex items-baseline gap-4">
          <button onClick={onBack} className="text-text-tertiary hover:text-text-primary text-sm">
            ← Home
          </button>
          <div className="text-xl font-semibold tracking-tight">Settings</div>
        </div>
      </header>

      <div className="px-6 pt-3 border-b border-border bg-bg-surface flex gap-1 overflow-x-auto">
        <TabBtn active={tab === 'loyalty'}   onClick={() => setTab('loyalty')}>Loyalty</TabBtn>
        <TabBtn active={tab === 'workers'}   onClick={() => setTab('workers')}>Workers</TabBtn>
        <TabBtn active={tab === 'products'}  onClick={() => setTab('products')}>Products</TabBtn>
        <TabBtn active={tab === 'customers'} onClick={() => setTab('customers')}>Customers</TabBtn>
        <TabBtn active={tab === 'backup'}    onClick={() => setTab('backup')}>Backup</TabBtn>
      </div>

      <div className="flex-1 overflow-auto p-6 max-w-4xl mx-auto w-full">
        {tab === 'loyalty'   && <SettingsLoyalty />}
        {tab === 'workers'   && <SettingsWorkers />}
        {tab === 'products'  && <SettingsProducts />}
        {tab === 'customers' && <SettingsCustomers />}
        {tab === 'backup'    && <SettingsBackup />}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={[
        'px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap',
        active ? 'border-accent text-accent' : 'border-transparent text-text-tertiary hover:text-text-primary',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
