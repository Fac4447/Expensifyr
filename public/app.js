const fileInput = document.getElementById('receiptFile');
const fileName = document.getElementById('fileName');
const uploadBtn = document.getElementById('uploadBtn');
const summaryBtn = document.getElementById('summaryBtn');

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    fileName.textContent = e.target.files[0].name;
    uploadBtn.disabled = false;
  } else {
    fileName.textContent = 'No file chosen';
    uploadBtn.disabled = true;
  }
});

async function uploadReceipt() {
  const file = fileInput.files[0];
  if (!file) { showError('Please select a file'); return; }

  const formData = new FormData();
  formData.append('receipt', file);
  formData.append('userId', 'demo-user');

  showLoading(true); 
  hideError(); 
  hideResult();

  try {
    const response = await fetch('/upload-receipt', { method: 'POST', body: formData });
    const data = await response.json();
    if (data.success) displayReceipt(data.data);
    else showError(data.error || 'Failed to process receipt');
  } catch (err) {
    showError('Network error: ' + err.message);
  } finally {
    showLoading(false);
  }
}

async function getSummary() {
  showLoading(true); hideError();
  try {
    const response = await fetch('/receipts?userId=demo-user');
    const data = await response.json();
    displaySummary(data.receipts);
  } catch (err) {
    showError('Failed to load summary: ' + err.message);
  } finally {
    showLoading(false);
  }
}

function displayReceipt(receipt) {
  const info = document.getElementById('receiptInfo');
  let html = `
    <div class="receipt-info">
      <p><strong>Store:</strong> ${receipt.storeName}</p>
      <p><strong>Date:</strong> ${receipt.date || 'Not found'}</p>
      <p><strong>Tax:</strong> $${receipt.tax || '0.00'}</p>
      <p><strong>Total:</strong> $${receipt.total || '0.00'}</p>
    </div>
    <div class="items-list"><h4 style="margin-bottom:10px;">Items:</h4>`;
  if (receipt.items && receipt.items.length > 0) {
    receipt.items.forEach(item => {
      html += `<div class="item"><span>${item.name}</span><span><strong>$${item.price}</strong></span></div>`;
    });
  } else {
    html += '<p style="color:#666;">No items found</p>';
  }
  html += '</div>';
  info.innerHTML = html;
  document.getElementById('result').classList.add('show');
}

function displaySummary(receipts) {
  if (!receipts || receipts.length === 0) { showError('No receipts found. Upload some receipts first!'); return; }
  let totalSpent = 0, totalTax = 0;
  const stores = new Set();
  receipts.forEach(r => { if (r.total) totalSpent += parseFloat(r.total); if (r.tax) totalTax += parseFloat(r.tax); if (r.storeName) stores.add(r.storeName); });

  const statsHtml = `
    <div class="stat-card"><h4>Total Receipts</h4><div class="value">${receipts.length}</div></div>
    <div class="stat-card"><h4>Total Spent</h4><div class="value">$${totalSpent.toFixed(2)}</div></div>
    <div class="stat-card"><h4>Total Tax</h4><div class="value">$${totalTax.toFixed(2)}</div></div>
    <div class="stat-card"><h4>Unique Stores</h4><div class="value">${stores.size}</div></div>
  `;
  document.getElementById('summaryStats').innerHTML = statsHtml;

  let listHtml = '<h3 style="margin-top:30px;margin-bottom:15px;">All Receipts</h3>';
  receipts.forEach(receipt => {
    listHtml += `<div class="receipt-item"><h4>${receipt.storeName}</h4><p><strong>Date:</strong> ${receipt.date || 'Unknown'}</p><p><strong>Total:</strong> $${receipt.total || '0.00'}</p><p><strong>Items:</strong> ${receipt.items ? receipt.items.length : 0}</p></div>`;
  });
  document.getElementById('receiptsList').innerHTML = listHtml;
  document.getElementById('summaryCard').style.display = 'block';
  document.getElementById('summaryCard').scrollIntoView({ behavior: 'smooth' });
}

function showLoading(show) { 
  document.getElementById('loading').style.display = show ? 'block' : 'none'; 
}

function showError(message) { 
  const e = document.getElementById('error'); 
  e.textContent = message; 
  e.classList.add('show');
}  

function hideError() { 
  document.getElementById('error').classList.remove('show'); 
}

function hideResult() { 
  document.getElementById('result').classList.remove('show'); 
}