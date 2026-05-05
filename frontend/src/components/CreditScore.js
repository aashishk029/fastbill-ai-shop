import React, { useState } from 'react';
import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

const strengthColor = (val) => {
  if (!val) return '#888';
  if (val.startsWith('Strong')) return '#22c55e';
  if (val.startsWith('Good')) return '#84cc16';
  if (val.startsWith('Fair')) return '#f59e0b';
  return '#ef4444';
};

function CreditScore({ shopId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchScore = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`${API_BASE_URL}/credit-score/${shopId}`);
      setData(res.data);
    } catch (err) {
      setError('Score load nahi hua. Dobara try karein.');
    } finally {
      setLoading(false);
    }
  };

  const scoreColor =
    !data ? '#666' :
    data.score >= 750 ? '#22c55e' :
    data.score >= 550 ? '#f59e0b' : '#ef4444';

  const breakdown = data?.scoreBreakdown || {};

  return (
    <div className="dashboard">
      <h2>💳 Credit Score</h2>

      {/* Big Score */}
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '80px', fontWeight: 'bold', color: scoreColor, lineHeight: 1 }}>
          {data ? data.score : '---'}
        </div>
        <div style={{ fontSize: '20px', color: scoreColor, margin: '8px 0 4px' }}>
          {data ? data.rating : 'Score abhi nahi hai'}
        </div>
        <div style={{ color: '#888', fontSize: '12px' }}>out of 900 · AI se calculate hua</div>
        {data?.dataQuality && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#6b7280', fontStyle: 'italic' }}>
            📊 {data.dataQuality}
          </div>
        )}
      </div>

      {/* Score Breakdown */}
      {data && Object.keys(breakdown).length > 0 && (
        <div className="card">
          <h3>🔍 Score Breakdown</h3>
          {Object.entries(breakdown).map(([key, val]) => {
            const label = {
              salesActivity: '🧾 Sales Activity',
              revenueHealth: '💰 Revenue Health',
              inventoryManagement: '📦 Inventory',
              purchaseConsistency: '🛒 Purchases',
            }[key] || key;
            return (
              <div key={key} style={{ marginBottom: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                  <span style={{ fontSize: '13px', color: '#374151' }}>{label}</span>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: strengthColor(val) }}>
                    {val?.split(' - ')[0]}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: '#6b7280' }}>{val?.split(' - ')[1]}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Raw Stats */}
      {data?.rawStats && (
        <div className="card">
          <h3>📊 90 Din Ka Data</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            {[
              ['Invoices', data.rawStats.invoicesLast90Days],
              ['Revenue', `₹${(data.rawStats.totalRevenue90Days || 0).toLocaleString('en-IN')}`],
              ['Customers', data.rawStats.uniqueCustomers],
              ['Low Stock', data.rawStats.lowStockItems + ' items'],
              ['Purchases', data.rawStats.purchaseOrders90Days],
              ['Total Products', data.rawStats.inventoryItems],
            ].map(([label, val]) => (
              <div key={label} className="stat-box">
                <div className="stat-value" style={{ fontSize: '18px' }}>{val}</div>
                <div className="stat-label">{label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hindi Advice */}
      {data?.adviceHindi && (
        <div className="card">
          <h3>🤖 AI Salah</h3>
          <p style={{ lineHeight: '1.7', color: '#374151' }}>{data.adviceHindi}</p>
        </div>
      )}

      {error && <div className="error-message">{error}</div>}

      <button
        className="btn-primary"
        style={{ width: '100%', marginTop: '12px' }}
        onClick={fetchScore}
        disabled={loading}
      >
        {loading ? '⏳ AI Score Calculate Kar Raha Hai...' : '🔄 Score Dekho'}
      </button>
    </div>
  );
}

export default CreditScore;
