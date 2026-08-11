import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { attachSession, storeSession } from './session';
import Dashboard from './components/Dashboard';
import InvoiceForm from './components/InvoiceForm';
import StockForm from './components/StockForm';
import AlertsPanel from './components/AlertsPanel';
import CreditScore from './components/CreditScore';
import './App.css';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

// Extended timeout for Render free tier cold start (90 sec)
const api = axios.create({ baseURL: API_BASE_URL, timeout: 90000 });
// This instance was created from axios.defaults and will not pick up the interceptor that
// session.js installs on the default export, so it is attached explicitly.
attachSession(api);

function App() {
  const [currentView, setCurrentView] = useState('dashboard');
  const [serverWaking, setServerWaking] = useState(false);
  const [shopData, setShopData] = useState(null);
  const [inventoryStatus, setInventoryStatus] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Hardcoded shop ID for Kanhaiya Marbles (will be set after first init)
  const SHOP_ID = localStorage.getItem('shopId');
  // A stored shop id is no longer enough to reach the API — the session is what the server
  // checks — so a browser holding an id but no session has to sign in again.
  const HAS_SESSION = !!localStorage.getItem('sessionToken');
  const [showRegister, setShowRegister] = useState(false);

  useEffect(() => {
    // Ping backend to wake Render free tier
    const wakeServer = async () => {
      try {
        setServerWaking(true);
        await api.get('/health');
      } catch (e) {}
      finally { setServerWaking(false); }
    };
    wakeServer();
  }, []);

  useEffect(() => {
    if (SHOP_ID) {
      fetchShopData();
      fetchInventoryStatus();
      fetchAlerts();
      const interval = setInterval(() => {
        fetchInventoryStatus();
        fetchAlerts();
      }, 30000);
      return () => clearInterval(interval);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [SHOP_ID]);

  const fetchShopData = async () => {
    try {
      const response = await api.get(`/shops/${SHOP_ID}`);
      setShopData(response.data);
    } catch (err) {
      setError('Failed to fetch shop data');
      console.error(err);
    }
  };

  const fetchInventoryStatus = async () => {
    try {
      setLoading(true);
      const response = await api.get(`/inventory/status/${SHOP_ID}`);
      setInventoryStatus(response.data);
      setError(null);
    } catch (err) {
      setError('Failed to fetch inventory');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchAlerts = async () => {
    try {
      const response = await api.get(`/alerts/${SHOP_ID}`);
      setAlerts(response.data);
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    }
  };

  const handleLogin = async ({ phone, pin }) => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.post('/shops/login', { phone, pin });
      if (response.data.multiple) {
        // Each candidate shop carries its own session; this client has no picker yet, so
        // it takes the most recent, which is the order the server returns them in.
        const first = response.data.shops[0];
        storeSession(first.token);
        localStorage.setItem('shopId', first.id);
      } else {
        storeSession(response.data.token);
        localStorage.setItem('shopId', response.data.shop.id);
      }
      window.location.reload();
    } catch (err) {
      // The server answers the same way for an unknown phone and a wrong PIN, so that
      // nobody can test phone numbers against the database. The message says both.
      setError(err.response?.status === 429
        ? 'Too many attempts. Try again in 15 minutes.'
        : 'Phone number or PIN is wrong. Try again, or register a new shop.');
    } finally {
      setLoading(false);
    }
  };

  const handleInitializeShop = async (shopDetails) => {
    try {
      setLoading(true);
      const response = await api.post(`/shops/init`, shopDetails);
      const newShopId = response.data.shop?.id || response.data.id;
      // Signing up is the only place this app can obtain a session; there is no login
      // screen here yet, so losing this token means losing access from this browser.
      storeSession(response.data.token);
      localStorage.setItem('shopId', newShopId);
      setShopData(response.data);
      window.location.reload();
    } catch (err) {
      setError('Failed to initialize shop');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (!SHOP_ID || !HAS_SESSION) {
    return (
      <div className="container">
        <div className="init-screen">
          <h1>⚡ FastBahi</h1>
          <p>AI-Powered Shop Management Platform</p>
          {serverWaking && (
            <div style={{background:'#fef3c7', padding:'10px', borderRadius:'8px', marginBottom:'12px', fontSize:'13px', color:'#92400e'}}>
              ⏳ Server start ho raha hai... 30-50 sec wait karo
            </div>
          )}
          {error && <div className="error-message">{error}</div>}
          {showRegister ? (
            <>
              <InitializeShop onSubmit={handleInitializeShop} />
              <button className="link-button" onClick={() => { setError(null); setShowRegister(false); }}>
                Already have a shop? Log in
              </button>
            </>
          ) : (
            <>
              <LoginForm onSubmit={handleLogin} loading={loading} />
              <button className="link-button" onClick={() => { setError(null); setShowRegister(true); }}>
                New here? Register a shop
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>⚡ FastBahi</h1>
        <p className="shop-owner">{shopData?.name} · {shopData?.owner_name}</p>
      </header>

      {error && <div className="error-message">{error}</div>}

      <div className="main-content">
        {currentView === 'dashboard' && (
          <Dashboard 
            shopData={shopData} 
            inventoryStatus={inventoryStatus}
            loading={loading}
          />
        )}
        {currentView === 'invoice' && (
          <InvoiceForm 
            shopId={SHOP_ID}
            inventory={inventoryStatus?.inventory || []}
            onSuccess={() => {
              fetchInventoryStatus();
              fetchAlerts();
              setCurrentView('dashboard');
            }}
          />
        )}
        {currentView === 'stock' && (
          <StockForm 
            shopId={SHOP_ID}
            inventory={inventoryStatus?.inventory || []}
            onSuccess={() => {
              fetchInventoryStatus();
              fetchAlerts();
              setCurrentView('dashboard');
            }}
          />
        )}
        {currentView === 'alerts' && (
          <AlertsPanel alerts={alerts} loading={loading} />
        )}
        {currentView === 'credit' && (
          <CreditScore shopId={SHOP_ID} />
        )}
      </div>

      <nav className="bottom-nav">
        <button 
          className={`nav-button ${currentView === 'dashboard' ? 'active' : ''}`}
          onClick={() => setCurrentView('dashboard')}
        >
          📊 Dashboard
        </button>
        <button 
          className={`nav-button ${currentView === 'invoice' ? 'active' : ''}`}
          onClick={() => setCurrentView('invoice')}
        >
          🧾 Invoice
        </button>
        <button 
          className={`nav-button ${currentView === 'stock' ? 'active' : ''}`}
          onClick={() => setCurrentView('stock')}
        >
          📦 Add Stock
        </button>
        <button
          className={`nav-button ${currentView === 'alerts' ? 'active' : ''}`}
          onClick={() => setCurrentView('alerts')}
        >
          🚨 Alerts
        </button>
        <button
          className={`nav-button ${currentView === 'credit' ? 'active' : ''}`}
          onClick={() => setCurrentView('credit')}
        >
          💳 Credit
        </button>
      </nav>
    </div>
  );
}

// Signup used to be the only way this client could get in, which meant a browser that
// cleared its storage could never return. The API needs a session now, so it needs a login.
function LoginForm({ onSubmit, loading }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const valid = /^\d{10}$/.test(phone) && /^\d{4,6}$/.test(pin);

  return (
    <form
      className="login-form"
      onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit({ phone, pin }); }}
    >
      <input
        type="tel" placeholder="Phone number" value={phone} maxLength={10}
        onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
      />
      <input
        type="password" placeholder="PIN" value={pin} maxLength={6}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
      />
      <button type="submit" disabled={!valid || loading}>
        {loading ? 'Logging in…' : 'Log in'}
      </button>
    </form>
  );
}

function InitializeShop({ onSubmit }) {
  const [formData, setFormData] = useState({
    shopName: '',
    ownerName: '',
    phone: '',
    address: '',
    shopType: 'general'
  });
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    await onSubmit(formData);
    setLoading(false);
  };

  return (
    <form className="init-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label>Shop Name</label>
        <input
          type="text"
          name="shopName"
          placeholder="e.g. Kanhaiya Marbles"
          value={formData.shopName}
          onChange={handleChange}
          required
        />
      </div>
      <div className="form-group">
        <label>Owner Name</label>
        <input
          type="text"
          name="ownerName"
          placeholder="e.g. Sanjay Kumar Sharma"
          value={formData.ownerName}
          onChange={handleChange}
          required
        />
      </div>
      <div className="form-group">
        <label>Phone</label>
        <input
          type="tel"
          name="phone"
          placeholder="e.g. 9876543210"
          value={formData.phone}
          onChange={handleChange}
          required
        />
      </div>
      <div className="form-group">
        <label>Address</label>
        <input
          type="text"
          name="address"
          placeholder="e.g. Main Market, Siwan"
          value={formData.address}
          onChange={handleChange}
          required
        />
      </div>
      <div className="form-group">
        <label>Shop Type</label>
        <select name="shopType" value={formData.shopType} onChange={handleChange}>
          <option value="general">General Store</option>
          <option value="tile_marble">Tiles / Marble</option>
          <option value="grocery">Grocery</option>
          <option value="electronics">Electronics</option>
          <option value="pharmacy">Pharmacy</option>
          <option value="clothing">Clothing</option>
        </select>
      </div>
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? 'Setting up...' : '🚀 Start FastBahi'}
      </button>
    </form>
  );
}

export default App;
