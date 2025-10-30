// index.js - Main Express server with web interface
const express = require('express');
const multer = require('multer');
const vision = require('@google-cloud/vision');
const { Firestore } = require('@google-cloud/firestore');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const upload = multer({ dest: 'uploads/' });

// Initialize clients
const visionClient = new vision.ImageAnnotatorClient();
const firestore = new Firestore();

// Middleware
app.use(express.json());
app.use(express.static('public'));

async function extractReceiptUsingLayout(imagePath) {
  try {
    const [result] = await visionClient.documentTextDetection(imagePath);
    if (!result || !result.textAnnotations || result.textAnnotations.length === 0) {
      console.log('No text detected.');
      return null;
    }

    const fullText = result.textAnnotations[0].description;
    const rawTokens = result.textAnnotations.slice(1).map(tok => {
      const verts = (tok.boundingPoly && tok.boundingPoly.vertices) || [];
      const xs = verts.map(v => (v.x !== undefined ? v.x : 0));
      const ys = verts.map(v => (v.y !== undefined ? v.y : 0));
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      return { text: tok.description, cx, cy, minX, maxX, minY, maxY };
    });

    if (rawTokens.length === 0) {
      console.log('No tokens found.');
      return null;
    }

    rawTokens.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));

    const lines = [];
    const yTolerance = 10;
    for (const token of rawTokens) {
      const last = lines[lines.length - 1];
      if (!last) {
        lines.push({ tokens: [token], avgY: token.cy });
        continue;
      }
      if (Math.abs(token.cy - last.avgY) <= yTolerance) {
        last.tokens.push(token);
        last.avgY = (last.avgY * (last.tokens.length - 1) + token.cy) / last.tokens.length;
      } else {
        lines.push({ tokens: [token], avgY: token.cy });
      }
    }

    const builtLines = lines.map(line => {
      const toks = line.tokens.slice().sort((a, b) => a.minX - b.minX);
      const text = toks.map(t => t.text).join(' ');
      return { text, tokens: toks, avgY: line.avgY };
    });

    const datePatterns = [
      /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/,
      /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/,
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i,
      /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i
    ];

    let receiptDate = null;
    for (const line of builtLines) {
      if (receiptDate) break;
      for (const pattern of datePatterns) {
        const match = line.text.match(pattern);
        if (match) {
          receiptDate = match[0];
          break;
        }
      }
    }

    if (!receiptDate) {
      for (const pattern of datePatterns) {
        const match = fullText.match(pattern);
        if (match) {
          receiptDate = match[0];
          break;
        }
      }
    }

    const priceRE = /^\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})$/;
    const priceLikeREGlobal = /\d{1,3}(?:,\d{3})*(?:\.\d{2})/g;
    const hasLetters = /[A-Za-z]/;

    const items = [];
    const candidatePrices = [];
    let total = null;
    let tax = null;

    for (let i = 0; i < builtLines.length; i++) {
      const line = builtLines[i];
      const tokens = line.tokens;

      if (!line.text || /^\s*$/.test(line.text)) continue;
      const lower = line.text.toLowerCase();

      if (/subtotal|tax|change|tender|visa|mastercard|account|approval|trans id|validation|no signature|terminal|items sold/.test(lower)) {
        if (/\btotal\b/i.test(line.text) || /\btend\b/i.test(line.text)) {
          const m = (line.text.match(priceLikeREGlobal) || []);
          if (m.length) total = m[m.length - 1].replace(/,/g, '');
        }

        if (/\btax\b/i.test(line.text)) {
          const m = (line.text.match(priceLikeREGlobal) || []);
          if (m.length) tax = m[m.length - 1].replace(/,/g, '');
        }

        continue;
      }

      const priceTokensOnLine = tokens.filter(t => priceRE.test(t.text) || /\d+\.\d{2}/.test(t.text)).map(t => {
        const match = (t.text.match(/\d{1,3}(?:,\d{3})*(?:\.\d{2})/) || [])[0];
        return { token: t, priceStr: match ? match.replace(/,/g, '') : null };
      }).filter(p => p.priceStr);

      if (priceTokensOnLine.length > 0) {
        priceTokensOnLine.sort((a, b) => a.token.minX - b.token.minX);
        const rightmost = priceTokensOnLine[priceTokensOnLine.length - 1];
        const price = rightmost.priceStr;
        candidatePrices.push(price);

        const nameTokens = tokens.filter(t => t.maxX < rightmost.token.minX - 1);
        let name = nameTokens.map(t => t.text).join(' ').trim();

        if (!name || !hasLetters.test(name)) {
          for (let back = 1; back <= 2; back++) {
            if (i - back < 0) break;
            const prev = builtLines[i - back];
            if (!prev) break;
            if (hasLetters.test(prev.text) && !/subtotal|tax|tend|total|change|items sold/i.test(prev.text)) {
              name = prev.text.trim();
              break;
            }
          }
        }

        name = name
          .replace(/\b\d{5,}\b/g, '')
          .replace(/\b\d{12,}\b/g, '')
          .replace(/\s+[A-Z]\b/g, '')
          .replace(/^[\W_]+|[\W_]+$/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        if (name && hasLetters.test(name)) {
          items.push({ name, price });
        } else {
          items.push({ name: null, price });
        }

        continue;
      } else {
        const linePrices = (line.text.match(priceLikeREGlobal) || []);
        if (linePrices.length) candidatePrices.push(...linePrices.map(p => p.replace(/,/g, '')));
      }
    }

    for (let idx = 0; idx < items.length; idx++) {
      if (!items[idx].name) {
        let attached = false;
        for (let back = 1; back <= 3; back++) {
          const lineIdx = idx - back;
          if (lineIdx < 0) break;
          const candLine = builtLines[lineIdx];
          if (candLine && hasLetters.test(candLine.text) && !/subtotal|tax|tend|total|change/i.test(candLine.text)) {
            items[idx].name = candLine.text.trim();
            attached = true;
            break;
          }
        }
        if (!attached) items[idx].name = '(unknown)';
      }
    }

    const cleanedItems = [];
    for (const it of items) {
      if (it.name && /\b(total|tend|change|tax)\b/i.test(it.name)) continue;
      cleanedItems.push({
        name: it.name.trim(),
        price: it.price
      });
    }

    if (!total) {
      for (let i = builtLines.length - 1; i >= 0; i--) {
        const ln = builtLines[i].text;
        if (/\btotal\b/i.test(ln) || /\btend\b/i.test(ln)) {
          const m = ln.match(priceLikeREGlobal);
          if (m && m.length) {
            total = m[m.length - 1].replace(/,/g, '');
            break;
          }
        }
      }
    }
    if (!total && candidatePrices.length) {
      const nums = candidatePrices.map(p => parseFloat(p));
      const max = Math.max(...nums);
      if (isFinite(max)) total = max.toFixed(2);
    }

    const finalItems = cleanedItems.map(it => ({
      name: (it.name || '').replace(/\s{2,}/g, ' ').trim(),
      price: it.price
    })).filter(it => it.price);

    const storeName = fullText.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];

    return { 
      storeName: storeName || 'Unknown', 
      date: receiptDate, 
      items: finalItems, 
      tax, 
      total 
    };
  } catch (err) {
    console.error('Error in layout extraction:', err);
    throw err;
  }
}

