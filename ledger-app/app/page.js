'use client';

import { useEffect, useRef, useState } from 'react';

const EMPTY = { suppliers: [], types: [], batches: [], settings: {} };
const DEFAULT_SETTINGS = { sellPrice: 0, targetProfit: 0.15 };

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function money(n) {
  return `$${(n || 0).toFixed(2)}`;
}
function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g);
  return matches ? Array.from(new Set(matches)) : [];
}
function batchRefPrefix(supplierName, dateStr) {
  const initials = (supplierName || 'GEN').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'GEN';
  const d = new Date(dateStr || Date.now());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${initials}${mm}${dd}`;
}

// The Ledger Link Verifier Chrome extension, if installed, lets links be
// sent to it directly instead of verifying one by one in this tab. Update
// this if you ever regenerate the extension with a different signing key
// (its README explains how the ID is derived).
const EXTENSION_ID = 'ajfinjgibbglcmfgdogecjohgjafbiif';

function sendToExtension(links, extraPhrases) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.chrome || !window.chrome.runtime || !window.chrome.runtime.sendMessage) {
      resolve({ ok: false, error: 'not-available' });
      return;
    }
    try {
      window.chrome.runtime.sendMessage(
        EXTENSION_ID,
        { type: 'VERIFY', links, phrases: extraPhrases },
        (response) => {
          if (window.chrome.runtime.lastError || !response) {
            resolve({ ok: false, error: window.chrome.runtime.lastError?.message || 'no-response' });
          } else {
            resolve(response);
          }
        }
      );
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

function getResultsFromExtension(urls) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.chrome || !window.chrome.runtime || !window.chrome.runtime.sendMessage) {
      resolve({ ok: false, error: 'not-available' });
      return;
    }
    try {
      window.chrome.runtime.sendMessage(EXTENSION_ID, { type: 'GET_RESULTS', urls }, (response) => {
        if (window.chrome.runtime.lastError || !response) {
          resolve({ ok: false, error: window.chrome.runtime.lastError?.message || 'no-response' });
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

export default function Page() {
  const [data, setData] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null); // 'supplier' | 'type' | 'batch' | null
  const [toast, setToast] = useState('');
  const [checks, setChecks] = useState({}); // linkId -> { state, looksUsed, status, error }
  const [testingSupplier, setTestingSupplier] = useState(null);
  const [verifyQueue, setVerifyQueue] = useState([]); // [{ batchId, linkId, url }]
  const [verifyIndex, setVerifyIndex] = useState(0);
  const toastTimer = useRef(null);
  const saveTimer = useRef(null);
  const skipNextSave = useRef(true);
  const pollTimer = useRef(null);
  const pendingUrls = useRef([]);

  const suppliers = data.suppliers || [];
  const types = data.types || [];
  const batches = data.batches || [];
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };

  // ---- initial load ----
  useEffect(() => {
    fetch('/api/data')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.error) {
          setLoadError(d.error);
        } else if (d && Array.isArray(d.suppliers) && Array.isArray(d.batches)) {
          setData({ suppliers: d.suppliers, types: d.types || [], batches: d.batches, settings: d.settings || {} });
        } else {
          setData(EMPTY);
        }
        setLoaded(true);
      })
      .catch(() => {
        setLoadError('Could not reach the server. Check your connection and try refreshing.');
        setLoaded(true);
      });
  }, []);

  // ---- autosave on change (debounced) ----
  useEffect(() => {
    if (!loaded) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    setSaving(true);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
        .then(() => setSaving(false))
        .catch(() => {
          setSaving(false);
          showToast('Save failed — check your connection');
        });
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1800);
  }

  // ---- derived ----
  const allLinks = batches.flatMap((b) => b.links.map((l) => ({ link: l, batch: b })));
  const totalLinks = allLinks.length;
  const activeCount = allLinks.filter((x) => x.link.status === 'active').length;
  const expiredCount = allLinks.filter((x) => x.link.status === 'expired').length;
  const refundedCount = allLinks.filter((x) => x.link.status === 'refunded').length;
  const riskValue = allLinks
    .filter((x) => x.link.status === 'expired')
    .reduce((sum, x) => sum + (x.batch.pricePerLink || 0), 0);
  const refundedValue = allLinks
    .filter((x) => x.link.status === 'refunded')
    .reduce((sum, x) => sum + (x.batch.pricePerLink || 0), 0);

  // ---- profitability (combined across every batch) ----
  // Waste rate: fraction of purchased links that turned out unusable
  // (expired or refunded) rather than sellable.
  const wastedLinks = allLinks.filter((x) => x.link.status === 'expired' || x.link.status === 'refunded').length;
  const wasteRate = totalLinks > 0 ? wastedLinks / totalLinks : 0;
  const totalCost = allLinks.reduce((sum, x) => sum + (x.batch.pricePerLink || 0), 0);
  const avgBuyPrice = totalLinks > 0 ? totalCost / totalLinks : 0;
  const avgRevenuePerLink = (1 - wasteRate) * settings.sellPrice;
  const avgProfitPerLink = avgRevenuePerLink - avgBuyPrice;
  const maxBuyPrice = avgRevenuePerLink - settings.targetProfit;

  const supplierCounts = {};
  const typeCounts = {};
  batches.forEach((b) => {
    supplierCounts[b.supplierId] = (supplierCounts[b.supplierId] || 0) + b.links.length;
    if (b.typeId) typeCounts[b.typeId] = (typeCounts[b.typeId] || 0) + b.links.length;
  });

  const q = search.trim().toLowerCase();
  const visibleBatches = batches
    .filter((b) => supplierFilter === 'all' || b.supplierId === supplierFilter)
    .filter((b) => typeFilter === 'all' || b.typeId === typeFilter)
    .map((b) => {
      let links = b.links;
      if (statusFilter !== 'all') links = links.filter((l) => l.status === statusFilter);
      if (q) links = links.filter((l) => l.url.toLowerCase().includes(q) || b.product.toLowerCase().includes(q));
      return { ...b, links };
    })
    .filter((b) => b.links.length > 0 || (!q && statusFilter === 'all'));

  // ---- mutations ----
  function updateSettings(patch) {
    setData((d) => ({ ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}), ...patch } }));
  }

  function addSupplier(name) {
    setData((d) => ({ ...d, suppliers: [...(d.suppliers || []), { id: uid(), name: name.trim() }] }));
  }

  function deleteSupplier(id) {
    if (batches.some((b) => b.supplierId === id)) {
      showToast("Can't delete — supplier has batches");
      return;
    }
    setData((d) => ({ ...d, suppliers: (d.suppliers || []).filter((s) => s.id !== id) }));
    if (supplierFilter === id) setSupplierFilter('all');
  }

  function addType(name, invalidText) {
    setData((d) => ({
      ...d,
      types: [...(d.types || []), { id: uid(), name: name.trim(), invalidText: (invalidText || '').trim() }],
    }));
  }

  function deleteType(id) {
    if (batches.some((b) => b.typeId === id)) {
      showToast("Can't delete — a batch uses this type");
      return;
    }
    setData((d) => ({ ...d, types: (d.types || []).filter((t) => t.id !== id) }));
    if (typeFilter === id) setTypeFilter('all');
  }

  function addBatch({ supplierId, typeId, product, purchaseDate, pricePerLink, linksText }) {
    const urls = extractUrls(linksText);
    const sup = suppliers.find((s) => s.id === supplierId);
    const prefix = batchRefPrefix(sup?.name, purchaseDate);
    const links = urls.map((url, i) => ({
      id: uid(),
      ref: `${prefix}-${String(i + 1).padStart(3, '0')}`,
      url,
      status: 'active',
      sentToBot: false,
      addedDate: purchaseDate || todayISO(),
    }));
    const batch = {
      id: uid(),
      supplierId,
      typeId: typeId || null,
      product: product.trim(),
      purchaseDate: purchaseDate || todayISO(),
      pricePerLink: pricePerLink || 0,
      links,
    };
    setData((d) => ({ ...d, batches: [batch, ...(d.batches || [])] }));
  }

  function deleteBatch(id) {
    setData((d) => ({ ...d, batches: (d.batches || []).filter((b) => b.id !== id) }));
  }

  function setLinkStatus(batchId, linkId, status) {
    setData((d) => ({
      ...d,
      batches: d.batches.map((b) =>
        b.id !== batchId
          ? b
          : { ...b, links: b.links.map((l) => (l.id === linkId ? { ...l, status } : l)) }
      ),
    }));
  }

  function setLinkSentToBot(batchId, linkId, sentToBot) {
    setData((d) => ({
      ...d,
      batches: d.batches.map((b) =>
        b.id !== batchId
          ? b
          : { ...b, links: b.links.map((l) => (l.id === linkId ? { ...l, sentToBot } : l)) }
      ),
    }));
  }

  function deleteLink(batchId, linkId) {
    setData((d) => ({
      ...d,
      batches: d.batches.map((b) =>
        b.id !== batchId ? b : { ...b, links: b.links.filter((l) => l.id !== linkId) }
      ),
    }));
    setChecks((c) => {
      const next = { ...c };
      delete next[linkId];
      return next;
    });
  }

  function copyLink(url) {
    navigator.clipboard.writeText(url).then(() => showToast('Link copied'));
  }

  function exportCSV() {
    const rows = [
      ['Ref', 'Supplier', 'Type', 'Product', 'Link', 'Status', 'Verification', 'Sent to bot', 'Date added', 'Price per link'],
    ];
    visibleBatches.forEach((b) => {
      const sup = suppliers.find((s) => s.id === b.supplierId);
      const typ = types.find((t) => t.id === b.typeId);
      b.links.forEach((l) => {
        rows.push([
          l.ref || '',
          sup ? sup.name : 'Unknown',
          typ ? typ.name : '',
          b.product,
          l.url,
          l.status,
          l.verifyResult || '',
          l.sentToBot ? 'yes' : 'no',
          l.addedDate,
          b.pricePerLink || 0,
        ]);
      });
    });
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ledger_export.csv';
    a.click();
  }

  // ---- active links matching the current supplier/type/search filters ----
  // (ignores the status dropdown on purpose — verifying and the AYMEN list
  // are always about active links specifically)
  function activeLinksForCurrentFilters() {
    const q = search.trim().toLowerCase();
    const list = [];
    batches
      .filter((b) => supplierFilter === 'all' || b.supplierId === supplierFilter)
      .filter((b) => typeFilter === 'all' || b.typeId === typeFilter)
      .forEach((b) => {
        b.links.forEach((l) => {
          if (l.status !== 'active') return;
          if (q && !(l.url.toLowerCase().includes(q) || b.product.toLowerCase().includes(q))) return;
          list.push({ batchId: b.id, linkId: l.id, url: l.url, ref: l.ref || l.id.slice(0, 6).toUpperCase() });
        });
      });
    return list;
  }

  // ---- verify-links flow (extension first, in-app fallback) ----
  // Reusable for both the topbar's filter-scoped button and a single
  // batch's own button.
  function applyExtensionResults(results) {
    if (!results || Object.keys(results).length === 0) return 0;
    let appliedCount = 0;
    setData((d) => ({
      ...d,
      batches: d.batches.map((b) => ({
        ...b,
        links: b.links.map((l) => {
          const r = results[l.url];
          if (!r) return l;
          const status = typeof r === 'string' ? r : r.status;
          const verifyResult = status === 'used' ? 'used' : status === 'working' ? 'working' : l.verifyResult || null;
          const newStatus = status === 'used' && l.status === 'active' ? 'expired' : l.status;
          if (verifyResult === l.verifyResult && newStatus === l.status) return l;
          appliedCount += 1;
          return { ...l, verifyResult, status: newStatus };
        }),
      })),
    }));
    return appliedCount;
  }

  function pollForResults(urls) {
    pendingUrls.current = urls;
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(async () => {
      const res = await getResultsFromExtension(pendingUrls.current);
      if (!res.ok || !res.results) return;
      applyExtensionResults(res.results);
      pendingUrls.current = pendingUrls.current.filter((u) => !res.results[u]);
      if (pendingUrls.current.length === 0) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
        showToast('Verification results synced to your batches');
      }
    }, 4000);
  }

  async function syncFromExtension() {
    const allUrls = batches.flatMap((b) => b.links.map((l) => l.url));
    if (allUrls.length === 0) {
      showToast('No links to sync');
      return;
    }
    const res = await getResultsFromExtension(allUrls);
    if (!res.ok) {
      showToast('Could not reach the Ledger Link Verifier extension');
      return;
    }
    const count = applyExtensionResults(res.results);
    showToast(count ? `Synced ${count} result(s) from the extension` : 'No new results to sync yet');
  }

  async function verifyLinks(queue) {
    if (queue.length === 0) {
      showToast('No active links to verify');
      return;
    }

    const relevantBatchIds = new Set(queue.map((x) => x.batchId));
    const extraPhrases = Array.from(
      new Set(batches.filter((b) => relevantBatchIds.has(b.id)).flatMap((b) => phrasesForBatch(b)))
    );
    const links = queue.map((x) => ({ url: x.url, ref: x.ref }));

    const extResult = await sendToExtension(links, extraPhrases);
    if (extResult.ok) {
      showToast(`Sent ${links.length} link(s) to the Ledger Link Verifier extension — results will sync back automatically`);
      pollForResults(links.map((l) => l.url));
      return;
    }

    // Extension not installed or not reachable — fall back to the in-app
    // manual flow (opens each link in a new tab, you mark it yourself).
    setVerifyQueue(queue);
    setVerifyIndex(0);
    window.open(queue[0].url, '_blank', 'noopener');
  }

  function startVerify() {
    return verifyLinks(activeLinksForCurrentFilters());
  }

  function verifyBatch(batch) {
    const queue = batch.links
      .filter((l) => l.status === 'active')
      .map((l) => ({ batchId: batch.id, linkId: l.id, url: l.url, ref: l.ref || l.id.slice(0, 6).toUpperCase() }));
    return verifyLinks(queue);
  }

  function reopenCurrentVerifyLink() {
    const current = verifyQueue[verifyIndex];
    if (current) window.open(current.url, '_blank', 'noopener');
  }

  function advanceVerify(action) {
    const current = verifyQueue[verifyIndex];
    if (!current) return;
    if (action === 'remove') {
      deleteLink(current.batchId, current.linkId);
    }
    const nextIndex = verifyIndex + 1;
    if (nextIndex >= verifyQueue.length) {
      setVerifyQueue([]);
      setVerifyIndex(0);
      showToast('Done verifying');
      return;
    }
    setVerifyIndex(nextIndex);
    window.open(verifyQueue[nextIndex].url, '_blank', 'noopener');
  }

  function stopVerify() {
    setVerifyQueue([]);
    setVerifyIndex(0);
  }

  // ---- copy the working-links list, AYMEN-separated ----
  function copyWorkingList() {
    const links = activeLinksForCurrentFilters().map((x) => x.url);
    if (links.length === 0) {
      showToast('No active links match the current filters');
      return;
    }
    const text = links.join('\nAYMEN\n');
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(`Copied ${links.length} working link(s)`))
      .catch(() => showToast('Could not copy — try again'));
  }

  // ---- link testing ----
  function phrasesForBatch(batch) {
    const typ = types.find((t) => t.id === batch.typeId);
    if (!typ || !typ.invalidText) return [];
    return typ.invalidText
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }

  async function testLink(link, batch) {
    setChecks((c) => ({ ...c, [link.id]: { state: 'checking' } }));
    try {
      const res = await fetch('/api/check-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link.url, extraPhrases: phrasesForBatch(batch) }),
      });
      const result = await res.json();
      if (result.ok) {
        setChecks((c) => ({
          ...c,
          [link.id]: { state: 'done', looksUsed: result.looksUsed, status: result.status },
        }));
      } else {
        setChecks((c) => ({ ...c, [link.id]: { state: 'error', error: result.error || 'Check failed' } }));
      }
    } catch (e) {
      setChecks((c) => ({ ...c, [link.id]: { state: 'error', error: 'Check failed' } }));
    }
  }

  async function testBatch(batch) {
    for (const link of batch.links) {
      // eslint-disable-next-line no-await-in-loop
      await testLink(link, batch);
    }
  }

  async function testSupplier(supplierId) {
    const supplierBatches = supplierId === 'all' ? batches : batches.filter((b) => b.supplierId === supplierId);
    for (const batch of supplierBatches) {
      // eslint-disable-next-line no-await-in-loop
      await testBatch(batch);
    }
  }

  async function runSupplierTest(supplierId) {
    setTestingSupplier(supplierId);
    try {
      await testSupplier(supplierId);
    } finally {
      setTestingSupplier(null);
    }
  }

  if (!loaded) {
    return <div className="center-loading">Loading ledger…</div>;
  }

  if (loadError) {
    return (
      <div className="center-loading">
        <div style={{ maxWidth: 440, textAlign: 'left' }}>
          <h2 style={{ marginBottom: 8 }}>Can't load your data</h2>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>{loadError}</p>
          <p style={{ color: 'var(--muted)' }}>
            If you haven't yet, connect a Redis database from your Vercel project's Storage
            (or Marketplace) tab, then redeploy. See the README for step-by-step instructions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="brand">
          <h1>Ledger</h1>
          <p>
            <span className={`sync-dot ${saving ? 'saving' : ''}`}></span>
            {saving ? 'Saving…' : 'Synced'}
          </p>
        </div>
        <button className="btn btn-primary btn-block" onClick={() => setModal('supplier')}>
          + Add supplier
        </button>
        <div className="supplier-list">
          <div
            className={`supplier-item ${supplierFilter === 'all' ? 'active' : ''}`}
            onClick={() => setSupplierFilter('all')}
          >
            <span>All suppliers</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="count mono">{batches.reduce((n, b) => n + b.links.length, 0)}</span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={testingSupplier !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  runSupplierTest('all');
                }}
              >
                {testingSupplier === 'all' ? 'Testing…' : 'Test all'}
              </button>
            </span>
          </div>
          {suppliers.map((s) => (
            <div
              key={s.id}
              className={`supplier-item ${supplierFilter === s.id ? 'active' : ''}`}
              onClick={() => setSupplierFilter(s.id)}
            >
              <span>{s.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="count mono">{supplierCounts[s.id] || 0}</span>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={testingSupplier !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    runSupplierTest(s.id);
                  }}
                >
                  {testingSupplier === s.id ? 'Testing…' : 'Test'}
                </button>
              </span>
            </div>
          ))}
        </div>

        <button className="btn btn-block" onClick={() => setModal('type')}>
          + Add type
        </button>
        <div className="supplier-list">
          <div
            className={`supplier-item ${typeFilter === 'all' ? 'active' : ''}`}
            onClick={() => setTypeFilter('all')}
          >
            <span>All types</span>
          </div>
          {types.map((t) => (
            <div
              key={t.id}
              className={`supplier-item ${typeFilter === t.id ? 'active' : ''}`}
              onClick={() => setTypeFilter(t.id)}
            >
              <span>{t.name}</span>
              <span className="count mono">{typeCounts[t.id] || 0}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="main">
        <div className="topbar">
          <button className="btn btn-primary" onClick={() => setModal('batch')}>
            + Log batch
          </button>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="refunded">Refunded</option>
          </select>
          <input
            type="search"
            placeholder="Search product or link…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn" onClick={startVerify} disabled={verifyQueue.length > 0}>
            Verify links
          </button>
          <button className="btn" onClick={copyWorkingList}>
            Copy working list
          </button>
          <button className="btn" onClick={syncFromExtension}>
            Sync results
          </button>
          <button className="btn" onClick={() => setModal('check')}>
            Check links
          </button>
          <button className="btn" onClick={exportCSV}>
            Export CSV
          </button>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="n mono">{totalLinks}</div>
            <div className="l">Total links</div>
          </div>
          <div className="stat active">
            <div className="n mono">{activeCount}</div>
            <div className="l">Active</div>
          </div>
          <div className="stat expired">
            <div className="n mono">{expiredCount}</div>
            <div className="l">Expired</div>
          </div>
          <div className="stat refunded">
            <div className="n mono">{refundedCount}</div>
            <div className="l">Refunded</div>
          </div>
          <div className="stat risk">
            <div className="n mono">{money(riskValue)}</div>
            <div className="l">Refund owed</div>
          </div>
          <div className="stat">
            <div className="n mono">{money(refundedValue)}</div>
            <div className="l">Refunded value</div>
          </div>
        </div>

        <div className="profit-panel">
          <div className="profit-inputs">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Your sell price per link</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={settings.sellPrice}
                onChange={(e) => updateSettings({ sellPrice: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Target profit per link</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={settings.targetProfit}
                onChange={(e) => updateSettings({ targetProfit: parseFloat(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="stats" style={{ margin: 0 }}>
            <div className="stat">
              <div className="n mono">{(wasteRate * 100).toFixed(1)}%</div>
              <div className="l">Waste rate</div>
            </div>
            <div className="stat">
              <div className="n mono">{money(avgBuyPrice)}</div>
              <div className="l">Current avg buy price</div>
            </div>
            <div className={`stat ${avgProfitPerLink >= settings.targetProfit ? 'active' : 'risk'}`}>
              <div className="n mono">{money(avgProfitPerLink)}</div>
              <div className="l">Current avg profit/link</div>
            </div>
            <div className="stat">
              <div className="n mono">{money(maxBuyPrice)}</div>
              <div className="l">Max buy price to hit target</div>
            </div>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            Based on {totalLinks} link(s) across all batches: {wastedLinks} turned out expired or
            refunded (waste rate above). Max buy price = (1 − waste rate) × sell price − target
            profit — the most you can pay per link from a supplier and still average your target
            profit, given links get wasted at this rate.
          </div>
        </div>

        {visibleBatches.length ? (
          visibleBatches.map((b) => {
            const sup = suppliers.find((s) => s.id === b.supplierId);
            const typ = types.find((t) => t.id === b.typeId);
            return (
              <div className="batch" key={b.id}>
                <div className="batch-head">
                  <span className="product">{b.product}</span>
                  <span className="tag">{sup ? sup.name : 'Unknown supplier'}</span>
                  {typ && <span className="tag">{typ.name}</span>}
                  <span className="date mono">{b.purchaseDate}</span>
                  {b.pricePerLink ? (
                    <span className="price mono">{money(b.pricePerLink)}/link</span>
                  ) : null}
                  <span className="spacer"></span>
                  <button className="btn btn-sm" onClick={() => verifyBatch(b)}>
                    Verify links
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      if (confirm('Delete this batch and its links?')) deleteBatch(b.id);
                    }}
                  >
                    Delete batch
                  </button>
                </div>
                <table className="links-table">
                  <tbody>
                    {b.links.map((l) => {
                      const check = checks[l.id];
                      return (
                        <tr key={l.id}>
                          <td className="mono" style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {l.ref || l.id.slice(0, 6).toUpperCase()}
                          </td>
                          <td>
                            <span className="link-url mono" title={l.url} onClick={() => copyLink(l.url)}>
                              {l.url}
                            </span>
                            {check && check.state === 'checking' && (
                              <div className="check-result unknown">Checking…</div>
                            )}
                            {check && check.state === 'error' && (
                              <div className="check-result unknown">{check.error}</div>
                            )}
                            {check && check.state === 'done' && check.looksUsed && (
                              <div className="check-result used">
                                Looks used
                                <button
                                  className="btn btn-ghost btn-sm"
                                  style={{ marginLeft: 6 }}
                                  onClick={() => setLinkStatus(b.id, l.id, 'expired')}
                                >
                                  Apply: mark expired
                                </button>
                              </div>
                            )}
                            {check && check.state === 'done' && !check.looksUsed && (
                              <div className="check-result ok">
                                Not flagged as used
                                {check.status ? ` (status ${check.status})` : ''}
                                {check.renderer === 'plain'
                                  ? ' — inconclusive if this page shows its result via JavaScript'
                                  : ' (checked with JavaScript rendering)'}
                              </div>
                            )}
                          </td>
                          <td>
                            <span className={`pill ${l.status}`}>{l.status}</span>
                          </td>
                          <td>
                            {l.verifyResult === 'used' && <span className="pill expired">Used</span>}
                            {l.verifyResult === 'working' && <span className="pill active">Working</span>}
                            {!l.verifyResult && <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>}
                          </td>
                          <td>
                            <button
                              className={`btn btn-sm ${l.sentToBot ? 'btn-primary' : 'btn-ghost'}`}
                              onClick={() => setLinkSentToBot(b.id, l.id, !l.sentToBot)}
                            >
                              {l.sentToBot ? 'Sent to bot' : 'Not sent'}
                            </button>
                          </td>
                          <td className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                            {l.addedDate}
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={check?.state === 'checking'}
                                onClick={() => testLink(l, b)}
                              >
                                Test
                              </button>
                              {l.status === 'active' && (
                                <button className="btn btn-sm" onClick={() => setLinkStatus(b.id, l.id, 'expired')}>
                                  Mark expired
                                </button>
                              )}
                              {l.status === 'expired' && (
                                <button className="btn btn-sm" onClick={() => setLinkStatus(b.id, l.id, 'refunded')}>
                                  Mark refunded
                                </button>
                              )}
                              {l.status !== 'active' && (
                                <button className="btn btn-ghost btn-sm" onClick={() => setLinkStatus(b.id, l.id, 'active')}>
                                  Reactivate
                                </button>
                              )}
                              <button className="btn btn-ghost btn-sm" onClick={() => deleteLink(b.id, l.id)}>
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })
        ) : (
          <div className="empty">
            <h3>Nothing here yet</h3>
            <p>
              {batches.length === 0
                ? 'Add a supplier, then log your first batch of links.'
                : 'No links match this filter.'}
            </p>
          </div>
        )}
      </div>

      {modal === 'supplier' && (
        <SupplierModal onClose={() => setModal(null)} onSubmit={addSupplier} onError={showToast} />
      )}
      {modal === 'type' && (
        <TypeModal onClose={() => setModal(null)} onSubmit={addType} onError={showToast} />
      )}
      {modal === 'batch' && (
        <BatchModal
          suppliers={suppliers}
          types={types}
          onClose={() => setModal(null)}
          onSubmit={addBatch}
          onError={showToast}
          onAddSupplierInstead={() => setModal('supplier')}
        />
      )}
      {modal === 'check' && (
        <CheckLinksModal batches={batches} suppliers={suppliers} onClose={() => setModal(null)} />
      )}

      {verifyQueue.length > 0 && (
        <div className="verify-bar">
          <span className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
            {verifyIndex + 1} / {verifyQueue.length}
          </span>
          <span className="link-url mono" title={verifyQueue[verifyIndex]?.url} style={{ maxWidth: 320 }}>
            {verifyQueue[verifyIndex]?.url}
          </span>
          <button className="btn btn-sm" onClick={reopenCurrentVerifyLink}>
            Reopen link
          </button>
          <span className="spacer"></span>
          <button className="btn btn-primary btn-sm" onClick={() => advanceVerify('working')}>
            Working
          </button>
          <button className="btn btn-sm" onClick={() => advanceVerify('remove')}>
            Used — remove
          </button>
          <button className="btn btn-ghost btn-sm" onClick={stopVerify}>
            Stop
          </button>
        </div>
      )}

      <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>
    </div>
  );
}

function SupplierModal({ onClose, onSubmit, onError }) {
  const [name, setName] = useState('');
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Add supplier</h2>
        <div className="field">
          <label>Supplier name</label>
          <input
            autoFocus
            placeholder="e.g. Reseller X"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!name.trim()) {
                onError('Enter a supplier name');
                return;
              }
              onSubmit(name);
              onClose();
            }}
          >
            Add supplier
          </button>
        </div>
      </div>
    </div>
  );
}

function TypeModal({ onClose, onSubmit, onError }) {
  const [name, setName] = useState('');
  const [invalidText, setInvalidText] = useState('');
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Add product type</h2>
        <div className="field">
          <label>Type name</label>
          <input
            autoFocus
            placeholder="e.g. Gemini Pro, Netflix, Spotify…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label>"Already used" phrases (optional)</label>
          <input
            placeholder="e.g. already in use, already been used"
            value={invalidText}
            onChange={(e) => setInvalidText(e.target.value)}
          />
          <div className="hint">
            Comma-separated text that appears on this type's activation page when a link has
            already been used. Used by the "Test" button. A few generic phrases are always
            checked too — this just adds ones specific to this service.
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!name.trim()) {
                onError('Enter a type name');
                return;
              }
              onSubmit(name, invalidText);
              onClose();
            }}
          >
            Add type
          </button>
        </div>
      </div>
    </div>
  );
}

function BatchModal({ suppliers, types, onClose, onSubmit, onError, onAddSupplierInstead }) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id || '');
  const [typeId, setTypeId] = useState('');
  const [product, setProduct] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(todayISO());
  const [pricePerLink, setPricePerLink] = useState('');
  const [linksText, setLinksText] = useState('');

  if (suppliers.length === 0) {
    return (
      <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <h2>Log batch</h2>
          <p style={{ color: 'var(--muted)' }}>Add a supplier first so this batch can be tracked back to them.</p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={onAddSupplierInstead}>
              Add supplier
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Log batch</h2>
        <div className="field">
          <label>Supplier</label>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Type (optional)</label>
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">No type</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className="hint">Add types from the sidebar's "+ Add type" button.</div>
        </div>
        <div className="field">
          <label>Product</label>
          <input
            placeholder="e.g. Gemini Pro — 18 Months"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Purchase date</label>
          <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Price paid per link (optional)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={pricePerLink}
            onChange={(e) => setPricePerLink(e.target.value)}
          />
          <div className="hint">Used to total up refunds owed when links expire.</div>
        </div>
        <div className="field">
          <label>Links</label>
          <textarea
            placeholder="Paste anything containing links — numbered lists, bot messages, extra text. Anything starting with http:// or https:// is picked up."
            value={linksText}
            onChange={(e) => setLinksText(e.target.value)}
          />
          <div className="hint">
            {extractUrls(linksText).length} link(s) detected in the text above.
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!product.trim()) {
                onError('Enter a product name');
                return;
              }
              const urls = extractUrls(linksText);
              if (urls.length === 0) {
                onError('No links detected — check the pasted text');
                return;
              }
              onSubmit({
                supplierId,
                typeId,
                product,
                purchaseDate,
                pricePerLink: parseFloat(pricePerLink) || 0,
                linksText,
              });
              onClose();
            }}
          >
            Save batch
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckLinksModal({ batches, suppliers, onClose }) {
  const [pastedText, setPastedText] = useState('');
  const [results, setResults] = useState(null); // null until checked

  function runCheck() {
    const pasted = extractUrls(pastedText);
    if (pasted.length === 0) {
      setResults([]);
      return;
    }
    const index = new Map();
    batches.forEach((b) => {
      b.links.forEach((l) => {
        index.set(l.url, { batch: b, link: l });
      });
    });
    const computed = pasted.map((url) => {
      const hit = index.get(url);
      if (!hit) return { url, found: false };
      const sup = suppliers.find((s) => s.id === hit.batch.supplierId);
      return {
        url,
        found: true,
        ref: hit.link.ref || hit.link.id.slice(0, 6).toUpperCase(),
        supplierName: sup ? sup.name : 'Unknown',
        product: hit.batch.product,
        status: hit.link.status,
      };
    });
    setResults(computed);
  }

  const foundCount = results ? results.filter((r) => r.found).length : 0;

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <h2>Check links against your batches</h2>
        <div className="field">
          <label>Paste links to check</label>
          <textarea
            placeholder="Paste any text containing links — matches against everything saved in your ledger"
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
          />
          <div className="hint">{extractUrls(pastedText).length} link(s) detected in the text above.</div>
        </div>

        {results !== null && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
              {foundCount} of {results.length} found in your batches
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              {results.length === 0 ? (
                <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                  No links detected in the pasted text.
                </div>
              ) : (
                results.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '8px 10px',
                      borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none',
                      fontSize: 12,
                    }}
                  >
                    <div
                      className="mono"
                      style={{
                        color: 'var(--muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.url}
                    >
                      {r.url}
                    </div>
                    {r.found ? (
                      <div className="check-result ok">
                        Found — {r.ref} · {r.supplierName} · {r.product} · {r.status}
                      </div>
                    ) : (
                      <div className="check-result used">Not in your batches</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={runCheck}>
            Check
          </button>
        </div>
      </div>
    </div>
  );
}
