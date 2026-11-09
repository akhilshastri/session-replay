/** Mini shop demo app: React 18 + Redux Toolkit (cart) + Zustand (ui), hash routes #/shop and #/checkout. */
import { configureStore, createSlice, createAsyncThunk, combineReducers, type PayloadAction } from '@reduxjs/toolkit';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { create } from 'zustand';
import { connectZustand, registerReduxSnapshot, wrapReducer } from './adapters';

const PRODUCTS = [
  { id: 'kb', name: 'Mechanical keyboard', price: 120 },
  { id: 'ms', name: 'Wireless mouse', price: 45 },
  { id: 'mn', name: '4K monitor', price: 320 },
  { id: 'hs', name: 'Headset', price: 80 },
];

type Item = { id: string; name: string; price: number; qty: number };
type CartState = { items: Item[]; coupon: string; orderStatus: string };

const total = (items: Item[]) => items.reduce((s, i) => s + i.price * i.qty, 0);

const placeOrder = createAsyncThunk('cart/placeOrder', async (amount: number, { rejectWithValue }) => {
  const res = await fetch('/api/demo/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ total: amount }),
  });
  const body = await res.json();
  return res.ok ? (body as { orderId: string }).orderId : rejectWithValue((body as { error: string }).error);
});

const cart = createSlice({
  name: 'cart',
  initialState: { items: [], coupon: '', orderStatus: 'idle' } as CartState,
  reducers: {
    add: (s, a: PayloadAction<{ id: string; name: string; price: number }>) => {
      const line = s.items.find((i) => i.id === a.payload.id);
      if (line) line.qty += 1;
      else s.items.push({ ...a.payload, qty: 1 });
    },
    setQty: (s, a: PayloadAction<{ id: string; qty: number }>) => {
      const line = s.items.find((i) => i.id === a.payload.id);
      if (line) line.qty = Math.max(1, a.payload.qty);
    },
    remove: (s, a: PayloadAction<string>) => {
      s.items = s.items.filter((i) => i.id !== a.payload);
    },
    setCoupon: (s, a: PayloadAction<string>) => {
      s.coupon = a.payload;
    },
  },
  extraReducers: (b) => {
    b.addCase(placeOrder.pending, (s) => void (s.orderStatus = 'pending'))
      .addCase(placeOrder.fulfilled, (s, a) => {
        s.orderStatus = `placed #${a.payload}`;
        s.items = [];
      })
      .addCase(placeOrder.rejected, (s, a) => void (s.orderStatus = `failed: ${String(a.payload ?? a.error.message)}`));
  },
});

// Root reducer is wrapped (not dispatch) so thunk-driven actions are captured too. See adapters.ts.
const store = configureStore({ reducer: wrapReducer('cart', combineReducers({ cart: cart.reducer })) });
type RootState = ReturnType<typeof store.getState>;
registerReduxSnapshot('cart', store.getState);

const useUi = create<{ theme: 'light' | 'dark'; toast: string; toggleTheme: () => void; showToast: (m: string) => void }>((set) => ({
  theme: 'light',
  toast: '',
  toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
  showToast: (toast) => set({ toast }),
}));
connectZustand('ui', useUi);

const useHash = () => {
  const [hash, setHash] = useState(location.hash || '#/shop');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/shop');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
};

const Shop = () => {
  const dispatch = useDispatch();
  const showToast = useUi((s) => s.showToast);
  return (
    <div className="grid">
      {PRODUCTS.map((p) => (
        <div className="card" key={p.id}>
          <h3>{p.name}</h3>
          <p>${p.price}</p>
          <button
            onClick={() => {
              dispatch(cart.actions.add(p));
              showToast(`Added ${p.name}`);
            }}
          >
            Add to cart
          </button>
        </div>
      ))}
    </div>
  );
};

const Checkout = () => {
  const dispatch = useDispatch<typeof store.dispatch>();
  const { items, coupon, orderStatus } = useSelector((s: RootState) => s.cart);
  const sum = total(items);
  return (
    <div>
      {items.length === 0 && <p>Your cart is empty.</p>}
      {items.map((i) => (
        <div className="line" key={i.id}>
          <span className="name">{i.name}</span>
          <button onClick={() => dispatch(cart.actions.setQty({ id: i.id, qty: i.qty - 1 }))}>-</button>
          <span>{i.qty}</span>
          <button onClick={() => dispatch(cart.actions.setQty({ id: i.id, qty: i.qty + 1 }))}>+</button>
          <span className="price">${i.price * i.qty}</span>
          <button onClick={() => dispatch(cart.actions.remove(i.id))}>Remove</button>
        </div>
      ))}
      <p className="total">Total: ${sum}</p>
      <label>
        Coupon <input name="coupon" value={coupon} onChange={(e) => dispatch(cart.actions.setCoupon(e.target.value))} />
      </label>
      <label>
        Account PIN <input name="pin" type="password" autoComplete="off" />
      </label>
      <div className="rr-mask">
        <label>
          Card number <input name="card" inputMode="numeric" autoComplete="off" />
        </label>
      </div>
      <button className="primary" disabled={items.length === 0} onClick={() => dispatch(placeOrder(sum))}>
        Place order
      </button>
      <p className="status">Order status: {orderStatus}</p>
      <p className="hint">Tip: a total over $500 makes the server answer 500.</p>
    </div>
  );
};

const App = () => {
  const hash = useHash();
  const { theme, toast, toggleTheme } = useUi();
  const count = useSelector((s: RootState) => s.cart.items.reduce((n, i) => n + i.qty, 0));
  useEffect(() => void (document.body.dataset.theme = theme), [theme]);
  return (
    <div className="app">
      <header>
        <strong>Mini shop</strong>
        <a href="#/shop">Shop</a>
        <a href="#/checkout">Checkout ({count})</a>
        <button onClick={toggleTheme}>Theme: {theme}</button>
      </header>
      {toast && <div className="toast">{toast}</div>}
      <main>{hash === '#/checkout' ? <Checkout /> : <Shop />}</main>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <App />
  </Provider>,
);
