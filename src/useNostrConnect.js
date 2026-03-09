// NIP-46 Remote Signer Hook — Primal, Amber, nsec.app, etc.
import { useCallback, useEffect, useRef, useState } from 'react';

const NIP46_RELAYS = ['wss://relay.primal.net', 'wss://nos.lol'];
const POLL_INTERVAL_MS = 2000;

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function useNostrConnect() {
  const [state, setState] = useState({
    uri: null,
    isWaiting: false,
    connected: false,
    remotePubkey: null,
  });

  // Persistent SimplePool — not recreated between polls
  const poolRef = useRef(null);
  const clientSecretKey = useRef(null);   // Uint8Array
  const clientPubkey = useRef(null);      // hex string
  const sessionSecret = useRef(null);     // hex string
  const connectedRef = useRef(false);
  const pendingGpkIdRef = useRef(null);   // id of pending get_public_key request
  const listenStartedAt = useRef(0);
  const pollIntervalRef = useRef(null);

  async function getPool() {
    if (!poolRef.current) {
      const { SimplePool } = await import('nostr-tools');
      poolRef.current = new SimplePool();
    }
    return poolRef.current;
  }

  const stopPolling = useCallback(() => {
    clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = null;
  }, []);

  const processEvent = useCallback(async (event) => {
    const secretBytes = clientSecretKey.current;
    const secret = sessionSecret.current;
    if (!secretBytes || !secret) return false;

    const signerPubkey = event.pubkey;
    const pool = await getPool();

    // Decrypt with NIP-44
    let message;
    try {
      const { nip44 } = await import('nostr-tools');
      const convoKey = nip44.v2.utils.getConversationKey(secretBytes, signerPubkey);
      message = JSON.parse(nip44.v2.decrypt(event.content, convoKey));
    } catch {
      return false; // can't decrypt — skip
    }

    // Helper to encrypt and publish a response
    const publishReply = async (payload) => {
      const { nip44 } = await import('nostr-tools');
      const { finalizeEvent } = await import('nostr-tools/pure');
      const convoKey = nip44.v2.utils.getConversationKey(secretBytes, signerPubkey);
      const ev = finalizeEvent({
        kind: 24133,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', signerPubkey]],
        content: nip44.v2.encrypt(JSON.stringify(payload), convoKey),
      }, secretBytes);
      await Promise.allSettled(pool.publish(NIP46_RELAYS, ev));
    };

    // Format A: signer sends { method: "connect" } — ACK + get_public_key
    if (message.method === 'connect') {
      await publishReply({ id: message.id, result: secret, error: null });
      const gpkId = toHex(crypto.getRandomValues(new Uint8Array(8)));
      pendingGpkIdRef.current = gpkId;
      await publishReply({ id: gpkId, method: 'get_public_key', params: [] });
      return false; // wait for get_public_key response
    }

    // get_public_key response
    if (
      pendingGpkIdRef.current &&
      message.id === pendingGpkIdRef.current &&
      typeof message.result === 'string' &&
      /^[0-9a-f]{64}$/i.test(message.result)
    ) {
      connectedRef.current = true;
      stopPolling();
      setState(prev => ({ ...prev, connected: true, remotePubkey: message.result, isWaiting: false }));
      return true;
    }

    // Format B (Primal): signer sends { result: secret } — request get_public_key
    if (
      typeof message.result === 'string' &&
      message.result === secret &&
      !pendingGpkIdRef.current
    ) {
      const gpkId = toHex(crypto.getRandomValues(new Uint8Array(8)));
      pendingGpkIdRef.current = gpkId;
      await publishReply({ id: gpkId, method: 'get_public_key', params: [] });
      return false;
    }

    return false;
  }, [stopPolling]);

  const pollOnce = useCallback(async () => {
    if (connectedRef.current) { stopPolling(); return; }
    const pubkey = clientPubkey.current;
    if (!pubkey) return;

    try {
      const pool = await getPool();
      const events = await pool.querySync(NIP46_RELAYS, {
        kinds: [24133],
        '#p': [pubkey],
        since: listenStartedAt.current - 5,
      });
      for (const event of events) {
        if (connectedRef.current) return;
        const ok = await processEvent(event);
        if (ok) return;
      }
    } catch { /* ignore relay errors */ }
  }, [processEvent, stopPolling]);

  const generateConnectionUri = useCallback(async () => {
    stopPolling();
    connectedRef.current = false;
    pendingGpkIdRef.current = null;

    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const secretBytes = generateSecretKey();
    const pubkey = getPublicKey(secretBytes);
    clientSecretKey.current = secretBytes;
    clientPubkey.current = pubkey;

    const secret = toHex(crypto.getRandomValues(new Uint8Array(16)));
    sessionSecret.current = secret;

    const params = new URLSearchParams();
    NIP46_RELAYS.forEach(r => params.append('relay', r));
    params.append('secret', secret);
    params.append('name', 'Digital Card');
    params.append('url', window.location.origin);

    const uri = `nostrconnect://${pubkey}?${params.toString()}`;
    listenStartedAt.current = Math.floor(Date.now() / 1000);

    setState({ uri, isWaiting: true, connected: false, remotePubkey: null });

    // Immediate poll + interval
    pollOnce();
    pollIntervalRef.current = setInterval(pollOnce, POLL_INTERVAL_MS);
  }, [stopPolling, pollOnce]);

  const reset = useCallback(() => {
    stopPolling();
    connectedRef.current = false;
    pendingGpkIdRef.current = null;
    clientSecretKey.current = null;
    clientPubkey.current = null;
    setState({ uri: null, isWaiting: false, connected: false, remotePubkey: null });
  }, [stopPolling]);

  // Poll immediately when user returns from signer app
  useEffect(() => {
    const handle = () => {
      if (document.visibilityState === 'visible' && clientPubkey.current && !connectedRef.current) {
        pollOnce();
      }
    };
    document.addEventListener('visibilitychange', handle);
    window.addEventListener('focus', handle);
    return () => {
      document.removeEventListener('visibilitychange', handle);
      window.removeEventListener('focus', handle);
    };
  }, [pollOnce]);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  return {
    uri: state.uri,
    isWaiting: state.isWaiting,
    connected: state.connected,
    remotePubkey: state.remotePubkey,
    generateConnectionUri,
    reset,
  };
}
