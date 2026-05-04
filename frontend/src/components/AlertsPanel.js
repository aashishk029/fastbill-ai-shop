import React from 'react';

function AlertsPanel({ alerts, loading }) {
  if (loading) {
    return <div className="dashboard"><p>Loading alerts...</p></div>;
  }

  const aiAlerts = alerts.ai_insights || [];
  const lowStockAlerts = alerts.low_stock_items || [];

  return (
    <div className="alerts-panel">
      <h2>🚨 Alerts & AI Insights</h2>

      {/* AI-Generated Insights */}
      {aiAlerts.length > 0 && (
        <div className="card">
          <h3>🤖 AI Recommendations</h3>
          {aiAlerts.map((alert, idx) => (
            <div key={idx} className="alert-item ai-alert">
              <div className="alert-header">
                <span className={`severity ${alert.severity}`}>
                  {alert.severity === 'high' ? '🔴' : alert.severity === 'medium' ? '🟡' : '🟢'}
                  {alert.severity.toUpperCase()}
                </span>
              </div>
              <p className="alert-message">{alert.message}</p>
              {alert.actionItems && alert.actionItems.length > 0 && (
                <div className="action-items">
                  <strong>Recommended Actions:</strong>
                  <ul>
                    {alert.actionItems.map((action, i) => (
                      <li key={i}>{action}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Low Stock Alerts */}
      {lowStockAlerts.length > 0 && (
        <div className="card">
          <h3>⚠️ Low Stock Alerts</h3>
          {lowStockAlerts.map((item, idx) => (
            <div key={idx} className="alert-item stock-alert">
              <div className="alert-header">
                <span className="design-code">{item.design_code}</span>
                <span className="current-stock">Current: {item.quantity_boxes} boxes</span>
              </div>
              <p>{item.design_name}</p>
              <p className="threshold-info">
                Threshold: {item.low_stock_threshold} | 
                Reorder Qty: {item.reorder_quantity}
              </p>
            </div>
          ))}
        </div>
      )}

      {aiAlerts.length === 0 && lowStockAlerts.length === 0 && (
        <div className="card">
          <p>✅ No alerts at the moment. Everything looks good!</p>
        </div>
      )}
    </div>
  );
}

export default AlertsPanel;
