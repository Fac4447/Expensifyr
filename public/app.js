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
async function getMonthlyTotals(year, month) {
  // month = 0 to 11 (January = 0)
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0));        // UTC midnight
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));      // next month

  const snapshot = await firestore
    .collection("receipts")
    .where("date", ">=", start)
    .where("date", "<", end)
    .get();

  console.log(`Querying ${year}-${String(month + 1).padStart(2, '0')}: found ${snapshot.size} receipts`);

  const totals = {};

  snapshot.forEach(doc => {
    const data = doc.data();
    const store = data.storeName || 'Unknown Store';
    const amount = parseFloat(String(data.total || 0).replace(/[$\,]/g, ''));

    if (!isNaN(amount) && amount > 0) {
      totals[store] = (totals[store] || 0) + amount;
    }
  });

  return totals;
}
async function loadMonthlyPieChart(year, month) {
  const totals = await getMonthlyTotals(year, month);

  const stores = Object.keys(totals);
  const values = Object.values(totals);

  const grandTotal = values.reduce((a, b) => a + b, 0);

  const percentages = values.map(v => (v / grandTotal) * 100);

  return { stores, percentages };
}
window.loadStoreTotals = async function () {
  try {
    const res = await fetch('/api/store-totals');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const stores = data.stores || [];
    const listEl = document.getElementById('storeTotalsList');
    const cardEl = document.getElementById('storeTotalsCard');

    if (!stores.length) {
      listEl.innerHTML = "<p>No store totals found.</p>";
      cardEl.style.display = 'block';
      return;
    }

    let html = `<h4 style="margin-bottom:10px;">Store Totals</h4>`;
    stores.forEach(s => {
      html += `
        <div class="item">
          <span>${s.store}</span>
          <span><strong>$${s.totalSpent.toFixed(2)}</strong> (${s.percentOfTotal.toFixed(1)}%)</span>
        </div>`;
    });
    listEl.innerHTML = html;

    const labels = stores.map(s => s.store);
    const percentages = stores.map(s => Number(s.percentOfTotal || 0));

    if (window.storePieChart && typeof window.storePieChart.destroy === "function") {
      window.storePieChart.destroy();
    }

    const ctx = document.getElementById('storePieChart').getContext('2d');

    window.storePieChart = new Chart(ctx, {
      type: 'pie',
      data: {
        labels,
        datasets: [{ data: percentages }]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } }
      }
    });

    cardEl.style.display = 'block';
    cardEl.scrollIntoView({ behavior: 'smooth' });

  } catch (err) {
    showError("Failed to load store totals: " + err.message);
  }
};
// Keep a global chart reference
let monthlyPieChart = null;
async function viewMonthlyChart() {
  const yearInput = document.getElementById('yearInput');
  const monthInput = document.getElementById('monthInput');
  const container = document.getElementById('monthlyChartContainer');
  const listEl = document.getElementById('monthlyTotalsList');
  const titleEl = document.getElementById('monthlyTitle');

  // Parse year/month
  let year = parseInt(yearInput.value);
  let month = parseInt(monthInput.value);
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return;
  month = month - 1;

  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  titleEl.textContent = `Monthly Spending – ${monthNames[month]} ${year}`;

  listEl.innerHTML = 'Loading...';

  try {
    const totals = await getMonthlyTotals(year, month);
    const stores = Object.keys(totals);
    const amounts = Object.values(totals);
    const grandTotal = amounts.reduce((a,b) => a + b, 0) || 0;

    // Build list
    if (grandTotal > 0) {
      let html = '<strong>Store Totals</strong><br>';
      Object.keys(totals).sort((a,b) => totals[b]-totals[a]).forEach(store => {
        const amt = totals[store];
        const pct = (amt / grandTotal) * 100;
        html += `${store} <strong>$${amt.toFixed(2)}</strong> (${pct.toFixed(1)}%)<br>`;
      });
      listEl.innerHTML = html;
    } else {
      listEl.innerHTML = 'No receipts found for this month.';
    }

    const canvas = document.getElementById('monthlyPieChart');

    // Destroy previous chart if it exists
    if (monthlyPieChart) {
      monthlyPieChart.destroy();
      monthlyPieChart = null;
    }

    const ctx = canvas.getContext('2d');

    const backgroundColors = stores.map((_, i) =>
      `hsla(${(i * 360 / stores.length) + 30}, 70%, 60%, 0.9)`
    );

    monthlyPieChart = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: stores,
        datasets: [{
          data: amounts,
          backgroundColor: backgroundColors,
          borderColor: '#fff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true, // natural height
        plugins: { legend: { position: 'bottom' } }
      }
    });

    // Show container after chart/list ready and scroll smoothly
    container.style.display = 'block';
    container.scrollIntoView({ behavior: 'smooth' });

  } catch(err) {
    console.error(err);
    listEl.innerHTML = `<p style="color:red;">Error: ${err.message}</p>`;
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
  if (!receipts || receipts.length === 0) { 
    showError('No receipts found. Upload some receipts first!'); 
    return; 
  }
  
  let totalSpent = 0, totalTax = 0;
  const stores = new Set();
  
  receipts.forEach(r => { 
    if (r.total) totalSpent += parseFloat(r.total); 
    if (r.tax) totalTax += parseFloat(r.tax); 
    if (r.storeName) stores.add(r.storeName); 
  });

  const statsHtml = `
    <div class="stat-card"><h4>Total Receipts</h4><div class="value">${receipts.length}</div></div>
    <div class="stat-card"><h4>Total Spent</h4><div class="value">$${totalSpent.toFixed(2)}</div></div>
    <div class="stat-card"><h4>Total Tax</h4><div class="value">$${totalTax.toFixed(2)}</div></div>
    <div class="stat-card"><h4>Unique Stores</h4><div class="value">${stores.size}</div></div>
  `;
  document.getElementById('summaryStats').innerHTML = statsHtml;

  let listHtml = '<h3 style="margin-top:30px;margin-bottom:15px;">All Receipts</h3>';
  
  receipts.forEach(receipt => {
    // ✅ FIX: Handle different date formats
    let displayDate = 'Unknown';
    
    if (receipt.dateString) {
      // Use the original date string if available
      displayDate = receipt.dateString;
    } else if (receipt.date) {
      // Handle Firestore Timestamp objects
      if (receipt.date.toDate && typeof receipt.date.toDate === 'function') {
        // It's a Firestore Timestamp
        const dateObj = receipt.date.toDate();
        displayDate = dateObj.toLocaleDateString('en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
      } else if (receipt.date.seconds) {
        // It's a Firestore Timestamp in plain object form
        const dateObj = new Date(receipt.date.seconds * 1000);
        displayDate = dateObj.toLocaleDateString('en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
      } else if (typeof receipt.date === 'string') {
        // It's already a string
        displayDate = receipt.date;
      }
    }
    
    listHtml += `
      <div class="receipt-item" onclick="toggleReceiptItems('${receipt.id}')" style="cursor:pointer;">
        <h4>${receipt.storeName} <small style="font-weight:normal; color:#666; margin-left:8px;">(click to view items)</small></h4>
        <p><strong>Date:</strong> ${displayDate}</p>
        <p><strong>Total:</strong> $${receipt.total || '0.00'}</p>
        <p><strong>Items:</strong> ${receipt.items ? receipt.items.length : 0}</p>
        <div id="items-${receipt.id}" class="items-container" style="display:none; margin-top:10px;"></div>
      </div>`;
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

async function toggleReceiptItems(id) {
  const containerId = `items-${id}`;
  const itemsEl = document.getElementById(containerId);
  if (!itemsEl) return;

  // If it already has children (loaded), just toggle visibility
  if (itemsEl.innerHTML && itemsEl.innerHTML.trim().length > 0) {
    itemsEl.style.display = itemsEl.style.display === 'none' ? 'block' : 'none';
    return;
  }

  // Show a loading placeholder
  itemsEl.style.display = 'block';
  itemsEl.innerHTML = '<p style="color:#666;">Loading items...</p>';

  try {
    const res = await fetch(`/receipts/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const errText = await res.text();
      itemsEl.innerHTML = `<p style="color:red;">Failed to load receipt: ${res.status} ${errText}</p>`;
      return;
    }
    const receipt = await res.json();
    let html = '<div class="items-list"><h4 style="margin-bottom:10px;">Items</h4>';
    if (receipt.items && receipt.items.length) {
      receipt.items.forEach(it => {
        html += `<div class="item"><span>${it.name}</span><span><strong>$${it.price}</strong></span></div>`;
      });
      html += `<div style="padding:10px; border-top:1px dashed #ddd; font-size:0.95em; color:#444;"><strong>Tax:</strong> $${receipt.tax || '0.00'} &nbsp; <strong>Total:</strong> $${receipt.total || '0.00'}</div>`;
    } else {
      html += '<p style="color:#666;">No items found for this receipt.</p>';
    }
    html += '</div>';

    itemsEl.innerHTML = html;
  } catch (err) {
    itemsEl.innerHTML = `<p style="color:red;">Error loading receipt: ${err.message}</p>`;
  }
}