import { describe, expect, it } from 'vitest';
import { listNumericLiterals, valueOfLiteral } from './literals';

const texts = (source: string): string[] => listNumericLiterals(source).map((literal) => literal.text);

describe('listNumericLiterals', () => {
  it('finds whole numbers, fractions, hex, exponents and BigInts, with the line each is on', () => {
    const source = ['const a = 3;', 'const b = 0.5 + 0xff;', 'const c = 1e3 * 10n;', 'const d = 1_000;'].join('\n');
    expect(listNumericLiterals(source)).toEqual([
      { text: '3', line: 1 },
      { text: '0.5', line: 2 },
      { text: '0xff', line: 2 },
      { text: '1e3', line: 3 },
      { text: '10n', line: 3 },
      { text: '1_000', line: 4 },
    ]);
  });

  it('skips comments and the text of strings', () => {
    const source = [
      '// 31 by 17 tiles',
      '/* 992 by',
      '   544 */',
      "const label = 'wave 3 of 3';",
      'const other = "4 gates";',
      'const text = `tier 5`;',
      'const seven = 7;',
    ].join('\n');
    expect(listNumericLiterals(source)).toEqual([{ text: '7', line: 7 }]);
  });

  it('does not skip code inside a template string', () => {
    expect(texts('const text = `kid${index % 8}_${`n${9}`} of 12`;')).toEqual(['8', '9']);
  });

  it('does not take the digits in a name for a number', () => {
    expect(texts('const kid0 = BOOST_TIER_1_PERCENT + tier2 + $3 + point.x1;')).toEqual([]);
  });

  it('finds a number used as a list place or a type', () => {
    expect(texts('type Tier = 1 | 2 | 3; const first = tiles[4];')).toEqual(['1', '2', '3', '4']);
  });
});

describe('valueOfLiteral', () => {
  it('reads every way of writing a number', () => {
    expect(['2', '2.0', '0x2', '2n', '1_0', '1e1'].map(valueOfLiteral)).toEqual([2, 2, 2, 2, 10, 10]);
  });
});
