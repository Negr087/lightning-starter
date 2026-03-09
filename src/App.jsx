import React, { useState, useRef, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { LightningAddress } from '@getalby/lightning-tools';
import { nwc } from '@getalby/sdk';
import NDK from '@nostr-dev-kit/ndk';

// ── Nostr + NWC ───────────────────────────────────────────────────────────────

const RELAYS = [
  'wss://relay.primal.net',    // Primal — muy estable
  'wss://nos.lol',             // nos.lol — confiable
  'wss://relay.nostr.band',    // nostr.band — bueno para búsquedas
  'wss://nostr.wine',          // nostr.wine — backup
  'wss://relay.damus.io',      // damus — a veces con issues
];
let _ndk = null;

async function getNDK() {
  if (!_ndk) {
    _ndk = new NDK({ explicitRelayUrls: RELAYS });
    await _ndk.connect(4000); // espera hasta 4s a que al menos un relay conecte
  }
  return _ndk;
}


async function fetchFromNostr(npub) {
  const ndk = await getNDK();
  const user = ndk.getUser({ npub });
  const event = await ndk.fetchEvent({ kinds: [0], authors: [user.pubkey] });
  if (!event) return null;
  const c = JSON.parse(event.content);
  let lnCard = {};
  try { lnCard = JSON.parse(c.ln_card || '{}'); } catch {}
  return {
    name: c.name || c.display_name || '',
    bio: c.about || '',
    lnAddress: c.lud16 || '',
    avatarUrl: c.picture || '',
    bannerUrl: c.banner || '',
    nip05: c.nip05 || '',
    github: lnCard.github || '',
    twitter: lnCard.twitter || '',
    nostr: lnCard.nostr_profile || `https://primal.net/${npub}`,
    extraLinks: lnCard.extraLinks || [],
    npub,
    readonly: true,
  };
}

async function fetchOwnNostrProfile() {
  if (!window.nostr) throw new Error('No se detectó extensión Nostr. Instalá Alby o nos2x.');
  const ndk = await getNDK();
  const pubkey = await window.nostr.getPublicKey();
  const user = ndk.getUser({ pubkey });
  const event = await ndk.fetchEvent({ kinds: [0], authors: [pubkey] });
  if (!event) throw new Error('No se encontró perfil Nostr para tu clave pública.');
  const c = JSON.parse(event.content);
  let lnCard = {};
  try { lnCard = JSON.parse(c.ln_card || '{}'); } catch {}
  return {
    name: c.name || c.display_name || '',
    bio: c.about || '',
    lnAddress: c.lud16 || '',
    avatarUrl: c.picture || '',
    bannerUrl: c.banner || '',
    nip05: c.nip05 || '',
    github: lnCard.github || '',
    twitter: lnCard.twitter || '',
    nostr: `https://primal.net/${user.npub}`,
    extraLinks: lnCard.extraLinks || [],
  };
}

async function fetchProfileByHexPubkey(hexPubkey) {
  const { nip19 } = await import('nostr-tools');
  const npub = nip19.npubEncode(hexPubkey);
  const profile = await fetchFromNostr(npub);
  if (!profile) throw new Error('No se encontró perfil Nostr.');
  return { ...profile, readonly: false };
}

// ── Primal / NIP-46 connect ────────────────────────────────────────────────────

async function initPrimalConnect() {
  const { generateSecretKey, getPublicKey, bytesToHex } = await import('nostr-tools/pure');
  const clientSecret = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecret);
  const secret = 'sec-' + bytesToHex(crypto.getRandomValues(new Uint8Array(8)));

  localStorage.setItem('nip46_pending', JSON.stringify({
    localSecretKey: bytesToHex(clientSecret),
    localPublicKey: clientPubkey,
    secret,
    timestamp: Date.now(),
  }));

  const callbackUrl = `${window.location.origin}${window.location.pathname}?nip46_callback=1`;
  const params = new URLSearchParams([
    ['relay', 'wss://relay.primal.net'],
    ['secret', secret],
    ['name', 'Digital Card'],
    ['url', window.location.origin],
    ['callback', callbackUrl],
  ]);
  window.location.href = `nostrconnect://${clientPubkey}?${params}`;
}

async function completePrimalConnect(timeoutMs = 20000) {
  const sessionStr = localStorage.getItem('nip46_pending');
  if (!sessionStr) throw new Error('No hay sesión pendiente de Primal.');
  const session = JSON.parse(sessionStr);
  if (Date.now() - session.timestamp > 5 * 60 * 1000) {
    localStorage.removeItem('nip46_pending');
    throw new Error('La sesión expiró. Intentá de nuevo.');
  }

  const { hexToBytes, finalizeEvent } = await import('nostr-tools/pure');
  const { nip44 } = await import('nostr-tools');
  const localSecretKey = hexToBytes(session.localSecretKey);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://relay.primal.net');
    let done = false;

    const fail = (msg) => { if (!done) { done = true; ws.close(); reject(new Error(msg)); } };
    const timer = setTimeout(() => fail('Timeout: Primal no respondió. Abrí la app y aprobá la solicitud.'), timeoutMs);

    ws.onopen = () => {
      const since = Math.floor(Date.now() / 1000) - 300;
      ws.send(JSON.stringify(['REQ', 'nip46', { kinds: [24133], '#p': [session.localPublicKey], since }]));
    };

    ws.onmessage = async (e) => {
      if (done) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg[0] !== 'EVENT') return;
        const event = msg[2];
        if (!event || event.kind !== 24133) return;

        const signerPubkey = event.pubkey;
        const convoKey = nip44.v2.utils.getConversationKey(localSecretKey, signerPubkey);
        const parsed = JSON.parse(nip44.v2.decrypt(event.content, convoKey));

        if (parsed.method === 'connect') {
          const userPubkeyHex = parsed.params?.[0];
          if (!userPubkeyHex) return;

          // Send ACK back to signer
          const ackContent = nip44.v2.encrypt(
            JSON.stringify({ id: parsed.id, result: 'ack', error: '' }),
            nip44.v2.utils.getConversationKey(localSecretKey, signerPubkey),
          );
          const ackEvent = finalizeEvent({
            kind: 24133,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', signerPubkey]],
            content: ackContent,
          }, localSecretKey);
          ws.send(JSON.stringify(['EVENT', ackEvent]));

          done = true;
          clearTimeout(timer);
          localStorage.removeItem('nip46_pending');
          setTimeout(() => ws.close(), 500);
          resolve(userPubkeyHex);
        }
      } catch { /* ignore decode errors */ }
    };

    ws.onerror = () => fail('Error conectando a relay.primal.net');
  });
}

// ── Bitcoin price ticker ───────────────────────────────────────────────────────

function BTCPrice() {
  const [price, setPrice] = useState(null);

  useEffect(() => {
    async function fetchPrice() {
      try {
        const res = await fetch('https://api.coinpaprika.com/v1/tickers/btc-bitcoin');
        const data = await res.json();
        setPrice(Math.round(data.quotes.USD.price).toLocaleString('en-US'));
      } catch {}
    }
    fetchPrice();
    const interval = setInterval(fetchPrice, 60000);
    return () => clearInterval(interval);
  }, []);

  if (!price) return null;

  return (
    <div style={{
      position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)',
      zIndex: 100, pointerEvents: 'none',
      background: 'rgba(0,255,157,0.07)', border: '1px solid rgba(0,255,157,0.2)',
      borderRadius: '20px', padding: '4px 14px',
      fontSize: '0.75rem', color: '#00ff9d', fontFamily: 'monospace', fontWeight: '600',
      letterSpacing: '0.3px', whiteSpace: 'nowrap',
    }}>
      ₿ ${price}
    </div>
  );
}

// ── Views: 'landing' | 'form' | 'card' | 'loading' ───────────────────────────

