import { describe, expect, it } from 'vitest';
import { detectChain } from '../../../services/grocery/src/chains';

describe('detectChain', () => {
  it.each([
    ['Real Canadian Superstore', 'loblaw'],
    ['No Frills', 'loblaw'],
    ['Safeway', 'sobeys'],
    ['Sobeys', 'sobeys'],
    ['Save-On-Foods', 'saveon'],
    ['Save On Foods', 'saveon'],
    ['Calgary Co-op', 'calgary_coop'],
    ['Co-op Grocery', 'calgary_coop'],
    ['Costco Wholesale', 'costco'],
    ['Walmart Supercenter', 'walmart'],
    ['Some Mom and Pop', null]
  ])('detects %s as %s', (name, expected) => {
    expect(detectChain(name)).toBe(expected);
  });
});
