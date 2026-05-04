import React, { useState } from 'react';
import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

function InvoiceForm({ shopId, inventory, onSuccess }) {
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [items, setItems] = useState([]);
  const [selectedDesign, setSelectedDesign] = useState('');
  const [selectedQty, setSelectedQty] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleAddItem = () => {
    if (!selectedDesign) {
      setError('Please select a design');
      return;
    }

    const design = inventory.find(d => d.id === selectedDesign);
    if (!design) return;

    const existingItem = items.find(item => item.design_id === selectedDesign);
    if (existingItem) {
      existingItem.quantity_boxes += parseInt(selectedQty);
    } else {
      items.push({
        design_id: selectedDesign,
        design_code: design.design_code,
        quantity_boxes: parseInt(selectedQty),
        price_per_box: design.base_price_per_box || 100
      });
    }

    setItems([...items]);
    setSelectedDesign('');
    setSelectedQty(1);
    setError(null);
  };

  const handleRemoveItem = (designId) => {
    setItems(items.filter(item => item.design_id !== designId));
  };

  const totalAmount = items.reduce((sum, item) => 
    sum + (item.quantity_boxes * item.price_per_box), 0
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!customerName.trim()) {
      setError('Customer name is required');
      return;
    }

    if (items.length === 0) {
      setError('Add at least one item');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      await axios.post(`${API_BASE_URL}/invoices/generate`, {
        shopId,
        customerName,
        customerPhone,
        items: items.map(item => ({
          design_id: item.design_id,
          quantity_boxes: item.quantity_boxes,
          price_per_box: item.price_per_box
        }))
      });

      setSuccess(true);
      setTimeout(() => {
        onSuccess();
      }, 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create invoice');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return <div className="card"><p className="success-message">✅ Invoice created! Stock updated automatically.</p></div>;
  }

  return (
    <div className="form-container">
      <h2>🧾 New Invoice</h2>

      {error && <div className="error-message">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Customer Name *</label>
          <input 
            type="text" 
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Enter customer name"
            required
          />
        </div>

        <div className="form-group">
          <label>Customer Phone (optional)</label>
          <input 
            type="tel" 
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
            placeholder="Enter customer phone"
          />
        </div>

        <div className="divider"></div>
        <h3>Add Items</h3>

        <div className="form-group">
          <label>Select Design</label>
          <select 
            value={selectedDesign}
            onChange={(e) => setSelectedDesign(e.target.value)}
          >
            <option value="">-- Choose a design --</option>
            {inventory.map(item => (
              <option key={item.id} value={item.id}>
                {item.design_code} - {item.design_name} (Available: {item.quantity_boxes})
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Quantity (boxes)</label>
            <input 
              type="number" 
              min="1" 
              value={selectedQty}
              onChange={(e) => setSelectedQty(e.target.value)}
            />
          </div>
          <button type="button" className="btn-secondary" onClick={handleAddItem}>
            Add Item
          </button>
        </div>

        {/* Items Summary */}
        {items.length > 0 && (
          <div className="card">
            <h3>Invoice Items</h3>
            <table className="items-table">
              <thead>
                <tr>
                  <th>Design</th>
                  <th>Qty</th>
                  <th>Price/Box</th>
                  <th>Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.design_id}>
                    <td>{item.design_code}</td>
                    <td>{item.quantity_boxes}</td>
                    <td>₹{item.price_per_box}</td>
                    <td>₹{item.quantity_boxes * item.price_per_box}</td>
                    <td>
                      <button 
                        type="button" 
                        className="btn-remove"
                        onClick={() => handleRemoveItem(item.design_id)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="total-section">
              <p><strong>Total Amount: ₹{totalAmount.toLocaleString()}</strong></p>
            </div>
          </div>
        )}

        <button type="submit" className="btn-primary full-width" disabled={loading}>
          {loading ? 'Processing...' : '✓ Create Invoice'}
        </button>
      </form>
    </div>
  );
}

export default InvoiceForm;