export default function App() {
  const [view, setView] = useState('landing');
  const [cardData, setCardData] = useState(null);
  const [ownCard, setOwnCard] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const npub = params.get('npub');
    const cardParam = params.get('card');

    if (npub) {
      setView('loading');
      fetchFromNostr(npub)
        .then(data => { if (data) { setCardData(data); setView('card'); } else setView('landing'); })
        .catch(() => setView('landing'));
      return;
    }
    if (cardParam) {
      try {
        const data = JSON.parse(decodeURIComponent(escape(atob(cardParam))));
        setCardData({ ...data, readonly: true });
        setView('card');
      } catch { setView('landing'); }
      return;
    }
    // Restaurar tarjeta guardada localmente
    try {
      const saved = localStorage.getItem('cardData');
      if (saved) {
        const parsed = JSON.parse(saved);
        setCardData(parsed);
        setOwnCard(parsed);
        setView('card');
      }
    } catch {}
  }, []);

  function saveCard(data) {
    setCardData(data);
    setOwnCard(data);
    try { localStorage.setItem('cardData', JSON.stringify(data)); } catch {}
    setView('card');
  }

  function openSearch() {
    setView('search');
  }

  function handleCardFound(card) {
    setCardData(card);
    setView('card');
  }

  function handleBackFromSearch() {
    if (ownCard) { setCardData(ownCard); setView('card'); }
    else setView('landing');
  }

  let content;
  if (view === 'loading') content = (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg, #0a0f1a 0%, #0d1f2d 50%, #0a0f1a 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ textAlign: 'center', opacity: 0.6 }}>
        <div style={{ fontSize: '2rem', marginBottom: '12px' }}>⚡</div>
        <div>Cargando tarjeta desde Nostr...</div>
      </div>
    </div>
  );
  else if (view === 'landing') content = <Landing onStart={() => ownCard ? setView('card') : setView('form')} hasCard={!!ownCard} onSearch={openSearch} />;
  else if (view === 'form') content = <CardForm onDone={saveCard} onBack={() => setView('landing')} initialData={ownCard} />;
  else if (view === 'card') content = <CardView data={cardData} onEdit={cardData?.readonly ? null : () => setView('form')} onBack={cardData?.readonly ? () => { setCardData(ownCard); setView('search'); } : null} onSearch={openSearch} onHome={() => { if (ownCard) setCardData(ownCard); setView('landing'); }} />;
  else if (view === 'search') content = <SearchView onCardFound={handleCardFound} onBack={handleBackFromSearch} />;

  return <>{content}<BTCPrice /></>;
}

// ── Shared tokens ─────────────────────────────────────────────────────────────

const GREEN = '#00ff9d';

function EggsIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 33 26" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'inline', verticalAlign: 'middle' }}>
      <path d="M29.2644 16.2676C27.7767 21.8198 23.8836 23.1677 19.8186 22.0785C15.7536 20.9893 13.056 17.8754 14.5437 12.3232C16.0314 6.77102 21.141 0.882984 25.206 1.9722C29.2711 3.06141 30.7521 10.7154 29.2644 16.2676Z" fill="url(#paint0_linear_2319_11122)" />
      <g filter="url(#filter0_d_2319_11122)">
        <path d="M18.2151 12.6952C19.7028 18.2474 17.0052 21.3613 12.9402 22.4505C8.87519 23.5397 4.98209 22.1918 3.49438 16.6396C2.00667 11.0874 3.48772 3.43342 7.55273 2.34421C11.6177 1.25499 16.7274 7.14303 18.2151 12.6952Z" fill="url(#paint1_linear_2319_11122)" />
      </g>
      <defs>
        <filter id="filter0_d_2319_11122" x="0.929199" y="2.21289" width="23.6997" height="28.5859" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dx="2" dy="4" />
          <feGaussianBlur stdDeviation="2" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.109804 0 0 0 0 0.109804 0 0 0 0 0.109804 0 0 0 0.65 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_2319_11122" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_2319_11122" result="shape" />
        </filter>
        <linearGradient id="paint0_linear_2319_11122" x1="25.206" y1="1.9722" x2="19.8186" y2="22.0785" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="0.175" stopColor="#F2EFEA" />
          <stop offset="1" stopColor="#BDB7AF" />
        </linearGradient>
        <linearGradient id="paint1_linear_2319_11122" x1="7.55273" y1="2.34421" x2="12.9402" y2="22.4505" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="0.175" stopColor="#F2EFEA" />
          <stop offset="1" stopColor="#BDB7AF" />
        </linearGradient>
      </defs>
    </svg>
  );
}
function GitHubIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline', verticalAlign: 'middle', flexShrink: 0 }}>
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function XIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline', verticalAlign: 'middle', flexShrink: 0 }}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function NostrIcon({ size = 16 }) {
  return (
    <img src="https://aqstr.com/nostr-logo.png" width={size} height={size} alt="Nostr" style={{ display: 'inline', verticalAlign: 'middle', flexShrink: 0, objectFit: 'contain' }} />
  );
}

function InstagramIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline', verticalAlign: 'middle', flexShrink: 0 }}>
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  );
}

function YouTubeIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline', verticalAlign: 'middle', flexShrink: 0 }}>
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

function TelegramIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline', verticalAlign: 'middle', flexShrink: 0 }}>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function LinkIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: 'middle', flexShrink: 0 }}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function getIconForLabel(label, size = 28) {
  const l = label.toLowerCase().trim();
  if (l.includes('github'))    return <GitHubIcon size={size} />;
  if (l.includes('nostr'))     return <NostrIcon size={size} />;
  if (l.includes('twitter') || l === 'x') return <XIcon size={size} />;
  if (l.includes('instagram') || l === 'ig') return <InstagramIcon size={size} />;
  if (l.includes('youtube') || l === 'yt') return <YouTubeIcon size={size} />;
  if (l.includes('telegram'))  return <TelegramIcon size={size} />;
  return <LinkIcon size={size} />;
}

const BG = 'linear-gradient(160deg, #0a0f1a 0%, #0d1f2d 50%, #0a0f1a 100%)';

// ── Landing ──────────────────────────────────────────────────────────────────

