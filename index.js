const express = require('express');
const multer = require('multer');
const vision = require('@google-cloud/vision');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const upload = multer({ dest: 'uploads/' });

// Initialize Clients
const visionClient = new vision.ImageAnnotatorClient();

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp();
}
const firestore = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
global.FieldValue = FieldValue;

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
async function updateStoreTotals(storeName, receiptTotal) {
  try {
    console.log('updateStoreTotals called:', { storeName, receiptTotal });

    // CLEAN AND VALIDATE
    const cleanName = String(storeName || 'Unknown Store').trim();
    if (!cleanName) {
      console.error('Empty store name, skipping totals update');
      return;
    }

    const totalStr = String(receiptTotal || 0).replace(/[$\,]/g, '');
    const amount = parseFloat(totalStr);

    if (isNaN(amount) || amount <= 0) {
      console.error('Invalid amount:', receiptTotal);
      return;
    }

    const storeRef = firestore.collection('storeTotals').doc(cleanName);

    // TRY TO INCREMENT — WILL FAIL IF DOC DOESN'T EXIST
    try {
      await storeRef.update({
        totalSpent: FieldValue.increment(amount)
      });
      console.log('Successfully incremented total for:', cleanName);
    } catch (err) {
      if (err.message.includes('NOT_FOUND') || err.code === 5) {
        console.log('First time seeing store:', cleanName, '→ creating document');
        await storeRef.set({
          totalSpent: amount,
          percentOfTotal: 0
        });
      } else {
        throw err;
      }
    }

    // RECALCULATE PERCENTAGES
    const snapshot = await firestore.collection('storeTotals').get();
    let grandTotal = 0;
    const updates = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      const spent = data.totalSpent || 0;
      grandTotal += spent;
      updates.push({ ref: doc.ref, spent });
    });

    if (updates.length > 0) {
      const batch = firestore.batch();
      updates.forEach(({ ref, spent }) => {
        const percent = grandTotal > 0 ? (spent / grandTotal) * 100 : 0;
        batch.set(ref, { percentOfTotal: percent }, { merge: true });
      });
      await batch.commit();
      console.log('Percentages updated. Grand total:', grandTotal.toFixed(2));
    }

  } catch (err) {
    console.error('updateStoreTotals FAILED:', err);
  }
}
// Serve the main web page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

    let receiptDateTimestamp;
    if (receiptData.date) {
      // Handle formats like "10/25/2025" or "2025-11-19"
      const parsed = new Date(receiptData.date);
      receiptDateTimestamp = isNaN(parsed.getTime()) 
        ? admin.firestore.Timestamp.now() 
        : admin.firestore.Timestamp.fromDate(parsed);
    } else {
      receiptDateTimestamp = admin.firestore.Timestamp.now();
    }

    const docRef = await firestore.collection('receipts').add({
      ...receiptData,
      date: receiptDateTimestamp,        // ← REAL TIMESTAMP
      dateString: receiptData.date,      // ← keep original for display
      uploadedAt: admin.firestore.Timestamp.now(),
      userId: req.body.userId || 'anonymous'
    });

    updateStoreTotals(receiptData.storeName || 'Unknown', receiptData.total)
      .catch(err => {
        console.error('updateStoreTotals threw but upload continues:', err);
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
app.get('/api/store-breakdown', async (req, res) => {
  const snapshot = await firestore.collection('storeTotals').get();
  const result = [];
  snapshot.forEach(doc => result.push({ store: doc.id, ...doc.data() }));
  res.json(result);
});
app.get('/api/store-totals', async (req, res) => {
  try {
    const snapshot = await firestore.collection('storeTotals').get();
    const stores = [];
    snapshot.forEach(doc => stores.push({ store: doc.id, ...doc.data() }));
    res.json({ success: true, stores });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to load store totals' });
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