// Serve the main web page
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Receipt Scanner</title>
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📄 Receipt Scanner</h1>
            <p>Upload receipts and track your expenses</p>
        </div>
        
        <div class="card">
            <div class="upload-section">
                <h2 style="margin-bottom: 20px; color: #333;">Upload Receipt</h2>
                
                <div class="file-input-wrapper">
                    <input type="file" id="receiptFile" accept="image/*">
                    <label for="receiptFile" class="file-label">
                        📁 Choose Receipt Image
                    </label>
                </div>
                
                <div class="file-name" id="fileName">No file chosen</div>
                
                <div style="margin-top: 20px;">
                    <button class="button" id="uploadBtn" onclick="uploadReceipt()" disabled>
                        🚀 Upload & Scan
                    </button>
                    <button class="button secondary" onclick="getSummary()">
                        📊 View Summary
                    </button>
                </div>
                
                <div class="loading" id="loading">
                    <div class="spinner"></div>
                    <p style="margin-top: 10px; color: #666;">Processing receipt...</p>
                </div>
                
                <div class="error" id="error"></div>
                
                <div class="result" id="result">
                    <h3>✅ Receipt Processed Successfully</h3>
                    <div class="receipt-info" id="receiptInfo"></div>
                </div>
            </div>
        </div>
        
        <div class="card" style="display: none;" id="summaryCard">
            <h2 style="margin-bottom: 20px; color: #333;">📊 Receipts Summary</h2>
            <div class="summary-stats" id="summaryStats"></div>
            <div class="receipts-list" id="receiptsList"></div>
        </div>
    </div>
    
    <script>
        const fileInput = document.getElementById('receiptFile');
        const fileName = document.getElementById('fileName');
        const uploadBtn = document.getElementById('uploadBtn');
        
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
            if (!file) {
                showError('Please select a file');
                return;
            }
            
            const formData = new FormData();
            formData.append('receipt', file);
            formData.append('userId', 'demo-user');
            
            showLoading(true);
            hideError();
            hideResult();
            
            try {
                const response = await fetch('/upload-receipt', {
                    method: 'POST',
                    body: formData
                });
                
                const data = await response.json();
                
                if (data.success) {
                    displayReceipt(data.data);
                } else {
                    showError(data.error || 'Failed to process receipt');
                }
            } catch (error) {
                showError('Network error: ' + error.message);
            } finally {
                showLoading(false);
            }
        }
        
        async function getSummary() {
            showLoading(true);
            hideError();
            
            try {
                const response = await fetch('/receipts?userId=demo-user');
                const data = await response.json();
                
                displaySummary(data.receipts);
            } catch (error) {
                showError('Failed to load summary: ' + error.message);
            } finally {
                showLoading(false);
            }
        }
        
        function displayReceipt(receipt) {
            const info = document.getElementById('receiptInfo');
            
            let html = \`
                <div class="receipt-info">
                    <p><strong>Store:</strong> \${receipt.storeName}</p>
                    <p><strong>Date:</strong> \${receipt.date || 'Not found'}</p>
                    <p><strong>Tax:</strong> $\${receipt.tax || '0.00'}</p>
                    <p><strong>Total:</strong> $\${receipt.total || '0.00'}</p>
                </div>
                
                <div class="items-list">
                    <h4 style="margin-bottom: 10px;">Items:</h4>
            \`;
            
            if (receipt.items && receipt.items.length > 0) {
                receipt.items.forEach(item => {
                    html += \`
                        <div class="item">
                            <span>\${item.name}</span>
                            <span><strong>$\${item.price}</strong></span>
                        </div>
                    \`;
                });
            } else {
                html += '<p style="color: #666;">No items found</p>';
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
            
            // Calculate statistics
            let totalSpent = 0;
            let totalTax = 0;
            const stores = new Set();
            
            receipts.forEach(receipt => {
                if (receipt.total) totalSpent += parseFloat(receipt.total);
                if (receipt.tax) totalTax += parseFloat(receipt.tax);
                if (receipt.storeName) stores.add(receipt.storeName);
            });
            
            // Display stats
            const statsHtml = \`
                <div class="stat-card">
                    <h4>Total Receipts</h4>
                    <div class="value">\${receipts.length}</div>
                </div>
                <div class="stat-card">
                    <h4>Total Spent</h4>
                    <div class="value">$\${totalSpent.toFixed(2)}</div>
                </div>
                <div class="stat-card">
                    <h4>Total Tax</h4>
                    <div class="value">$\${totalTax.toFixed(2)}</div>
                </div>
                <div class="stat-card">
                    <h4>Unique Stores</h4>
                    <div class="value">\${stores.size}</div>
                </div>
            \`;
            
            document.getElementById('summaryStats').innerHTML = statsHtml;
            
            // Display receipts list
            let listHtml = '<h3 style="margin-top: 30px; margin-bottom: 15px;">All Receipts</h3>';
            receipts.forEach(receipt => {
                listHtml += \`
                    <div class="receipt-item">
                        <h4>\${receipt.storeName}</h4>
                        <p><strong>Date:</strong> \${receipt.date || 'Unknown'}</p>
                        <p><strong>Total:</strong> $\${receipt.total || '0.00'}</p>
                        <p><strong>Items:</strong> \${receipt.items ? receipt.items.length : 0}</p>
                    </div>
                \`;
            });
            
            document.getElementById('receiptsList').innerHTML = listHtml;
            document.getElementById('summaryCard').style.display = 'block';
            
            // Scroll to summary
            document.getElementById('summaryCard').scrollIntoView({ behavior: 'smooth' });
        }
        
        function showLoading(show) {
            document.getElementById('loading').style.display = show ? 'block' : 'none';
        }
        
        function showError(message) {
            const errorDiv = document.getElementById('error');
            errorDiv.textContent = message;
            errorDiv.classList.add('show');
        }
        
        function hideError() {
            document.getElementById('error').classList.remove('show');
        }
        
        function hideResult() {
            document.getElementById('result').classList.remove('show');
        }
    </script>
</body>
</html>
  `);
});

