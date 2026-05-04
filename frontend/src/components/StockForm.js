import React, { useState } from 'react';
import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

function StockForm({ shopId, inventory, onSuccess }) {
  const [selectedDesign, setSelectedDesign] = useState('');
  const [quantity, setQuantity] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [costPerBox, setCostPerBox] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!selectedDesign) {
      setError('Please select a design');
      return;
    }

    if (!quantity || parseInt(quantity) <= 0) {
      setError('Please enter valid quantity');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      await axios.post(`${API_BASE_URL}/purchases/add`, {
        shopId,
        design_id: selectedDesign,
        quantity_boxes: parseInt(quantity),
        supplier_name: supplierName || 'Direct Purchase',
        cost_per_box: parseFloat(costPerBox) || 0
      });

      setSuccess(true);
      setTimeout(() => {
        onSuccess();
      }, 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add stock');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return <div className="card"><p className="success-message">✅ Stock added successfully!</p></div>;
  }

  return (
    <div className="form-container">
      <h2>📦 Add Stock</h2>

      {error && <div className="error-message">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Select Design to Restock *</label>
          <select 
            value={selectedDesign}
            onChange={(e) => setSelectedDesign(e.target.value)}
            required
          >
            <option value="">-- Choose a design --</option>
            {inventory.map(item => (
              <option key={item.id} value={item.id}>
                {item.design_code} - {item.design_name} (Current: {item.quantity_boxes})
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Quantity (boxes) *</label>
          <input 
            type="number" 
            min="1" 
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="Enter quantity"
            required
          />
        </div>

        <div className="form-group">
          <label>Supplier Name (optional)</label>
          <input 
            type="text" 
            value={supplierName}
            onChange={(e) => setSupplierName(e.target.value)}
            placeholder="e.g., ABC Tiles, Direct Supplier"
          />
        </div>

        <div className="form-group">
          <label>Cost per Box (optional)</label>
          <input 
            type="number" 
            step="0.01"
            value={costPerBox}
            onChange={(e) => setCostPerBox(e.target.value)}
            placeholder="Enter cost per box"
          />
        </div>

        <button type="submit" className="btn-primary full-width" disabled={loading}>
          {loading ? 'Processing...' : '✓ Add Stock'}
        </button>
      </form>

      <div className="card" style={{ marginTop: '20px' }}>
        <h3>📊 Stock Summary</h3>
        <table className="items-table">
          <thead>
            <tr>
              <th>Design</th>
              <th>Current Stock</th>
              <th>Threshold</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {inventory.slice(0, 8).map(item => (
              <tr key={item.id}>
                <td>{item.design_code}</td>
                <td>{item.quantity_boxes}</td>
                <td>{item.low_stock_threshold}</td>
                <td>
                  <span className={item.quantity_boxes <= item.low_stock_threshold ? 'status-low' : 'status-ok'}>
                    {item.quantity_boxes <= item.low_stock_threshold ? '⚠️ Low' : '✅ OK'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default StockForm;