function Landing({ onStart, hasCard, onSearch }) {
  const features = [
    { icon: '⚡', title: 'Lightning Address', desc: 'Recibí pagos al instante con tu dirección Lightning' },
    { icon: '🪪', title: 'Tarjeta digital', desc: 'Tu identidad Bitcoin en un solo link compartible' },
    { icon: '🔗', title: 'Links & redes', desc: 'GitHub, Nostr, X — todo en un lugar' },
    { icon: '📲', title: 'QR listo', desc: 'Cualquiera te puede pagar escaneando el QR' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#fff', fontFamily: 'system-ui, sans-serif', overflowX: 'hidden' }}>

      {/* Neon grid background */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        backgroundImage: `
          linear-gradient(rgba(0,255,157,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0,255,157,0.03) 1px, transparent 1px)
        `,
        backgroundSize: '60px 60px',
      }} />

      {/* Glow blobs */}
      <div style={{ position: 'fixed', top: '-200px', left: '-200px', width: '600px', height: '600px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(0,255,157,0.06) 0%, transparent 70%)', pointerEvents: 'none', zIndex: 0 }} />
      <div style={{ position: 'fixed', bottom: '-200px', right: '-200px', width: '500px', height: '500px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(247,147,26,0.05) 0%, transparent 70%)', pointerEvents: 'none', zIndex: 0 }} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: '900px', margin: '0 auto', padding: '60px 24px 80px' }}>

        {/* Badge */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '32px' }}>
          <span style={{
            padding: '6px 18px', borderRadius: '20px',
            background: 'rgba(0,255,157,0.08)', border: '1px solid rgba(0,255,157,0.25)',
            fontSize: '0.8rem', color: GREEN, letterSpacing: '1px', fontWeight: '600', textTransform: 'uppercase',
          }}>
            Lightning Hackathon 2026 · La Crypta
          </span>
        </div>

        {/* Hero heading */}
        <h1 style={{
          textAlign: 'center', fontSize: 'clamp(2.2rem, 6vw, 4rem)',
          fontWeight: '800', letterSpacing: '-1.5px', lineHeight: '1.1', margin: '0 0 24px',
        }}>
          Tu tarjeta de presentación{' '}
          <span style={{ color: '#f7931a', textShadow: '0 0 30px rgba(247,147,26,0.5)' }}>Bitcoin</span>
        </h1>

        <p style={{
          textAlign: 'center', fontSize: '1.15rem', color: 'rgba(255,255,255,0.55)',
          maxWidth: '580px', margin: '0 auto 48px', lineHeight: '1.7',
        }}>
          Creá tu propia tarjeta digital con tu Lightning Address, links y bio.
          Compartila, recibí pagos al instante, y representá tu identidad en la red de Bitcoin.
        </p>

        {/* CTA */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', marginBottom: '80px' }}>
          <button
            onClick={onStart}
            style={{
              padding: '18px 48px',
              background: `linear-gradient(135deg, ${GREEN} 0%, #00cc7d 100%)`,
              color: '#000', fontWeight: '800', border: 'none', borderRadius: '16px',
              cursor: 'pointer', fontSize: '1.1rem', letterSpacing: '0.3px',
              boxShadow: `0 8px 40px rgba(0,255,157,0.3)`,
              transition: 'transform 0.15s, box-shadow 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.04)'; e.currentTarget.style.boxShadow = `0 12px 50px rgba(0,255,157,0.45)`; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = `0 8px 40px rgba(0,255,157,0.3)`; }}
          >
            {hasCard ? '⚡ Ver mi tarjeta' : '⚡ Crea tu primera tarjeta'}
          </button>
          <button
            onClick={onSearch}
            style={{
              padding: '12px 28px', background: 'none',
              border: '1px solid rgba(255,255,255,0.15)', borderRadius: '12px',
              color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '0.9rem',
              transition: 'border-color 0.2s, color 0.2s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.35)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; }}
          >
            Buscar tarjeta de alguien
          </button>
        </div>

        {/* Features grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '16px', marginBottom: '80px',
        }}>
          {features.map(f => (
            <div key={f.title} style={{
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: '16px', padding: '24px 20px',
              transition: 'border-color 0.2s',
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(0,255,157,0.2)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'}
            >
              <div style={{ fontSize: '1.8rem', marginBottom: '12px' }}>{f.icon}</div>
              <div style={{ fontWeight: '700', marginBottom: '6px', fontSize: '0.95rem' }}>{f.title}</div>
              <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.85rem', lineHeight: '1.5' }}>{f.desc}</div>
            </div>
          ))}
        </div>

        {/* Preview mockup */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{
            width: '100%', maxWidth: '380px',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '24px', padding: '32px 28px',
            boxShadow: `0 0 80px rgba(0,255,157,0.06)`,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px',
          }}>
            {/* mock avatar */}
            <div style={{
              width: '72px', height: '72px', borderRadius: '50%',
              background: 'linear-gradient(135deg, #00ff9d, #0077ff)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '1.6rem', fontWeight: '700', color: '#000',
              boxShadow: `0 0 24px rgba(0,255,157,0.25)`,
            }}>S</div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: '700', fontSize: '1.3rem' }}>satoshi</div>
              <div style={{ color: GREEN, fontSize: '0.82rem', fontFamily: 'monospace', marginTop: '4px' }}>⚡ satoshi@bitcoin.org</div>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem', textAlign: 'center', lineHeight: '1.5' }}>
              Building a peer-to-peer electronic cash system.
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {['GitHub', 'Nostr', 'X'].map(l => (
                <span key={l} style={{
                  padding: '6px 14px', background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '20px',
                  fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)',
                }}>{l}</span>
              ))}
            </div>
            <div style={{
              width: '100%', height: '1px', background: 'rgba(255,255,255,0.07)',
            }} />
            <div style={{
              width: '100%', padding: '12px', textAlign: 'center',
              background: `linear-gradient(135deg, ${GREEN}, #00cc7d)`,
              borderRadius: '12px', color: '#000', fontWeight: '700', fontSize: '0.9rem',
            }}>⚡ Enviarme sats</div>
            <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.2)' }}>
              Hecho con ⚡ en Lightning Hackathon 2026
            </div>
          </div>
        </div>

        {/* Footer */}
        <p style={{ textAlign: 'center', fontSize: '0.78rem', color: 'rgba(255,255,255,0.2)', marginTop: '60px', marginBottom: '0' }}>
          Hecho con <EggsIcon size={18} /> en Lightning Hackathon 2026
        </p>

      </div>
    </div>
  );
}

// ── Card Form ─────────────────────────────────────────────────────────────────

