const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const headers = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates',
};

/**
 * Devuelve la clave única del usuario: lightning address o npub.
 * Retorna null si no hay ninguna.
 */
export function getStorageKey(cardData) {
  if (cardData?.npub) return cardData.npub;
  if (cardData?.lnAddress) return cardData.lnAddress.toLowerCase();
  if (cardData?.lightningAddress) return cardData.lightningAddress.toLowerCase();
  return null;
}

/**
 * Guarda la tarjeta en Supabase (upsert).
 */
export async function saveCardRemote(cardData) {
  const id = getStorageKey(cardData);
  if (!id) return;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/cards`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, data: cardData, updated_at: new Date().toISOString() }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
}

/**
 * Carga la tarjeta desde Supabase por clave (lightning address o npub).
 * Retorna null si no existe.
 */
export async function loadCardRemote(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/cards?id=eq.${encodeURIComponent(id)}&select=data`,
    { headers }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.data ?? null;
}
