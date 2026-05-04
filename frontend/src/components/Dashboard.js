import React from 'react';

function Dashboard({ shopData, inventoryStatus, loading }) {
  if (loading || !inventoryStatus) {
    return <div className="dashboard"><p>Loading inventory...</p></div>;
  }

  const { low_stock_items = [], total_items = 0, low_stock_count = 0 } = inventoryStatus;

  const healthStatus = low_stock_count === 0 ? '✅ Healthy' : '⚠️ Low Stock Alert';
  const healthColor = low_stock_count === 0 ? '#4CAF50' : '#FF9800';

  return (
    <div className="dashboard">
      <div className="dashboard-grid">
        {/* Overview Cards */}
        <div className="card">
          <h3>Total Items</h3>
          <p className="big-number">{total_items}</p>
        </div>

        <div className="card">
          <h3>Low Stock Items</h3>
          <p className="big-number" style={{ color: low_stock_count > 0 ? '#FF9800' : '#4CAF50' }}>
            {low_stock_count}
          </p>
        </div>

        <div className="card">
          <h3>Stock Status</h3>
          <p style={{ color: healthColor, fontSize: '24px', fontWeight: 'bold' }}>
            {healthStatus}
          </p>
        </div>
      </div>

      {/* Low Stock Items */}
      {low_stock_items.length > 0 && (
        <div className="card full-width">
          <h3>⚠️ Low Stock Items</h3>
          <div className="items-list">
            {low_stock_items.map((item) => (
              <div key={item.id} className="list-item">
                <div className="item-name">
                  {item.design_code || item.category_name}
                  <br />
                  <small>{item.design_name || 'N/A'}</small>
                </div>
                <div className="item-qty">
                  <span className="qty-badge">{item.quantity_boxes} boxes</span>
                  <span className="threshold">Threshold: {item.low_stock_threshold}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shop Info */}
      <div className="card full-width">
        <h3>📍 Shop Information</h3>
        <p><strong>Owner:</strong> {shopData?.owner_name}</p>
        <p><strong>Phone:</strong> {shopData?.phone}</p>
        <p><strong>Address:</strong> {shopData?.address}</p>
      </div>
    </div>
  );
}

export default Dashboard;
