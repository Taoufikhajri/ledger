'use client';

import { useEffect, useRef, useState } from 'react';

const EMPTY = { suppliers: [], batches: [] };

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function money(n) {
  return `$${(n || 0).toFixed(2)}`;
}

export default function Page() {
  const [data, setData] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null); // 'supplier' | 'batch' | null
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const saveTimer = useRef(null);
  const skipNextSave = useRef(true);

  // ---- initial load ----
  useEffect(() => {
    fetch('/api/data')
      .then((r) => r.json())
      .then((d) => {
        setData(d || EMPTY);
        setLoaded(true);
      })
      .catch(() => {
        showToast('Could not load your data — check your connection');
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
  const allLinks = data.batches.flatMap((b) =>
    b.links.map((l) => ({ link: l, batch: b }))
  );
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
  data.batches.forEach((b) => {
    supplierCounts[b.supplierId] = (supplierCounts[b.supplierId] || 0) + b.links.length;
  });

  const q = search.trim().toLowerCase();
  const visibleBatches = data.batches
    .filter((b) => supplierFilter === 'all' || b.supplierId === supplierFilter)
    .map((b) => {
      let links = b.links;
      if (statusFilter !== 'all') links = links.filter((l) => l.status === statusFilter);
      if (q) links = links.filter((l) => l.url.toLowerCase().includes(q) || b.product.toLowerCase().includes(q));
      return { ...b, links };
    })
    .filter((b) => b.links.length > 0 || (!q && statusFilter === 'all'));

  // ---- mutations ----
  function addSupplier(name) {
    setData((d) => ({ ...d, suppliers: [...d.suppliers, { id: uid(), name: name.trim() }] }));
  }

  function deleteSupplier(id) {
    if (data.batches.some((b) => b.supplierId === id)) {
      showToast("Can't delete — supplier has batches");
      return;
    }
    setData((d) => ({ ...d, suppliers: d.suppliers.filter((s) => s.id !== id) }));
    if (supplierFilter === id) setSupplierFilter('all');
  }

  function addBatch({ supplierId, product, purchaseDate, pricePerLink, linksText }) {
    const urls = linksText.split('\n').map((s) => s.trim()).filter(Boolean);
    const links = urls.map((url) => ({
      id: uid(),
      url,
      status: 'active',
      addedDate: purchaseDate || todayISO(),
    }));
    const batch = {
      id: uid(),
      supplierId,
      product: product.trim(),
      purchaseDate: purchaseDate || todayISO(),
      pricePerLink: pricePerLink || 0,
      links,
    };
    setData((d) => ({ ...d, batches: [batch, ...d.batches] }));
  }

  function deleteBatch(id) {
    setData((d) => ({ ...d, batches: d.batches.filter((b) => b.id !== id) }));
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
  }

  function copyLink(url) {
    navigator.clipboard.writeText(url).then(() => showToast('Link copied'));
  }

  function exportCSV() {
    const rows = [['Supplier', 'Product', 'Link', 'Status', 'Date added', 'Price per link']];
    visibleBatches.forEach((b) => {
      const sup = data.suppliers.find((s) => s.id === b.supplierId);
      b.links.forEach((l) => {
        rows.push([sup ? sup.name : 'Unknown', b.product, l.url, l.status, l.addedDate, b.pricePerLink || 0]);
      });
    });
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ledger_export.csv';
    a.click();
  }

  if (!loaded) {
    return <div className="center-loading">Loading ledger…</div>;
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
            <span className="count mono">{data.batches.reduce((n, b) => n + b.links.length, 0)}</span>
          </div>
          {data.suppliers.map((s) => (
            <div
              key={s.id}
              className={`supplier-item ${supplierFilter === s.id ? 'active' : ''}`}
              onClick={() => setSupplierFilter(s.id)}
            >
              <span>{s.name}</span>
              <span className="count mono">{supplierCounts[s.id] || 0}</span>
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
            const sup = data.suppliers.find((s) => s.id === b.supplierId);
            return (
              <div className="batch" key={b.id}>
                <div className="batch-head">
                  <span className="product">{b.product}</span>
                  <span className="tag">{sup ? sup.name : 'Unknown supplier'}</span>
                  <span className="date mono">{b.purchaseDate}</span>
                  {b.pricePerLink ? (
                    <span className="price mono">{money(b.pricePerLink)}/link</span>
                  ) : null}
                  <span className="spacer"></span>
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
                    {b.links.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <span className="link-url mono" title={l.url} onClick={() => copyLink(l.url)}>
                            {l.url}
                          </span>
                        </td>
                        <td>
                          <span className={`pill ${l.status}`}>{l.status}</span>
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                          {l.addedDate}
                        </td>
                        <td>
                          <div className="row-actions">
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
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })
        ) : (
          <div className="empty">
            <h3>Nothing here yet</h3>
            <p>
              {data.batches.length === 0
                ? 'Add a supplier, then log your first batch of links.'
                : 'No links match this filter.'}
            </p>
          </div>
        )}
      </div>

      {modal === 'supplier' && (
        <SupplierModal onClose={() => setModal(null)} onSubmit={addSupplier} onError={showToast} />
      )}
      {modal === 'batch' && (
        <BatchModal
          suppliers={data.suppliers}
          onClose={() => setModal(null)}
          onSubmit={addBatch}
          onError={showToast}
          onAddSupplierInstead={() => setModal('supplier')}
        />
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

function BatchModal({ suppliers, onClose, onSubmit, onError, onAddSupplierInstead }) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id || '');
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
            placeholder="Paste one link per line"
            value={linksText}
            onChange={(e) => setLinksText(e.target.value)}
          />
          <div className="hint">Each line becomes its own tracked link, tagged to this supplier.</div>
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
              if (!linksText.trim()) {
                onError('Paste at least one link');
                return;
              }
              onSubmit({
                supplierId,
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