function CardForm({ onDone, onBack, initialData }) {
  const fileInputRef = useRef(null);
  const [avatarUrl, setAvatarUrl] = useState(initialData?.avatarUrl || '');
  const [bannerUrl, setBannerUrl] = useState(initialData?.bannerUrl || '');
  const [nostrImporting, setNostrImporting] = useState(false);
  const [nostrImportError, setNostrImportError] = useState('');
  const [nostrModal, setNostrModal] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyInputError, setKeyInputError] = useState('');
  const [keyInputLoading, setKeyInputLoading] = useState(false);

  // Detectar callbacks de Amber y Primal al volver a la página
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cleanUrl = window.location.pathname;

    // Amber callback: ?event=<hex_pubkey>
    const amberPubkey = params.get('event');
    if (amberPubkey && amberPubkey.match(/^[0-9a-f]{64}$/i)) {
      window.history.replaceState({}, '', cleanUrl);
      setNostrImporting(true);
      fetchProfileByHexPubkey(amberPubkey)
        .then(profile => applyNostrProfile(profile))
        .catch(err => setNostrImportError(err.message))
        .finally(() => setNostrImporting(false));
      return;
    }

    // Primal / NIP-46 callback: ?nip46_callback=1
    const nip46Callback = params.get('nip46_callback');
    if (nip46Callback && localStorage.getItem('nip46_pending')) {
      window.history.replaceState({}, '', cleanUrl);
      setNostrImporting(true);
      completePrimalConnect()
        .then(hexPubkey => fetchProfileByHexPubkey(hexPubkey))
        .then(profile => applyNostrProfile(profile))
        .catch(err => setNostrImportError(err.message))
        .finally(() => setNostrImporting(false));
    }
  }, []);

  const [form, setForm] = useState({
    name: initialData?.name || '',
    lnAddress: initialData?.lnAddress || '',
    bio: initialData?.bio || '',
    nip05: initialData?.nip05 || '',
    github: initialData?.github || 'https://github.com/',
    nostr: initialData?.nostr || 'https://primal.net/',
    twitter: initialData?.twitter || 'https://x.com/',
    extraLinks: initialData?.extraLinks || [],
    nwcUrl: localStorage.getItem('nwcUrl') || '',
  });
  const [errors, setErrors] = useState({});
  const [step, setStep] = useState(1); // 1: identity, 2: links

  function applyNostrProfile(profile) {
    setAvatarUrl(profile.avatarUrl);
    setBannerUrl(profile.bannerUrl);
    setForm(prev => ({
      ...prev,
      name: profile.name || prev.name,
      bio: profile.bio || prev.bio,
      lnAddress: profile.lnAddress || prev.lnAddress,
      nip05: profile.nip05 || prev.nip05,
      github: profile.github || prev.github,
      twitter: profile.twitter || prev.twitter,
      nostr: profile.nostr || prev.nostr,
      extraLinks: profile.extraLinks.length ? profile.extraLinks : prev.extraLinks,
    }));
  }

  async function handleNostrImport() {
    setNostrImporting(true);
    setNostrImportError('');
    setNostrModal(false);
    try {
      const profile = await fetchOwnNostrProfile();
      applyNostrProfile(profile);
    } catch (err) {
      setNostrImportError(err.message);
    } finally {
      setNostrImporting(false);
    }
  }

  async function handleKeyImport() {
    setKeyInputError('');
    setKeyInputLoading(true);
    try {
      const profile = await fetchProfileByKey(keyInput);
      applyNostrProfile(profile);
      setNostrModal(false);
      setKeyInput('');
    } catch (err) {
      setKeyInputError(err.message);
    } finally {
      setKeyInputLoading(false);
    }
  }

  function handleAmberLogin() {
    // NIP-55 compliant URI — Amber appends the hex pubkey directly at the end of callbackUrl
    const callbackUrl = `${window.location.origin}${window.location.pathname}?event=`;
    const amberUri = `nostrsigner:?compressionType=none&returnType=signature&type=get_public_key&callbackUrl=${encodeURIComponent(callbackUrl)}`;
    window.location.href = amberUri;
  }

  async function handlePrimalLogin() {
    try {
      await initPrimalConnect();
    } catch (err) {
      setNostrImportError(err.message);
    }
  }

  function handleAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    setAvatarUrl(URL.createObjectURL(file));
  }

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: '' }));
  }

  function addExtraLink() {
    setForm(prev => ({ ...prev, extraLinks: [...prev.extraLinks, { label: '', url: '' }] }));
  }

  const BASE_URLS = {
    github: 'https://github.com/',
    nostr: 'https://primal.net/',
    twitter: 'https://x.com/',
    x: 'https://x.com/',
    instagram: 'https://instagram.com/',
    ig: 'https://instagram.com/',
    youtube: 'https://youtube.com/@',
    yt: 'https://youtube.com/@',
    telegram: 'https://t.me/',
  };

  function setExtraLink(index, field, value) {
    setForm(prev => {
      const current = prev.extraLinks[index];
      let updated;
      if (field === 'label') {
        const base = BASE_URLS[value.toLowerCase().trim()];
        // Auto-fill URL only if it's empty or still a known base URL
        const urlIsEmpty = !current.url || Object.values(BASE_URLS).includes(current.url);
        updated = prev.extraLinks.map((l, i) =>
          i === index ? { ...l, label: value, ...(base && urlIsEmpty ? { url: base } : {}) } : l
        );
      } else {
        updated = prev.extraLinks.map((l, i) => i === index ? { ...l, [field]: value } : l);
      }
      return { ...prev, extraLinks: updated };
    });
  }

  function removeExtraLink(index) {
    setForm(prev => ({ ...prev, extraLinks: prev.extraLinks.filter((_, i) => i !== index) }));
  }

  function validateStep1() {
    const errs = {};
    if (!form.name.trim()) errs.name = 'El nombre es obligatorio';
    if (!form.lnAddress.trim()) errs.lnAddress = 'La Lightning Address es obligatoria';
    else if (!form.lnAddress.includes('@')) errs.lnAddress = 'Formato: usuario@dominio.com';
    return errs;
  }

  function handleNext() {
    const errs = validateStep1();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setStep(2);
  }

  function handleSubmit() {
    if (form.nwcUrl) localStorage.setItem('nwcUrl', form.nwcUrl);
    else localStorage.removeItem('nwcUrl');
    onDone({ ...form, avatarUrl, bannerUrl });
  }

  const inputStyle = (err) => ({
    width: '100%', padding: '13px 16px',
    background: 'rgba(255,255,255,0.05)',
    border: `1px solid ${err ? '#ff6b6b' : 'rgba(255,255,255,0.12)'}`,
    borderRadius: '12px', color: '#fff', fontSize: '0.95rem', outline: 'none',
    boxSizing: 'border-box', transition: 'border-color 0.2s',
    fontFamily: 'system-ui, sans-serif',
  });

  const labelStyle = {
    display: 'block', fontSize: '0.82rem', color: 'rgba(255,255,255,0.5)',
    marginBottom: '6px', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.5px',
  };

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#fff', fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px' }}>

      {/* Grid bg */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', backgroundImage: `linear-gradient(rgba(0,255,157,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,157,0.03) 1px, transparent 1px)`, backgroundSize: '60px 60px' }} />

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: '500px' }}>

        {/* Back */}
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', cursor: 'pointer', fontSize: '0.9rem', marginBottom: '24px', padding: '0', display: 'flex', alignItems: 'center', gap: '6px' }}>
          ← Volver
        </button>

        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '28px' }}>
          {[1, 2].map(s => (
            <React.Fragment key={s}>
              <div style={{
                width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.8rem', fontWeight: '700',
                background: step >= s ? GREEN : 'rgba(255,255,255,0.08)',
                color: step >= s ? '#000' : 'rgba(255,255,255,0.3)',
                boxShadow: step >= s ? `0 0 14px rgba(0,255,157,0.4)` : 'none',
                transition: 'all 0.3s',
              }}>{s}</div>
              {s < 2 && <div style={{ flex: 1, height: '1px', background: step > s ? GREEN : 'rgba(255,255,255,0.08)', transition: 'background 0.3s' }} />}
            </React.Fragment>
          ))}
          <span style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.35)', marginLeft: '8px' }}>
            {step === 1 ? 'Identidad' : 'Links'}
          </span>
        </div>

        <div style={{
          background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '24px', padding: '36px 32px',
          boxShadow: `0 0 60px rgba(0,255,157,0.04)`,
        }}>

          {step === 1 && (
            <>
              <h2 style={{ margin: '0 0 8px', fontSize: '1.5rem', fontWeight: '700' }}>Tu identidad</h2>
              <p style={{ margin: '0 0 20px', color: 'rgba(255,255,255,0.4)', fontSize: '0.9rem' }}>
                Esta info aparecerá en tu tarjeta pública.
              </p>

              {/* Nostr import */}
              <div style={{ marginBottom: '24px' }}>
                <button
                  onClick={() => { setNostrModal(true); setNostrImportError(''); setKeyInputError(''); }}
                  disabled={nostrImporting}
                  style={{
                    width: '100%', padding: '13px 16px',
                    background: nostrImporting ? 'rgba(102,36,130,0.08)' : 'rgba(102,36,130,0.12)',
                    border: '1px solid rgba(102,36,130,0.4)',
                    borderRadius: '12px', color: '#c084fc', cursor: nostrImporting ? 'default' : 'pointer',
                    fontSize: '0.95rem', fontWeight: '600',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    transition: 'background 0.2s',
                    opacity: nostrImporting ? 0.7 : 1,
                  }}
                  onMouseEnter={e => { if (!nostrImporting) e.currentTarget.style.background = 'rgba(102,36,130,0.22)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = nostrImporting ? 'rgba(102,36,130,0.08)' : 'rgba(102,36,130,0.12)'; }}
                >
                  <NostrIcon size={18} />
                  {nostrImporting ? 'Importando perfil...' : 'Conectar con Nostr'}
                </button>
                {nostrImportError && (
                  <span style={{ fontSize: '0.78rem', color: '#ff6b6b', marginTop: '6px', display: 'block' }}>
                    {nostrImportError}
                  </span>
                )}
                {!nostrImportError && (
                  <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.25)', marginTop: '6px', display: 'block', textAlign: 'center' }}>
                    Importa foto, banner, bio, Lightning Address y NIP-05 desde tu perfil Nostr
                  </span>
                )}
              </div>

              {/* Modal de login Nostr */}
              {nostrModal && (
                <div
                  onClick={() => setNostrModal(false)}
                  style={{
                    position: 'fixed', inset: 0, zIndex: 1000,
                    background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                    padding: '0 0 0 0',
                  }}
                >
                  <div
                    onClick={e => e.stopPropagation()}
                    style={{
                      width: '100%', maxWidth: '480px',
                      background: '#111827',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '24px 24px 0 0',
                      padding: '28px 24px 36px',
                      boxShadow: '0 -8px 40px rgba(0,0,0,0.5)',
                    }}
                  >
                    {/* Handle bar */}
                    <div style={{ width: '36px', height: '4px', background: 'rgba(255,255,255,0.15)', borderRadius: '2px', margin: '0 auto 24px' }} />

                    <h3 style={{ margin: '0 0 6px', fontSize: '1.2rem', fontWeight: '700', textAlign: 'center' }}>
                      <NostrIcon size={16} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
                      Conectar con Nostr
                    </h3>
                    <p style={{ margin: '0 0 24px', color: 'rgba(255,255,255,0.35)', fontSize: '0.82rem', textAlign: 'center' }}>
                      Elegí cómo importar tu perfil
                    </p>

                    {/* Opción 1: Extensión */}
                    <button
                      onClick={handleNostrImport}
                      style={{
                        width: '100%', padding: '14px 16px', marginBottom: '10px',
                        background: 'rgba(102,36,130,0.15)', border: '1px solid rgba(102,36,130,0.35)',
                        borderRadius: '14px', color: '#c084fc', cursor: 'pointer',
                        fontSize: '0.95rem', fontWeight: '600',
                        display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: '1.4rem' }}>🧩</span>
                      <div>
                        <div>Extensión del navegador</div>
                        <div style={{ fontSize: '0.75rem', fontWeight: '400', color: 'rgba(192,132,252,0.6)', marginTop: '2px' }}>
                          Alby, nos2x, Blockcore — solo desktop
                        </div>
                      </div>
                    </button>

                    {/* Opción 2: Amber */}
                    <button
                      onClick={handleAmberLogin}
                      style={{
                        width: '100%', padding: '14px 16px', marginBottom: '10px',
                        background: 'rgba(247,147,26,0.08)', border: '1px solid rgba(247,147,26,0.3)',
                        borderRadius: '14px', color: '#f7931a', cursor: 'pointer',
                        fontSize: '0.95rem', fontWeight: '600',
                        display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: '1.4rem' }}>🟠</span>
                      <div>
                        <div>Amber</div>
                        <div style={{ fontSize: '0.75rem', fontWeight: '400', color: 'rgba(247,147,26,0.6)', marginTop: '2px' }}>
                          Signer nativo para Android — abre Amber, aprobás y volvés
                        </div>
                      </div>
                    </button>

                    {/* Opción 3: Primal */}
                    <button
                      onClick={handlePrimalLogin}
                      style={{
                        width: '100%', padding: '14px 16px', marginBottom: '4px',
                        background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)',
                        borderRadius: '14px', color: '#a78bfa', cursor: 'pointer',
                        fontSize: '0.95rem', fontWeight: '600',
                        display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: '1.4rem' }}>⚡</span>
                      <div>
                        <div>Primal</div>
                        <div style={{ fontSize: '0.75rem', fontWeight: '400', color: 'rgba(167,139,250,0.6)', marginTop: '2px' }}>
                          iOS y Android — abre Primal, aprobás y volvés
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px', opacity: 0.3 }}>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.15)' }} />
                <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>o completá manualmente</span>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.15)' }} />
              </div>

              {/* Avatar */}
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '28px' }}>
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <div
                    onClick={() => fileInputRef.current.click()}
                    style={{
                      width: '88px', height: '88px', borderRadius: '50%', cursor: 'pointer',
                      background: avatarUrl ? 'transparent' : 'linear-gradient(135deg, #00ff9d, #0077ff)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '1.8rem', fontWeight: '700', color: '#000',
                      boxShadow: `0 0 24px rgba(0,255,157,0.2)`,
                      border: `2px dashed ${avatarUrl ? 'transparent' : 'rgba(0,255,157,0.3)'}`,
                      overflow: 'hidden',
                    }}
                  >
                    {avatarUrl
                      ? <img src={avatarUrl} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : '+'
                    }
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarChange} />
                  <span style={{ display: 'block', textAlign: 'center', fontSize: '0.72rem', color: 'rgba(255,255,255,0.3)', marginTop: '6px' }}>Foto (opcional)</span>
                </div>
              </div>

              {/* Name */}
              <div style={{ marginBottom: '20px' }}>
                <label style={labelStyle}>Nombre / alias</label>
                <input
                  style={inputStyle(errors.name)}
                  placeholder="satoshi"
                  value={form.name}
                  onChange={e => set('name', e.target.value)}
                  onFocus={e => e.target.style.borderColor = GREEN}
                  onBlur={e => e.target.style.borderColor = errors.name ? '#ff6b6b' : 'rgba(255,255,255,0.12)'}
                />
                {errors.name && <span style={{ fontSize: '0.78rem', color: '#ff6b6b', marginTop: '4px', display: 'block' }}>{errors.name}</span>}
              </div>

              {/* Lightning Address */}
              <div style={{ marginBottom: '20px' }}>
                <label style={labelStyle}>Lightning Address ⚡</label>
                <input
                  style={inputStyle(errors.lnAddress)}
                  placeholder="vos@getalby.com"
                  value={form.lnAddress}
                  onChange={e => set('lnAddress', e.target.value)}
                  onFocus={e => e.target.style.borderColor = GREEN}
                  onBlur={e => e.target.style.borderColor = errors.lnAddress ? '#ff6b6b' : 'rgba(255,255,255,0.12)'}
                />
                {errors.lnAddress
                  ? <span style={{ fontSize: '0.78rem', color: '#ff6b6b', marginTop: '4px', display: 'block' }}>{errors.lnAddress}</span>
                  : <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.3)', marginTop: '4px', display: 'block' }}>Podés obtener una gratis en getalby.com</span>
                }
              </div>

              {/* Bio */}
              <div style={{ marginBottom: '20px' }}>
                <label style={labelStyle}>Bio <span style={{ color: 'rgba(255,255,255,0.25)' }}>(opcional)</span></label>
                <textarea
                  style={{ ...inputStyle(false), resize: 'none', height: '80px', lineHeight: '1.5' }}
                  placeholder="Building on Lightning Network..."
                  value={form.bio}
                  onChange={e => set('bio', e.target.value)}
                  onFocus={e => e.target.style.borderColor = GREEN}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                />
              </div>

              {/* NIP-05 */}
              <div style={{ marginBottom: '32px' }}>
                <label style={labelStyle}>NIP-05 <span style={{ color: 'rgba(255,255,255,0.25)' }}>(opcional)</span></label>
                <input
                  style={inputStyle(false)}
                  placeholder="usuario@dominio.com"
                  value={form.nip05}
                  onChange={e => set('nip05', e.target.value)}
                  onFocus={e => e.target.style.borderColor = GREEN}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                />
                <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.25)', marginTop: '4px', display: 'block' }}>
                  Identificador verificado de Nostr
                </span>
              </div>

              <button
                onClick={handleNext}
                style={{
                  width: '100%', padding: '15px',
                  background: `linear-gradient(135deg, ${GREEN}, #00cc7d)`,
                  color: '#000', fontWeight: '700', border: 'none', borderRadius: '12px',
                  cursor: 'pointer', fontSize: '1rem',
                }}
              >
                Siguiente →
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <h2 style={{ margin: '0 0 8px', fontSize: '1.5rem', fontWeight: '700' }}>Tus links</h2>
              <p style={{ margin: '0 0 28px', color: 'rgba(255,255,255,0.4)', fontSize: '0.9rem' }}>
                Todo es opcional. Solo agrega lo que uses.
              </p>

              {[
                { field: 'github', label: 'GitHub', placeholder: 'https://github.com/usuario', icon: <GitHubIcon size={25} /> },
                { field: 'nostr', label: 'Nostr', placeholder: 'https://primal.net/usuario', icon: <NostrIcon size={25} /> },
                { field: 'twitter', label: 'X / Twitter', placeholder: 'https://x.com/usuario', icon: <XIcon size={25} /> },
              ].map(({ field, label, placeholder, icon }) => (
                <div key={field} style={{ marginBottom: '18px' }}>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '5px' }}>{icon} {label}</label>
                  <input
                    style={inputStyle(false)}
                    placeholder={placeholder}
                    value={form[field]}
                    onChange={e => set(field, e.target.value)}
                    onFocus={e => e.target.style.borderColor = GREEN}
                    onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                  />
                </div>
              ))}

              {/* Extra links */}
              {form.extraLinks.map((link, i) => (
                <div key={i} style={{ marginBottom: '18px' }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                    <label style={{ ...labelStyle, marginBottom: 0, flex: 1, display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {getIconForLabel(link.label, 18)} Link extra {i + 1}
                    </label>
                    <button
                      onClick={() => removeExtraLink(i)}
                      style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1, padding: '0 4px' }}
                      title="Eliminar"
                    >×</button>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      style={{ ...inputStyle(false), width: '36%' }}
                      placeholder="Nombre"
                      value={link.label}
                      onChange={e => setExtraLink(i, 'label', e.target.value)}
                      onFocus={e => e.target.style.borderColor = GREEN}
                      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                    />
                    <input
                      style={{ ...inputStyle(false), flex: 1 }}
                      placeholder="https://..."
                      value={link.url}
                      onChange={e => setExtraLink(i, 'url', e.target.value)}
                      onFocus={e => e.target.style.borderColor = GREEN}
                      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                    />
                  </div>
                </div>
              ))}

              {/* Add link button */}
              <button
                onClick={addExtraLink}
                style={{
                  width: '100%', padding: '11px',
                  background: 'rgba(0,255,157,0.06)', border: '1px dashed rgba(0,255,157,0.3)',
                  borderRadius: '12px', color: GREEN, cursor: 'pointer', fontSize: '0.9rem',
                  fontWeight: '600', marginBottom: '8px',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,255,157,0.1)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,255,157,0.06)'}
              >
                + Agregar otro link
              </button>

              {/* NWC */}
              <div style={{ marginTop: '8px', marginBottom: '8px', padding: '16px', background: 'rgba(247,147,26,0.05)', border: '1px solid rgba(247,147,26,0.15)', borderRadius: '12px' }}>
                <label style={{ ...labelStyle, color: '#f7931a' }}>⚡ NWC — Nostr Wallet Connect <span style={{ color: 'rgba(255,255,255,0.25)', textTransform: 'none', fontWeight: 400 }}>(opcional)</span></label>
                <input
                  style={{ ...inputStyle(false), borderColor: form.nwcUrl ? 'rgba(247,147,26,0.4)' : 'rgba(255,255,255,0.12)' }}
                  placeholder="nostr+walletconnect://..."
                  value={form.nwcUrl}
                  onChange={e => set('nwcUrl', e.target.value)}
                  onFocus={e => e.target.style.borderColor = '#f7931a'}
                  onBlur={e => e.target.style.borderColor = form.nwcUrl ? 'rgba(247,147,26,0.4)' : 'rgba(255,255,255,0.12)'}
                />
                <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', marginTop: '6px', display: 'block' }}>
                  Conectá tu wallet para generar invoices. Se guarda solo en tu browser, nunca se publica.
                </span>
              </div>

              <div style={{ marginTop: '32px', display: 'flex', gap: '12px' }}>
                <button
                  onClick={() => setStep(1)}
                  style={{
                    flex: '0 0 auto', padding: '15px 20px',
                    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                    color: '#fff', borderRadius: '12px', cursor: 'pointer', fontSize: '0.95rem',
                  }}
                >
                  ←
                </button>
                <button
                  onClick={handleSubmit}
                  style={{
                    flex: 1, padding: '15px',
                    background: `linear-gradient(135deg, ${GREEN}, #00cc7d)`,
                    color: '#000', fontWeight: '700', border: 'none', borderRadius: '12px',
                    cursor: 'pointer', fontSize: '1rem',
                  }}
                >
                  Ver mi tarjeta ✨
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Search View ───────────────────────────────────────────────────────────────

function SearchView({ onCardFound, onBack }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSearch() {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    try {
      let card;
      if (q.startsWith('npub1') || q.startsWith('nostr:npub1')) {
        const npub = q.replace('nostr:', '');
        card = await fetchFromNostr(npub);
        if (!card) throw new Error('No se encontró tarjeta para ese npub');
      } else if (q.includes('@')) {
        // Lightning Address — intentar obtener perfil Nostr via LNURL metadata
        const ln = new LightningAddress(q);
        await ln.fetch();
        let nostrCard = null;
        if (ln.lnurlData?.allowsNostr && ln.lnurlData?.nostrPubkey) {
          try {
            const ndk = await getNDK();
            const user = ndk.getUser({ pubkey: ln.lnurlData.nostrPubkey });
            nostrCard = await fetchFromNostr(user.npub);
          } catch {}
        }
        card = nostrCard || {
          name: q.split('@')[0],
          lnAddress: q,
          bio: '',
          avatarUrl: '',
          github: '', nostr: '', twitter: '',
          extraLinks: [],
          readonly: true,
        };
      } else {
        throw new Error('Ingresá un npub (npub1...) o una Lightning Address (usuario@dominio.com)');
      }
      onCardFound(card);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#fff', fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px' }}>

      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', backgroundImage: `linear-gradient(rgba(0,255,157,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,157,0.03) 1px, transparent 1px)`, backgroundSize: '60px 60px' }} />

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: '500px' }}>

        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', cursor: 'pointer', fontSize: '0.9rem', marginBottom: '32px', padding: '0' }}>
          ← Volver
        </button>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '24px', padding: '36px 32px' }}>

          <h2 style={{ margin: '0 0 8px', fontSize: '1.5rem', fontWeight: '700' }}>Buscar tarjeta</h2>
          <p style={{ margin: '0 0 28px', color: 'rgba(255,255,255,0.4)', fontSize: '0.9rem' }}>
            Ingresá un npub de Nostr o una Lightning Address.
          </p>

          <input
            style={{
              width: '100%', padding: '14px 16px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '12px', color: '#fff', fontSize: '0.95rem', outline: 'none',
              boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif',
            }}
            placeholder="npub1... o usuario@dominio.com"
            value={query}
            onChange={e => { setQuery(e.target.value); setError(''); }}
            onFocus={e => e.target.style.borderColor = GREEN}
            onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            autoFocus
          />

          {error && (
            <p style={{ fontSize: '0.83rem', color: '#ff6b6b', marginTop: '10px', marginBottom: 0 }}>{error}</p>
          )}

          <button
            onClick={handleSearch}
            disabled={loading || !query.trim()}
            style={{
              width: '100%', marginTop: '16px', padding: '15px',
              background: loading || !query.trim() ? 'rgba(0,255,157,0.3)' : `linear-gradient(135deg, ${GREEN}, #00cc7d)`,
              color: '#000', fontWeight: '700', border: 'none', borderRadius: '12px',
              cursor: loading || !query.trim() ? 'not-allowed' : 'pointer', fontSize: '1rem',
            }}
          >
            {loading ? 'Buscando...' : 'Ver tarjeta'}
          </button>

          <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px' }}>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.3)', margin: '0 0 6px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Ejemplos</p>
            <p style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.25)', margin: 0, fontFamily: 'monospace', lineHeight: '1.8' }}>
              npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f79ka9s9suf23v3<br />
              satoshi@getalby.com
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}