// API Routes
app.post('/upload-receipt', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const imagePath = req.file.path;
    
    // Extract receipt data
    const receiptData = await extractReceiptUsingLayout(imagePath);
    
    if (!receiptData) {
      await fs.unlink(imagePath);
      return res.status(400).json({ error: 'Could not extract receipt data' });
    }

    // Store in Firestore
    const docRef = await firestore.collection('receipts').add({
      ...receiptData,
      uploadedAt: new Date().toISOString(),
      userId: req.body.userId || 'anonymous'
    });

    // Clean up uploaded file
    await fs.unlink(imagePath);

    res.json({
      success: true,
      receiptId: docRef.id,
      data: receiptData
    });

  } catch (error) {
    console.error('Error processing receipt:', error);
    res.status(500).json({ error: 'Failed to process receipt', details: error.message });
  }
});

// Get all receipts
app.get('/receipts', async (req, res) => {
  try {
    const userId = req.query.userId || 'anonymous';
    const snapshot = await firestore.collection('receipts')
      .where('userId', '==', userId)
      .orderBy('uploadedAt', 'desc')
      .get();

    const receipts = [];
    snapshot.forEach(doc => {
      receipts.push({ id: doc.id, ...doc.data() });
    });

    res.json({ receipts });
  } catch (error) {
    console.error('Error fetching receipts:', error);
    res.status(500).json({ error: 'Failed to fetch receipts' });
  }
});

// Get single receipt
app.get('/receipts/:id', async (req, res) => {
  try {
    const doc = await firestore.collection('receipts').doc(req.params.id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error('Error fetching receipt:', error);
    res.status(500).json({ error: 'Failed to fetch receipt' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});