export interface Store {
  place_id: string;
  name: string;
  lat: number;
  lng: number;
  address: string;
  chain: string | null;
}

export interface Product {
  name: string;
  brand?: string;
  upc?: string;
  size: string;
  category: string;
  per_100g_kcal?: number;
  per_100g_protein_g?: number;
  per_100g_carbs_g?: number;
  per_100g_fat_g?: number;
  source: 'open_food_facts' | 'usda';
  source_id: string;
}

export interface PriceInfo {
  amount: number;
  currency: string;
  source: 'community' | 'estimate' | 'unknown';
  as_of?: number;
}

export interface ProductMatch {
  product: Product;
  store: Store;
  price: PriceInfo;
}

export interface SearchInput {
  items: string[];
  lat: number;
  lng: number;
  radius_m?: number;
  region?: string;
  dietary_filters?: {
    pattern?: 'omnivore' | 'vegetarian' | 'vegan' | 'pescatarian' | 'keto';
    allergies?: string[];
    dislikes?: string[];
  };
}

export interface SearchOutput {
  results: Array<{
    query: string;
    matches: ProductMatch[];
  }>;
}