// ── Card View ─────────────────────────────────────────────────────────────────

function CardView({ data, onEdit, onBack, onSearch, onHome }) {
  const [showPayment, setShowPayment] = useState(false);
  const [selectedSats, setSelectedSats] = useState(21);
  const [customSats, setCustomSats] = useState('');
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState({ msg: '', type: '' });
  const [copied, setCopied] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const PRESETS = [21, 100, 500, 1000];
  const satsAmount = customSats ? parseInt(customSats) : selectedSats;

  const BASE_URLS_SET = new Set(['https://github.com/', 'https://primal.net/', 'https://x.com/', 'https://instagram.com/', 'https://youtube.com/@', 'https://t.me/']);
  const hasContent = (url) => url && !BASE_URLS_SET.has(url);

  const links = [
    hasContent(data.github) && { label: 'GitHub', url: data.github, icon: <GitHubIcon size={25} /> },
    hasContent(data.nostr) && { label: 'Nostr', url: data.nostr, icon: <NostrIcon size={25} /> },
    hasContent(data.twitter) && { label: 'X', url: data.twitter, icon: <XIcon size={25} /> },
    ...(data.extraLinks || []).filter(l => l.label && l.url).map(l => ({ label: l.label, url: l.url, icon: getIconForLabel(l.label, 28) })),
  ].filter(Boolean);

  const initials = data.name ? data.name.charAt(0).toUpperCase() : '?';

  async function generateInvoice() {
    if (!satsAmount || satsAmount < 1) { setStatus({ msg: 'Ingresa una cantidad valida', type: 'error' }); return; }
    setLoading(true);
    setStatus({ msg: 'Generando invoice...', type: 'info' });
    setInvoice(null);
    try {
      const ln = new LightningAddress(data.lnAddress);
      await ln.fetch();
      const inv = await ln.requestInvoice({ satoshi: satsAmount });
      setInvoice(inv.paymentRequest);
      setStatus({ msg: '', type: '' });
    } catch (err) {
      setStatus({ msg: 'Error: ' + err.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  async function payWithWebLN() {
    if (!invoice) return;
    try {
      setStatus({ msg: 'Abriendo wallet...', type: 'info' });
      if (!window.webln) throw new Error('No se detectó wallet WebLN. Instalá Alby.');
      await window.webln.enable();
      await window.webln.sendPayment(invoice);
      setStatus({ msg: 'Pago enviado! Gracias!', type: 'success' });
      setInvoice(null);
      setTimeout(() => { setShowPayment(false); setStatus({ msg: '', type: '' }); }, 2500);
    } catch (err) {
      setStatus({ msg: err.message, type: 'error' });
    }
  }

  async function payWithNFC() {
    if (!invoice) return;
    if (!('NDEFReader' in window)) {
      setStatus({ msg: 'NFC no disponible en este dispositivo o browser. Usá Chrome en Android.', type: 'error' });
      return;
    }
    try {
      setStatus({ msg: 'Acercá el dispositivo NFC...', type: 'info' });
      const ndef = new NDEFReader();
      await ndef.write({ records: [{ recordType: 'url', data: `lightning:${invoice}` }] });
      setStatus({ msg: 'Invoice enviado por NFC!', type: 'success' });
    } catch (err) {
      setStatus({ msg: 'Error NFC: ' + err.message, type: 'error' });
    }
  }

  async function payWithNWC() {
    if (!invoice) return;
    const nwcUrl = localStorage.getItem('nwcUrl');
    if (!nwcUrl) { setStatus({ msg: 'No tenés NWC configurado. Editá tu tarjeta para agregarlo.', type: 'error' }); return; }
    try {
      setStatus({ msg: 'Pagando con NWC...', type: 'info' });
      const client = new nwc.NWCClient({ nostrWalletConnectUrl: nwcUrl });
      await client.payInvoice({ invoice });
      setStatus({ msg: 'Pago enviado con NWC!', type: 'success' });
      setInvoice(null);
      setTimeout(() => { setShowPayment(false); setStatus({ msg: '', type: '' }); }, 2500);
    } catch (err) {
      setStatus({ msg: 'Error NWC: ' + err.message, type: 'error' });
    }
  }

  function copyInvoice() {
    navigator.clipboard.writeText(invoice);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function reset() {
    setShowPayment(false);
    setInvoice(null);
    setStatus({ msg: '', type: '' });
    setCustomSats('');
    setSelectedSats(21);
  }

  function getShareUrl() {
    const shareData = { ...data };
    delete shareData.nwcUrl;
    delete shareData.readonly;
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(shareData))));
    return `${window.location.origin}${window.location.pathname}?card=${encoded}`;
  }

  function copyShareLink() {
    navigator.clipboard.writeText(getShareUrl());
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  return (
    <div style={{ minHeight: '100vh', background: BG, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 16px', fontFamily: 'system-ui, sans-serif', color: '#fff' }}>

      {/* Grid bg */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', backgroundImage: `linear-gradient(rgba(0,255,157,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,157,0.03) 1px, transparent 1px)`, backgroundSize: '60px 60px' }} />
      <div style={{ position: 'fixed', top: '-200px', left: '-200px', width: '600px', height: '600px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(0,255,157,0.06) 0%, transparent 70%)', pointerEvents: 'none' }} />

      {/* Home button */}
      <button
        onClick={onHome}
        style={{
          position: 'fixed', top: '20px', left: '20px', zIndex: 10,
          padding: '8px 14px', background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px',
          color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.85rem',
        }}
      >
        ⚡ Inicio
      </button>

      {/* Edit button */}
      {onEdit && (
        <button
          onClick={onEdit}
          style={{
            position: 'fixed', top: '20px', right: '20px', zIndex: 10,
            padding: '8px 16px', background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px',
            color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.85rem',
          }}
        >
          Editar tarjeta
        </button>
      )}

      {/* Back button */}
      {onBack && (
        <button
          onClick={onBack}
          style={{
            background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)',
            cursor: 'pointer', fontSize: '0.9rem', marginBottom: '12px', padding: 0,
            position: 'relative', zIndex: 1,
            maxWidth: '420px', width: '100%', textAlign: 'center',
          }}
        >
          ← Volver
        </button>
      )}

      {/* Card */}
      <div style={{
        position: 'relative', zIndex: 1,
        width: '100%', maxWidth: '420px',
        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '24px', overflow: 'hidden',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        boxShadow: `0 0 60px rgba(0,255,157,0.06)`,
      }}>

        {/* Banner */}
        {data.bannerUrl ? (
          <div style={{ width: '100%', height: '130px', position: 'relative', flexShrink: 0 }}>
            <img src={data.bannerUrl} alt="banner" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent 50%, rgba(10,15,26,0.85))' }} />
          </div>
        ) : null}

        {/* Inner content */}
        <div style={{
          position: 'relative', zIndex: 1,
          width: '100%', boxSizing: 'border-box',
          padding: data.bannerUrl ? '0 32px 40px' : '40px 32px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '24px',
        }}>

        {/* Avatar */}
        <div style={{
          width: '96px', height: '96px', borderRadius: '50%',
          background: 'linear-gradient(135deg, #00ff9d, #0077ff)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '2.2rem', fontWeight: '700', color: '#000',
          boxShadow: `0 0 30px rgba(0,255,157,0.3)`,
          overflow: 'hidden', flexShrink: 0,
          marginTop: data.bannerUrl ? '-20px' : '0',
          border: data.bannerUrl ? '3px solid #0d1420' : 'none',
        }}>
          {data.avatarUrl
            ? <img src={data.avatarUrl} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : initials
          }
        </div>

        {/* Name + LN Address + NIP-05 */}
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <h1 style={{ fontSize: '1.8rem', fontWeight: '700', letterSpacing: '-0.5px', margin: '0' }}>{data.name}</h1>
          {data.nip05 && (
            <span style={{ fontSize: '0.78rem', color: '#a78bfa', fontFamily: 'monospace', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              {data.nip05}
            </span>
          )}
          <span style={{ fontSize: '0.9rem', color: GREEN, opacity: 0.85, fontFamily: 'monospace' }}>⚡ {data.lnAddress}</span>
        </div>

        {/* Bio */}
        {data.bio && (
          <p style={{ fontSize: '0.95rem', color: 'rgba(255,255,255,0.55)', textAlign: 'center', lineHeight: '1.6', margin: '0 4px' }}>
            {data.bio}
          </p>
        )}

        {/* Links */}
        {links.length > 0 && (
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {links.map(link => (
              <a key={link.label} href={link.url} target="_blank" rel="noopener noreferrer" style={{
                padding: '8px 16px', background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: '20px',
                color: '#fff', textDecoration: 'none', fontSize: '0.85rem',
                display: 'flex', alignItems: 'center', gap: '6px',
              }}>
                {link.icon} {link.label}
              </a>
            ))}
          </div>
        )}

        <div style={{ width: '100%', height: '1px', background: 'rgba(255,255,255,0.07)' }} />

        {/* Payment section */}
        {!showPayment ? (
          <button
            style={{
              width: '100%', padding: '16px',
              background: `linear-gradient(135deg, ${GREEN} 0%, #00cc7d 100%)`,
              color: '#000', fontWeight: '700', border: 'none', borderRadius: '14px',
              cursor: 'pointer', fontSize: '1rem',
              boxShadow: `0 4px 20px rgba(0,255,157,0.2)`,
              transition: 'transform 0.15s, box-shadow 0.15s',
            }}
            onClick={() => setShowPayment(true)}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.02)'; e.currentTarget.style.boxShadow = `0 6px 28px rgba(0,255,157,0.35)`; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = `0 4px 20px rgba(0,255,157,0.2)`; }}
          >
            ⚡ Enviarme sats
          </button>
        ) : (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {!invoice && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                  {PRESETS.map(s => (
                    <button key={s}
                      style={{
                        padding: '10px 0',
                        background: (!customSats && selectedSats === s) ? 'rgba(0,255,157,0.15)' : 'rgba(255,255,255,0.05)',
                        border: `1px solid ${(!customSats && selectedSats === s) ? GREEN : 'rgba(255,255,255,0.1)'}`,
                        borderRadius: '10px',
                        color: (!customSats && selectedSats === s) ? GREEN : 'rgba(255,255,255,0.7)',
                        cursor: 'pointer', fontSize: '0.85rem',
                        fontWeight: (!customSats && selectedSats === s) ? '600' : '400',
                      }}
                      onClick={() => { setSelectedSats(s); setCustomSats(''); }}
                    >{s}</button>
                  ))}
                </div>

                <input
                  style={{ width: '100%', padding: '12px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px', color: '#fff', fontSize: '0.95rem', outline: 'none', boxSizing: 'border-box' }}
                  type="number"
                  placeholder="Otro monto en sats..."
                  value={customSats}
                  onChange={e => setCustomSats(e.target.value)}
                />

                <button
                  style={{
                    width: '100%', padding: '16px',
                    background: `linear-gradient(135deg, ${GREEN}, #00cc7d)`,
                    color: '#000', fontWeight: '700', border: 'none', borderRadius: '14px',
                    cursor: 'pointer', fontSize: '1rem', opacity: loading ? 0.6 : 1,
                  }}
                  onClick={generateInvoice}
                  disabled={loading}
                >
                  {loading ? 'Generando...' : `Generar invoice por ${satsAmount} sats`}
                </button>
              </>
            )}

            {invoice && (
              <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(0,255,157,0.2)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                <QRCodeSVG value={invoice} size={200} bgColor="transparent" fgColor="#ffffff" level="M" />
                <p style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', wordBreak: 'break-all', textAlign: 'center', maxHeight: '60px', overflow: 'hidden', margin: 0 }}>{invoice}</p>
                <button style={{ padding: '8px 20px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontSize: '0.85rem' }} onClick={copyInvoice}>
                  {copied ? 'Copiado!' : 'Copiar invoice'}
                </button>
                <button style={{ width: '100%', padding: '14px', background: '#f7931a', color: '#000', fontWeight: '700', border: 'none', borderRadius: '12px', cursor: 'pointer', fontSize: '0.95rem' }} onClick={payWithWebLN}>
                  Pagar con wallet (WebLN)
                </button>
                {localStorage.getItem('nwcUrl') && (
                  <button style={{ width: '100%', padding: '14px', background: 'rgba(247,147,26,0.12)', border: '1px solid rgba(247,147,26,0.4)', color: '#f7931a', fontWeight: '700', borderRadius: '12px', cursor: 'pointer', fontSize: '0.95rem' }} onClick={payWithNWC}>
                    Pagar con NWC
                  </button>
                )}
                {'NDEFReader' in window && (
                  <button style={{ width: '100%', padding: '14px', background: 'rgba(0,255,157,0.08)', border: '1px solid rgba(0,255,157,0.3)', color: GREEN, fontWeight: '700', borderRadius: '12px', cursor: 'pointer', fontSize: '0.95rem' }} onClick={payWithNFC}>
                    Pagar con NFC
                  </button>
                )}
              </div>
            )}

            {status.msg && (
              <p style={{ fontSize: '0.85rem', color: status.type === 'success' ? GREEN : status.type === 'error' ? '#ff6b6b' : 'rgba(255,255,255,0.5)', textAlign: 'center', margin: 0 }}>{status.msg}</p>
            )}

            <button onClick={reset} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '0.85rem', textAlign: 'center' }}>
              Cancelar
            </button>
          </div>
        )}

        {/* Share button */}
        <button
          onClick={() => setShowShare(true)}
          style={{
            width: '100%', padding: '12px',
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '12px', color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
            fontSize: '0.9rem', fontWeight: '600',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.09)'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          Compartir tarjeta
        </button>

        {onSearch && (
          <button
            onClick={onSearch}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '0.82rem', padding: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = 'rgba(255,255,255,0.6)'}
            onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.3)'}
          >
            Buscar tarjeta de alguien →
          </button>
        )}

        <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.2)', textAlign: 'center', margin: 0 }}>
          Hecho con ⚡ para Lightning Hackathon 2026 · La Crypta
        </p>

        </div>{/* /Inner content */}
      </div>{/* /Card */}

      {/* Share modal */}
      {showShare && (() => {
        const url = getShareUrl();
        const text = `Mi tarjeta Bitcoin ⚡ ${data.name}`;
        return (
          <div
            onClick={() => setShowShare(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 50,
              background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              padding: '0 16px 24px',
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                width: '100%', maxWidth: '420px',
                background: '#0d1420', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '24px', padding: '28px 24px',
                display: 'flex', flexDirection: 'column', gap: '16px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: '700', fontSize: '1rem' }}>Compartir tarjeta</span>
                <button onClick={() => setShowShare(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1.3rem', lineHeight: 1 }}>×</button>
              </div>

              {/* Link */}
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  readOnly
                  value={url}
                  style={{
                    flex: 1, padding: '10px 12px',
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '10px', color: 'rgba(255,255,255,0.5)',
                    fontSize: '0.72rem', fontFamily: 'monospace', outline: 'none',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                />
                <button
                  onClick={copyShareLink}
                  style={{
                    padding: '10px 16px', borderRadius: '10px', cursor: 'pointer',
                    background: linkCopied ? 'rgba(0,255,157,0.15)' : 'rgba(255,255,255,0.08)',
                    border: `1px solid ${linkCopied ? 'rgba(0,255,157,0.4)' : 'rgba(255,255,255,0.15)'}`,
                    color: linkCopied ? GREEN : '#fff', fontSize: '0.85rem', fontWeight: '600',
                    whiteSpace: 'nowrap', transition: 'all 0.2s',
                  }}
                >
                  {linkCopied ? 'Copiado!' : 'Copiar'}
                </button>
              </div>

              {/* Social share buttons */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                {[
                  { label: 'WhatsApp', color: '#25d366', bg: 'rgba(37,211,102,0.1)', border: 'rgba(37,211,102,0.3)', href: `https://wa.me/?text=${encodeURIComponent(text + '\n' + url)}` },
                  { label: 'X / Twitter', color: '#fff', bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.15)', href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}` },
                  { label: 'Telegram', color: '#29b6f6', bg: 'rgba(41,182,246,0.1)', border: 'rgba(41,182,246,0.3)', href: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}` },
                ].map(s => (
                  <a
                    key={s.label}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
                      padding: '14px 8px', borderRadius: '14px', textDecoration: 'none',
                      background: s.bg, border: `1px solid ${s.border}`,
                      color: s.color, fontSize: '0.78rem', fontWeight: '600',
                      transition: 'opacity 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '0.8'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                  >
                    {s.label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
