import React, { useState, useEffect, useCallback } from 'react';
import { nwc } from '@getalby/sdk';

const ORANGE = '#f7931a';
const GREEN = '#00ff9d';

const PAYMENT_SOUNDS = [
  '/sounds/a comerla.ogg',
  '/sounds/dolor.ogg',
  '/sounds/exactamente lo que vote.ogg',
  '/sounds/hola-juan-carlos.mp3',
  '/sounds/kukardo.ogg',
  '/sounds/michael.ogg',
  '/sounds/noo la policia.mp3',
  '/sounds/opinion de los kukas.ogg',
  '/sounds/satoshi nakamoto.mp3',
  '/sounds/viva la libertad carajo.ogg',
];

function playPaymentSound() {
  const src = PAYMENT_SOUNDS[Math.floor(Math.random() * PAYMENT_SOUNDS.length)];
  new Audio(src).play().catch(() => {});
}

// ── Storage helpers ────────────────────────────────────────────────────────────

/** Lee wallets. Migra automáticamente el viejo `nwcUrl` si existe. */
export function getNWCWallets() {
  try {
    // Siempre intentar migrar nwcUrl legacy si existe (incluso si nwcWallets ya existe pero vacío)
    const legacy = localStorage.getItem('nwcUrl');
    if (legacy) {
      const existing = (() => { try { return JSON.parse(localStorage.getItem('nwcWallets') || '[]'); } catch { return []; } })();
      const wallet = { id: crypto.randomUUID(), name: 'Mi Wallet', url: legacy };
      const wallets = [...existing, wallet];
      localStorage.setItem('nwcWallets', JSON.stringify(wallets));
      if (!localStorage.getItem('nwcDefaultId')) localStorage.setItem('nwcDefaultId', wallet.id);
      localStorage.removeItem('nwcUrl');
      return wallets;
    }
    const raw = localStorage.getItem('nwcWallets');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveNWCWallets(wallets) {
  localStorage.setItem('nwcWallets', JSON.stringify(wallets));
}

export function getDefaultNWCWallet() {
  const wallets = getNWCWallets();
  if (!wallets.length) return null;
  const defaultId = localStorage.getItem('nwcDefaultId');
  return wallets.find(w => w.id === defaultId) || wallets[0];
}

export function setDefaultNWCWallet(id) {
  localStorage.setItem('nwcDefaultId', id);
}

// ── NWCWalletManager (para el formulario de edición) ──────────────────────────

export function NWCWalletManager() {
  const [wallets, setWallets] = useState([]);
  const [defaultId, setDefaultId] = useState('');
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState('');

  useEffect(() => {
    setWallets(getNWCWallets());
    setDefaultId(localStorage.getItem('nwcDefaultId') || '');
  }, []);

  function persist(updated, newDefaultId) {
    saveNWCWallets(updated);
    const did = newDefaultId ?? defaultId;
    if (!updated.find(w => w.id === did) && updated.length > 0) {
      localStorage.setItem('nwcDefaultId', updated[0].id);
      setDefaultId(updated[0].id);
    } else if (newDefaultId) {
      localStorage.setItem('nwcDefaultId', newDefaultId);
      setDefaultId(newDefaultId);
    }
    setWallets(updated);
  }

  function removeWallet(id) {
    persist(wallets.filter(w => w.id !== id));
  }

  function markDefault(id) {
    persist(wallets, id);
  }

  function addWallet() {
    setAddError('');
    if (!newName.trim()) { setAddError('Poné un nombre para la wallet'); return; }
    if (!newUrl.trim().startsWith('nostr+walletconnect://')) { setAddError('La URL debe empezar con nostr+walletconnect://'); return; }
    const wallet = { id: crypto.randomUUID(), name: newName.trim(), url: newUrl.trim() };
    const updated = [...wallets, wallet];
    persist(updated, updated.length === 1 ? wallet.id : defaultId);
    setNewName('');
    setNewUrl('');
    setShowAdd(false);
  }

  const inputStyle = {
    width: '100%',
    padding: '10px 14px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '0.9rem',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ marginTop: '8px', marginBottom: '8px', padding: '16px', background: 'rgba(247,147,26,0.05)', border: '1px solid rgba(247,147,26,0.15)', borderRadius: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: wallets.length ? '12px' : '0' }}>
        <label style={{ fontSize: '0.72rem', fontWeight: '700', color: ORANGE, textTransform: 'uppercase', letterSpacing: '0.8px', margin: 0 }}>
          ⚡ NWC — Nostr Wallet Connect
        </label>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            style={{ padding: '5px 12px', background: 'rgba(247,147,26,0.12)', border: '1px solid rgba(247,147,26,0.3)', borderRadius: '8px', color: ORANGE, cursor: 'pointer', fontSize: '0.8rem', fontWeight: '600' }}
          >
            + Agregar
          </button>
        )}
      </div>

      {/* Lista de wallets */}
      {wallets.length === 0 && !showAdd && (
        <p style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.3)', margin: '8px 0 0' }}>
          No tenés wallets conectadas. Se guarda solo en tu browser.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {wallets.map(w => {
          const isDefault = w.id === defaultId || (!defaultId && wallets[0].id === w.id);
          return (
            <div
              key={w.id}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 12px',
                background: isDefault ? 'rgba(247,147,26,0.08)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isDefault ? 'rgba(247,147,26,0.35)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '10px',
              }}
            >
              {/* Estrella favorita */}
              <button
                onClick={() => markDefault(w.id)}
                title={isDefault ? 'Wallet predeterminada' : 'Marcar como predeterminada'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0', flexShrink: 0 }}
              >
                {isDefault ? '⭐' : '☆'}
              </button>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.88rem', fontWeight: '600', color: isDefault ? ORANGE : '#fff' }}>{w.name}</div>
                <div style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {w.url.slice(0, 50)}…
                </div>
              </div>

              {/* Eliminar */}
              <button
                onClick={() => removeWallet(w.id)}
                title="Eliminar"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,100,100,0.6)', fontSize: '1rem', padding: '0', flexShrink: 0 }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      {/* Formulario agregar */}
      {showAdd && (
        <div style={{ marginTop: wallets.length ? '12px' : '4px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <input
            style={inputStyle}
            placeholder="Nombre (ej: Alby, Phoenix, Blink)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
          <input
            style={inputStyle}
            placeholder="nostr+walletconnect://..."
            value={newUrl}
            onChange={e => setNewUrl(e.target.value)}
          />
          {addError && <span style={{ fontSize: '0.78rem', color: '#ff6b6b' }}>{addError}</span>}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => { setShowAdd(false); setNewName(''); setNewUrl(''); setAddError(''); }}
              style={{ flex: 1, padding: '10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontSize: '0.88rem' }}
            >
              Cancelar
            </button>
            <button
              onClick={addWallet}
              style={{ flex: 2, padding: '10px', background: ORANGE, border: 'none', borderRadius: '8px', color: '#000', fontWeight: '700', cursor: 'pointer', fontSize: '0.88rem' }}
            >
              Guardar wallet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── WalletTransfer (para CardView, transfiere entre wallets propias) ───────────

export function WalletTransfer() {
  const [wallets, setWallets] = useState([]);
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [destId, setDestId] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState({ msg: '', type: '' });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const reload = useCallback(() => {
    const ws = getNWCWallets();
    setWallets(ws);
    if (ws.length >= 2) {
      const defId = localStorage.getItem('nwcDefaultId') || ws[0].id;
      setSourceId(defId);
      setDestId(ws.find(w => w.id !== defId)?.id || ws[1].id);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (wallets.length < 2) return null;

  async function transfer() {
    const sats = parseInt(amount);
    if (!sats || sats < 1) { setStatus({ msg: 'Ingresá una cantidad válida', type: 'error' }); return; }
    if (sourceId === destId) { setStatus({ msg: 'Origen y destino deben ser wallets distintas', type: 'error' }); return; }

    const src = wallets.find(w => w.id === sourceId);
    const dst = wallets.find(w => w.id === destId);
    if (!src || !dst) return;

    setLoading(true);
    setStatus({ msg: '', type: '' });
    setSuccess(false);

    try {
      // 1. Generar invoice desde la wallet destino
      setStatus({ msg: `Generando invoice en ${dst.name}...`, type: 'info' });
      const dstClient = new nwc.NWCClient({ nostrWalletConnectUrl: dst.url });
      const inv = await dstClient.makeInvoice({
        amount: sats * 1000, // NWC usa millisats
        description: `Transferencia desde ${src.name}`,
      });

      // 2. Pagar con la wallet origen
      setStatus({ msg: `Pagando desde ${src.name}...`, type: 'info' });
      const srcClient = new nwc.NWCClient({ nostrWalletConnectUrl: src.url });
      await srcClient.payInvoice({ invoice: inv.invoice });

      setStatus({ msg: '', type: '' });
      setSuccess(true);
      setAmount('');
      playPaymentSound();
      setTimeout(() => setSuccess(false), 5000);
    } catch (err) {
      const errStr = String(err?.message ?? err);
      // Algunas wallets devuelven preimage vacío aunque el pago fue exitoso
      if (errStr.includes('preimage') || errStr.includes('validation')) {
        setStatus({ msg: '', type: '' });
        setSuccess(true);
        setAmount('');
        playPaymentSound();
        setTimeout(() => setSuccess(false), 5000);
      } else {
        setStatus({ msg: 'Error: ' + err.message, type: 'error' });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: '12px' }}>
      {!open ? (
        <button
          onClick={() => { setOpen(true); reload(); }}
          style={{
            width: '100%', padding: '12px',
            background: 'rgba(247,147,26,0.07)',
            border: '1px dashed rgba(247,147,26,0.35)',
            borderRadius: '12px', color: ORANGE,
            cursor: 'pointer', fontSize: '0.88rem', fontWeight: '600',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(247,147,26,0.12)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(247,147,26,0.07)'}
        >
          ↔ Transferir entre mis wallets
        </button>
      ) : (
        <div style={{ background: 'rgba(247,147,26,0.06)', border: '1px solid rgba(247,147,26,0.25)', borderRadius: '14px', padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.88rem', fontWeight: '700', color: ORANGE }}>↔ Transferir entre wallets</span>
            <button onClick={() => { setOpen(false); setStatus({ msg: '', type: '' }); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
          </div>

          {/* Origen */}
          <div>
            <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '6px' }}>Desde</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {wallets.map(w => (
                <button
                  key={w.id}
                  onClick={() => {
                    setSourceId(w.id);
                    if (destId === w.id) setDestId(wallets.find(x => x.id !== w.id)?.id || '');
                  }}
                  style={{
                    padding: '10px 14px', textAlign: 'left',
                    background: sourceId === w.id ? 'rgba(247,147,26,0.15)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${sourceId === w.id ? ORANGE : 'rgba(255,255,255,0.1)'}`,
                    borderRadius: '10px', color: sourceId === w.id ? ORANGE : 'rgba(255,255,255,0.7)',
                    cursor: 'pointer', fontSize: '0.88rem', fontWeight: sourceId === w.id ? '700' : '400',
                  }}
                >
                  {sourceId === w.id ? '▶ ' : ''}{w.name}
                </button>
              ))}
            </div>
          </div>

          {/* Destino */}
          <div>
            <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '6px' }}>Hacia</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {wallets.filter(w => w.id !== sourceId).map(w => (
                <button
                  key={w.id}
                  onClick={() => setDestId(w.id)}
                  style={{
                    padding: '10px 14px', textAlign: 'left',
                    background: destId === w.id ? 'rgba(0,255,157,0.12)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${destId === w.id ? GREEN : 'rgba(255,255,255,0.1)'}`,
                    borderRadius: '10px', color: destId === w.id ? GREEN : 'rgba(255,255,255,0.7)',
                    cursor: 'pointer', fontSize: '0.88rem', fontWeight: destId === w.id ? '700' : '400',
                  }}
                >
                  {destId === w.id ? '▶ ' : ''}{w.name}
                </button>
              ))}
            </div>
          </div>

          {/* Monto */}
          <input
            style={{ width: '100%', padding: '12px 14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px', color: '#fff', fontSize: '0.95rem', outline: 'none', boxSizing: 'border-box' }}
            type="number"
            placeholder="Monto en sats..."
            value={amount}
            onChange={e => setAmount(e.target.value)}
          />

          {/* Status */}
          {status.msg && (
            <p style={{ margin: 0, fontSize: '0.82rem', color: status.type === 'error' ? '#ff6b6b' : 'rgba(255,255,255,0.5)' }}>{status.msg}</p>
          )}
          {success && (
            <div style={{ padding: '12px', background: 'rgba(0,255,157,0.1)', border: '1px solid rgba(0,255,157,0.3)', borderRadius: '10px', textAlign: 'center', color: GREEN, fontWeight: '700', fontSize: '0.92rem' }}>
              ⚡ Transferencia exitosa!
            </div>
          )}

          <button
            onClick={transfer}
            disabled={loading || !amount}
            style={{
              width: '100%', padding: '14px',
              background: loading || !amount ? 'rgba(247,147,26,0.3)' : ORANGE,
              color: '#000', fontWeight: '700', border: 'none', borderRadius: '12px',
              cursor: loading || !amount ? 'not-allowed' : 'pointer', fontSize: '0.95rem',
            }}
          >
            {loading ? status.msg || 'Procesando...' : `Enviar ${amount || '?'} sats`}
          </button>
        </div>
      )}
    </div>
  );
}
