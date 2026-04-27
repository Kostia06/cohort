import { detectChain } from './chains';
import type { Store } from './types';

export interface StoresInput {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface StoresDeps {
  kv: KVNamespace;
  fetch: typeof fetch;
  placesApiKey: string;
}

const CACHE_TTL_SEC = 7 * 24 * 60 * 60;

export async function findNearbyStores(input: StoresInput, deps: StoresDeps): Promise<Store[]> {
  const cacheKey = cacheKeyFor(input);
  const cached = await deps.kv.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached) as Store[]; } catch { /* fall through */ }
  }

  const url = 'https://places.googleapis.com/v1/places:searchNearby';
  const body = {
    includedTypes: ['grocery_store', 'supermarket'],
    locationRestriction: {
      circle: { center: { latitude: input.lat, longitude: input.lng }, radius: input.radiusM }
    },
    maxResultCount: 15
  };
  const resp = await deps.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': deps.placesApiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    throw new Error(`places api ${resp.status}`);
  }
  const data = await resp.json() as {
    places?: Array<{
      id: string;
      displayName?: { text: string };
      location: { latitude: number; longitude: number };
      formattedAddress?: string;
    }>;
  };
  const stores: Store[] = (data.places ?? []).map((p) => ({
    place_id: p.id,
    name: p.displayName?.text ?? 'Unknown',
    lat: p.location.latitude,
    lng: p.location.longitude,
    address: p.formattedAddress ?? '',
    chain: detectChain(p.displayName?.text ?? '')
  }));
  await deps.kv.put(cacheKey, JSON.stringify(stores), { expirationTtl: CACHE_TTL_SEC });
  return stores;
}

function cacheKeyFor(input: StoresInput): string {
  return `stores:${input.lat.toFixed(2)}:${input.lng.toFixed(2)}:${input.radiusM}`;
}
