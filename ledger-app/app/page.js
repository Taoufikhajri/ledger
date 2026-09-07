'use client';

import { useEffect, useRef, useState } from 'react';

const EMPTY = { suppliers: [], types: [], batches: [] };

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

  const suppliers = data.suppliers || [];
  const types = data.types || [];
  const batches = data.batches || [];

  // ---- initial load ----
  useEffect(() => {
    fetch('/api/data')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.error) {
          setLoadError(d.error);
        } else if (d && Array.isArray(d.suppliers) && Array.isArray(d.batches)) {
          setData({ suppliers: d.suppliers, types: d.types || [], batches: d.batches });
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
    const links = urls.map((url) => ({
      id: uid(),
      url,
      status: 'active',
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
    const rows = [['Supplier', 'Type', 'Product', 'Link', 'Status', 'Date added', 'Price per link']];
    visibleBatches.forEach((b) => {
      const sup = suppliers.find((s) => s.id === b.supplierId);
      const typ = types.find((t) => t.id === b.typeId);
      b.links.forEach((l) => {
        rows.push([
          sup ? sup.name : 'Unknown',
          typ ? typ.name : '',
          b.product,
          l.url,
          l.status,
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
          list.push({ batchId: b.id, linkId: l.id, url: l.url });
        });
      });
    return list;
  }

  // ---- manual verify-links flow ----
  function startVerify() {
    const queue = activeLinksForCurrentFilters();
    if (queue.length === 0) {
      showToast('No active links to verify with the current filters');
      return;
    }
    setVerifyQueue(queue);
    setVerifyIndex(0);
    window.open(queue[0].url, '_blank', 'noopener');
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

        {visibleBatches.length ? (
          visibleBatches.map((b) => {
            const sup = suppliers.find((s) => s.id === b.supplierId);
            const typ = types.find((t) => t.id === b.typeId);
            const anyChecking = b.links.some((l) => checks[l.id]?.state === 'checking');
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
                  <button className="btn btn-sm" disabled={anyChecking} onClick={() => testBatch(b)}>
                    {anyChecking ? 'Testing…' : 'Test all links'}
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
