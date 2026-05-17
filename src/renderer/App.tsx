// App.tsx — top-level router. Five screens reachable in order:
//   not-logged-in              → LoginScreen
//   logged-in, no shift        → OpenShiftScreen
//   logged-in, shift open      → HomeScreen / SaleScreen / CustomersScreen / CustomerDetailScreen / SettingsScreen
//
// We keep this as a state-machine inside App rather than a React Router
// because Counter is keyboard-first and most navigation is action-button
// driven. A real router would be overkill.

import { useEffect, useState } from 'react';
import { counter } from './lib/ipc';
import { useSession } from './store/session';
import LoginScreen from './screens/LoginScreen';
import OpenShiftScreen from './screens/OpenShiftScreen';
import HomeScreen from './screens/HomeScreen';
import SaleScreen from './screens/SaleScreen';
import CustomersScreen from './screens/CustomersScreen';
import CustomerDetailScreen from './screens/CustomerDetailScreen';
import SettingsScreen from './screens/SettingsScreen';
import StockScreen from './screens/StockScreen';
import PendingOrdersScreen from './screens/PendingOrdersScreen';
import RouteRunsScreen from './screens/RouteRunsScreen';
import StocktakeScreen from './screens/StocktakeScreen';
import DriverHomeScreen from './screens/DriverHomeScreen';

export type Route =
  | { name: 'home' }
  | { name: 'sale' }
  | { name: 'customers' }
  | { name: 'customer-detail'; customerId: string }
  | { name: 'stock' }
  | { name: 'settings' }
  | { name: 'pending-orders' }
  | { name: 'route-runs' }
  | { name: 'stocktake' };

export default function App(): JSX.Element {
  const workerId = useSession((s) => s.workerId);
  const workerRole = useSession((s) => s.workerRole);
  const setSession = useSession((s) => s.setSession);

  const [shiftId, setShiftId] = useState<string | null>(null);
  const [bootChecked, setBootChecked] = useState(false);
  const [route, setRoute] = useState<Route>({ name: 'home' });

  // On boot: check whether we have a session and an open shift.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await counter.whoAmI();
      if (cancelled) return;
      if (me.success && me.data) {
        setSession(me.data);
        const sh = await counter.currentShift();
        if (sh.success) setShiftId(sh.data.shiftId);
      }
      setBootChecked(true);
    })();
    return () => { cancelled = true; };
  }, [setSession]);

  // After login, look up the open shift.
  async function refreshShift() {
    const sh = await counter.currentShift();
    if (sh.success) setShiftId(sh.data.shiftId);
  }

  if (!bootChecked) {
    return <div className="h-full flex items-center justify-center text-text-tertiary">Loading…</div>;
  }

  if (!workerId) {
    return <LoginScreen onLoggedIn={refreshShift} />;
  }

  if (!shiftId) {
    return <OpenShiftScreen onOpened={() => { void refreshShift(); }} />;
  }

  switch (route.name) {
    case 'home':
      if (workerRole === 'DRIVER') {
        return <DriverHomeScreen onSignOut={() => setSession(null)} />;
      }
      return <HomeScreen onNavigate={setRoute} />;
    case 'sale':
      return <SaleScreen onDone={() => setRoute({ name: 'home' })} />;
    case 'customers':
      return (
        <CustomersScreen
          onBack={() => setRoute({ name: 'home' })}
          onOpenCustomer={(id) => setRoute({ name: 'customer-detail', customerId: id })}
        />
      );
    case 'customer-detail':
      return (
        <CustomerDetailScreen
          customerId={route.customerId}
          onBack={() => setRoute({ name: 'customers' })}
        />
      );
    case 'stock':
      return <StockScreen onBack={() => setRoute({ name: 'home' })} />;
    case 'settings':
      return <SettingsScreen onBack={() => setRoute({ name: 'home' })} />;
    case 'pending-orders':
      return <PendingOrdersScreen onBack={() => setRoute({ name: 'home' })} />;
    case 'route-runs':
      return <RouteRunsScreen onBack={() => setRoute({ name: 'home' })} />;
    case 'stocktake':
      return <StocktakeScreen onBack={() => setRoute({ name: 'home' })} />;
    default:
      return <HomeScreen onNavigate={setRoute} />;
  }
}
